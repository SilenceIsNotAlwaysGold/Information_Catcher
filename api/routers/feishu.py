# -*- coding: utf-8 -*-
"""飞书绑定路由（Phase 1：OAuth 网页授权 + 状态展示）。

端点：
  GET  /feishu/oauth/authorize  生成飞书授权 URL（供前端 window.location 跳转）
  GET  /feishu/oauth/callback   飞书 302 回到这里，用 code 换 token 并落库
  GET  /feishu/status           当前用户的绑定状态
  POST /feishu/unbind           解绑（清空 feishu_* 字段，webhook 兜底保留）

后续 Phase 2/3 会在 callback 成功后自动建群 / 建多维表格。
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ..services import auth_service, monitor_db
from ..services.feishu import oauth as feishu_oauth
from ..services.feishu import provisioning as feishu_provisioning
from ..services.feishu.client import FeishuApiError
from .auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feishu", tags=["Feishu"])


# ── 工具：state 签名（防 CSRF + 携带 user_id） ──────────────────────────────

def _sign_state(user_id: int) -> str:
    """state 是 10 分钟过期的签名 token，承载 user_id。"""
    return auth_service.create_access_token(
        {"user_id": user_id, "purpose": "feishu_oauth"},
        expires_delta=timedelta(minutes=10),
    )


def _verify_state(state: str) -> Optional[int]:
    payload = auth_service.verify_token(state)
    if not payload or payload.get("purpose") != "feishu_oauth":
        return None
    try:
        return int(payload.get("user_id"))
    except (TypeError, ValueError):
        return None


# ── 端点 ────────────────────────────────────────────────────────────────────

@router.get("/oauth/authorize", summary="生成飞书 OAuth 授权 URL")
async def authorize(current_user: dict = Depends(get_current_user)) -> dict:
    redirect_uri = (await monitor_db.get_setting("feishu_oauth_redirect_uri", "")).strip()
    if not redirect_uri:
        raise HTTPException(
            status_code=400,
            detail="飞书 OAuth 回调地址未配置，请联系管理员在「系统设置」填写 feishu_oauth_redirect_uri",
        )
    try:
        state = _sign_state(current_user["id"])
        url = await feishu_oauth.build_authorize_url(redirect_uri, state)
    except FeishuApiError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"authorize_url": url}


@router.get("/oauth/callback", summary="飞书 OAuth 回调（飞书侧 302 跳来）")
async def callback(request: Request, code: str = "", state: str = "", error: str = ""):
    """飞书回调到这里。成功 / 失败都重定向回前端绑定页，URL 带 query 提示。

    前端在 /dashboard/monitor/settings 上根据 ?feishu=ok|error&msg=... 弹 toast。
    """
    # 前端落地页（绑定卡片在设置页）
    landing = "/dashboard/monitor/settings"

    if error:
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg={error}", status_code=302
        )
    if not code or not state:
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg=missing_code_or_state", status_code=302
        )

    user_id = _verify_state(state)
    if not user_id:
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg=invalid_state", status_code=302
        )

    user = auth_service.get_user_by_id(user_id)
    if not user:
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg=user_not_found", status_code=302
        )

    redirect_uri = (await monitor_db.get_setting("feishu_oauth_redirect_uri", "")).strip()
    if not redirect_uri:
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg=redirect_uri_missing", status_code=302
        )

    try:
        token_data = await feishu_oauth.exchange_code(code, redirect_uri)
        access_token = token_data["access_token"]
        refresh_token = token_data.get("refresh_token", "")
        expires_in = int(token_data.get("expires_in", 7200))
        open_id = token_data.get("open_id", "")
        # 拉一次用户信息拿姓名（若 token 已带 name 字段则直接用）
        name = ""
        try:
            info = await feishu_oauth.get_user_info(access_token)
            name = info.get("name") or info.get("en_name") or ""
            if not open_id:
                open_id = info.get("open_id") or ""
        except FeishuApiError as e:
            logger.warning(f"[feishu] get_user_info failed (continuing with open_id only): {e}")
    except FeishuApiError as e:
        logger.exception(f"[feishu] OAuth exchange failed: {e}")
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg={e.msg}", status_code=302
        )

    if not open_id:
        return RedirectResponse(
            url=f"{landing}?feishu=error&msg=no_open_id", status_code=302
        )

    auth_service.update_user_feishu(
        user_id,
        feishu_open_id=open_id,
        feishu_user_access_token=access_token,
        feishu_refresh_token=refresh_token,
        feishu_token_expires_at=feishu_oauth.calc_expires_at(expires_in),
        feishu_name=name,
        feishu_bound_at=__import__("datetime").datetime.utcnow().isoformat(),
    )

    # admin 绑定后把 open_id 缓存到全局 setting，供后续把 admin 拉进所有用户群
    if (user.get("role") or "user") == "admin":
        await monitor_db.set_setting("feishu_admin_open_id", open_id)
        logger.info(f"[feishu] admin {user['username']} bound, open_id cached to settings")

    # 自动开通：建群（Phase 2）+ 多维表格（Phase 3）。失败不会回滚 OAuth，
    # 只是部分资源缺失，前端「重建」按钮可补做。
    provision_msg = ""
    try:
        result = await feishu_provisioning.provision_user(user_id)
        if result.get("chat_error"):
            provision_msg = f"&provision_warn={result['chat_error']}"
        elif result.get("bitable_error"):
            provision_msg = f"&provision_warn={result['bitable_error']}"
    except FeishuApiError as e:
        logger.exception(f"[feishu] provision failed user={user_id}: {e}")
        provision_msg = f"&provision_warn={e.msg}"
    except Exception as e:
        logger.exception(f"[feishu] provision unexpected user={user_id}: {e}")
        provision_msg = f"&provision_warn=unexpected:{e}"

    return RedirectResponse(
        url=f"{landing}?feishu=ok{provision_msg}", status_code=302
    )


@router.get("/status", summary="当前用户的飞书绑定状态")
async def status(current_user: dict = Depends(get_current_user)) -> dict:
    """前端绑定卡片用这个端点判断是否已绑定 + 展示信息。

    敏感字段（access_token / refresh_token）不返回。
    """
    bound = bool(current_user.get("feishu_open_id"))
    return {
        "bound": bound,
        "open_id": current_user.get("feishu_open_id", ""),
        "name": current_user.get("feishu_name", ""),
        "chat_id": current_user.get("feishu_chat_id", ""),
        "bitable_app_token": current_user.get("feishu_bitable_app_token", ""),
        "image_table_id": current_user.get("feishu_bitable_image_table_id", ""),
        "trending_table_id": current_user.get("feishu_bitable_trending_table_id", ""),
        "bound_at": current_user.get("feishu_bound_at", ""),
        # 兜底 webhook（保留兼容）
        "webhook_url": current_user.get("feishu_webhook_url", ""),
        # 让前端能判断是否已配 OAuth 配置（authorize 才不会 400）
        "oauth_configured": bool((await monitor_db.get_setting("feishu_oauth_redirect_uri", "")).strip()),
        # 企业邀请链接：自建应用只允许本企业成员授权，外部用户需先扫码加入。
        # 前端在未绑定时把这个链接渲染成二维码引导用户扫码加入企业。
        "invite_url": (await monitor_db.get_setting("feishu_invite_url", "")).strip(),
    }


@router.post("/unbind", summary="解绑飞书（清空 OAuth + 群/表关联）")
async def unbind(current_user: dict = Depends(get_current_user)) -> dict:
    """解绑：仅清本地字段，不删远端的群/表（避免误伤已有数据）。"""
    auth_service.clear_user_feishu(current_user["id"])
    # admin 解绑时清掉全局 admin_open_id 缓存
    if (current_user.get("role") or "user") == "admin":
        await monitor_db.set_setting("feishu_admin_open_id", "")
    return {"ok": True}


@router.post("/reprovision", summary="重建群 / 多维表格（兜底，绑定时部分失败可手动补做）")
async def reprovision(
    force: bool = False,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """重新跑 provisioning。

    - force=False（默认）：跳过已成功的步骤（已有 chat_id 就不重建群），仅补做缺失部分
    - force=True：清空已有 chat_id / bitable_*（仅本地字段，不删远端），全量重建
    """
    if not (current_user.get("feishu_open_id") or "").strip():
        raise HTTPException(status_code=400, detail="尚未绑定飞书，无法重建")
    if force:
        auth_service.update_user_feishu(
            current_user["id"],
            feishu_chat_id="",
            feishu_bitable_app_token="",
            feishu_bitable_image_table_id="",
            feishu_bitable_trending_table_id="",
        )
    try:
        result = await feishu_provisioning.provision_user(
            current_user["id"], force_recreate=force
        )
    except FeishuApiError as e:
        raise HTTPException(status_code=502, detail=e.msg)
    return {"ok": True, **result}
