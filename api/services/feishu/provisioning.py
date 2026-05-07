# -*- coding: utf-8 -*-
"""首次绑定 / 手动重建时的「自动开通」编排。

调用入口：
  - `provision_user(user_id, force_recreate=False)`
    OAuth 回调成功后 / 用户点「重建」时调用。
    幂等：已存在的资源会跳过；force_recreate=True 时无视已有字段重新建。

每个阶段（建群 / 建表 / 分享 / ...）独立 try-catch，部分失败不会回滚 OAuth token，
但会把已成功的资源 ID 落库。前端「重建」按钮可以补做剩余步骤。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .. import auth_service, monitor_db
from . import chat as chat_api
from . import bitable as bitable_api
from .client import FeishuApiError

logger = logging.getLogger(__name__)


class ProvisionResult(dict):
    """便于调用方判断哪些步骤成功。"""


async def _read_admin_open_id() -> str:
    return (await monitor_db.get_setting("feishu_admin_open_id", "")).strip()


async def _build_member_list(user: Dict[str, Any]) -> List[str]:
    """要拉进用户专属群的 open_id 列表（不含机器人，机器人创群时自动是成员）。

    - 总是包含用户自己
    - 如果有 admin_open_id 且不等于用户自己，再拉 admin
    """
    members: List[str] = []
    user_open = (user.get("feishu_open_id") or "").strip()
    if user_open:
        members.append(user_open)
    admin_open = await _read_admin_open_id()
    if admin_open and admin_open != user_open:
        members.append(admin_open)
    return members


# ── 各步骤实现 ──────────────────────────────────────────────────────────────

async def _ensure_chat(user: Dict[str, Any], force: bool) -> Optional[str]:
    """没群就建，已有就直接返回。返回 chat_id 或 None（建失败）。

    群名约定：「Pulse · {username 或 email}」。
    """
    chat_id = (user.get("feishu_chat_id") or "").strip()
    if chat_id and not force:
        return chat_id

    members = await _build_member_list(user)
    label = user.get("username") or user.get("email") or f"uid{user['id']}"
    name = f"Pulse · {label}"
    description = "Pulse 自动建群：监控告警 / 热门内容 / 商品图历史"

    try:
        result = await chat_api.create_chat(
            name=name,
            description=description,
            user_open_ids=members,
        )
    except FeishuApiError as e:
        logger.exception(f"[provision][chat] user={user['id']} create failed: {e}")
        raise

    chat_id = (result.get("chat_id") or "").strip()
    if not chat_id:
        raise FeishuApiError(-1, f"创建群失败（响应缺少 chat_id）：{result}")

    auth_service.update_user_feishu(user["id"], feishu_chat_id=chat_id)

    # 发一条欢迎消息，验证机器人能正常说话
    try:
        await chat_api.send_text(
            chat_id,
            f"🎉 你好 {user.get('feishu_name') or label}！\n"
            f"这是 Pulse 自动建的专属群，后续监控告警 / 热门内容速递 / 商品图同步通知都会推送到这里。",
        )
    except FeishuApiError as e:
        logger.warning(f"[provision][chat] welcome msg failed (non-fatal): {e}")

    return chat_id


async def _ensure_admin_in_existing_chat(user: Dict[str, Any]) -> bool:
    """admin 后绑定时，把 admin 补加到此前已建的群。返回是否做了补加。"""
    chat_id = (user.get("feishu_chat_id") or "").strip()
    if not chat_id:
        return False
    admin_open = await _read_admin_open_id()
    if not admin_open:
        return False
    user_open = (user.get("feishu_open_id") or "").strip()
    if admin_open == user_open:
        return False
    try:
        await chat_api.add_chat_members(chat_id, [admin_open], succeed_type=1)
        return True
    except FeishuApiError as e:
        logger.warning(f"[provision][chat] add admin to {chat_id} failed: {e}")
        return False


async def _ensure_bitable(user: Dict[str, Any], force: bool) -> Dict[str, str]:
    """没多维表格就建（含 image / trending 两个 table），已有就直接返回。

    返回 {"app_token": ..., "image_table_id": ..., "trending_table_id": ...}。
    image_table_id / trending_table_id 是从 user 表读已有值，缺失则现场建。
    """
    app_token = (user.get("feishu_bitable_app_token") or "").strip()
    image_id = (user.get("feishu_bitable_image_table_id") or "").strip()
    trending_id = (user.get("feishu_bitable_trending_table_id") or "").strip()

    folder_token = (await monitor_db.get_setting("feishu_bitable_root_folder_token", "")).strip()

    # 1. 创建 app（如果没有 app_token）
    if not app_token or force:
        label = user.get("username") or user.get("email") or f"uid{user['id']}"
        app_name = f"Pulse · {label} · 数据中心"
        app = await bitable_api.create_app(app_name, folder_token=folder_token)
        app_token = app.get("app_token") or ""
        if not app_token:
            raise FeishuApiError(-1, f"创建多维表格失败：{app}")
        # 新建 app 时之前的 table_id 都失效
        image_id = ""
        trending_id = ""
        auth_service.update_user_feishu(
            user["id"],
            feishu_bitable_app_token=app_token,
            feishu_bitable_image_table_id="",
            feishu_bitable_trending_table_id="",
        )

    # 2. 建 image table（如果还没有）
    if not image_id:
        try:
            tbl = await bitable_api.create_table(
                app_token, "商品图历史",
                fields=bitable_api.IMAGE_TABLE_FIELDS,
            )
            image_id = tbl.get("table_id") or ""
            if image_id:
                auth_service.update_user_feishu(
                    user["id"], feishu_bitable_image_table_id=image_id
                )
        except FeishuApiError as e:
            logger.warning(f"[provision][bitable] create image table failed: {e}")

    # 3. 建 trending table（如果还没有）
    if not trending_id:
        try:
            tbl = await bitable_api.create_table(
                app_token, "热门内容",
                fields=bitable_api.TRENDING_TABLE_FIELDS,
            )
            trending_id = tbl.get("table_id") or ""
            if trending_id:
                auth_service.update_user_feishu(
                    user["id"], feishu_bitable_trending_table_id=trending_id
                )
        except FeishuApiError as e:
            logger.warning(f"[provision][bitable] create trending table failed: {e}")

    # 4. 分享给用户（每次 provision 都尝试一次，已是协作者会被去重）
    user_open = (user.get("feishu_open_id") or "").strip()
    if user_open:
        try:
            await bitable_api.share_app_with_user(app_token, user_open, perm="edit")
        except FeishuApiError as e:
            logger.warning(f"[provision][bitable] share to user failed: {e}")

    # 5. 同时把 admin 加成协作者（非 admin 自己时）
    admin_open = await _read_admin_open_id()
    if admin_open and admin_open != user_open:
        try:
            await bitable_api.share_app_with_user(app_token, admin_open, perm="full_access")
        except FeishuApiError as e:
            logger.warning(f"[provision][bitable] share to admin failed: {e}")

    return {
        "app_token": app_token,
        "image_table_id": image_id,
        "trending_table_id": trending_id,
    }


# ── 主入口 ──────────────────────────────────────────────────────────────────

async def provision_user(user_id: int, *, force_recreate: bool = False) -> ProvisionResult:
    """OAuth 回调成功 / 用户点「重建」时调用。

    Phase 2 范围：建群（含拉用户 + admin）。
    Phase 3 会在此基础上扩展：建多维表格 + 两个 table + 分享给用户。
    """
    user = auth_service.get_user_by_id(user_id)
    if not user:
        raise FeishuApiError(-1, f"user {user_id} not found")
    if not user.get("feishu_open_id"):
        raise FeishuApiError(-1, "用户尚未完成 OAuth 绑定")

    result = ProvisionResult()

    # 1. 建群（或确认已有群）
    try:
        chat_id = await _ensure_chat(user, force=force_recreate)
        result["chat_id"] = chat_id
    except FeishuApiError as e:
        result["chat_error"] = str(e)
        # 群建不出来就不往下走（建表也没意义）
        return result

    # 1b. 兜底：如果用户已有群但 admin 是后绑定的，把 admin 补进去
    if await _ensure_admin_in_existing_chat(auth_service.get_user_by_id(user_id) or user):
        result["admin_added_to_chat"] = True

    # 2. 建多维表格 + 两个 table + 分享给用户 / admin
    try:
        # 重新读 user 拿最新字段（chat 步骤可能更新过）
        latest = auth_service.get_user_by_id(user_id) or user
        bitable_info = await _ensure_bitable(latest, force=force_recreate)
        result.update(bitable_info)
    except FeishuApiError as e:
        logger.exception(f"[provision][bitable] user={user_id} failed: {e}")
        result["bitable_error"] = str(e)

    return result
