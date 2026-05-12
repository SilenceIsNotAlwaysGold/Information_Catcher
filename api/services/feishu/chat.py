# -*- coding: utf-8 -*-
"""飞书群聊（im/v1/chats）+ 消息（im/v1/messages）封装。

文档：
  https://open.feishu.cn/document/server-docs/group/chat/create
  https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from .client import FeishuApiError, get, post

logger = logging.getLogger(__name__)


# ── 群创建 ──────────────────────────────────────────────────────────────────

async def create_chat(
    *,
    name: str,
    description: str = "",
    user_open_ids: Optional[List[str]] = None,
    chat_mode: str = "group",
    chat_type: str = "private",
) -> Dict[str, Any]:
    """创建群（用 tenant_access_token，机器人自动作为创建者 + 群主）。

    成员：user_open_ids 是要拉进群的用户 open_id 列表（应用机器人本身会自动是成员）。
    返回 dict 含 chat_id / name / chat_mode / external 等。
    """
    payload: Dict[str, Any] = {
        "name": name,
        "description": description,
        "chat_mode": chat_mode,        # group=群组
        "chat_type": chat_type,        # private=内部
        # 谁能加人 / 改群信息：默认 all_members 让 admin 也能管
        "edit_permission": "all_members",
        "membership_approval": "no_approval_required",
    }
    if user_open_ids:
        payload["user_id_list"] = list(dict.fromkeys(user_open_ids))  # 去重保序

    # uuid 用群名 + 时间戳的 hash 防止重复触发产生多个群（飞书会 dedupe 同 uuid 请求）
    import hashlib, time as _t
    payload["uuid"] = hashlib.md5(f"{name}|{_t.time()}".encode()).hexdigest()

    data = await post(
        "/im/v1/chats",
        json=payload,
        params={"user_id_type": "open_id"},
    )
    return data.get("data") or {}


async def add_chat_members(
    chat_id: str,
    user_open_ids: List[str],
    *,
    succeed_type: int = 0,
) -> Dict[str, Any]:
    """把 open_id 列表批量加进群。

    succeed_type=0：所有 id 都 OK 才算成功；=1：能拉的拉，拉不动的跳过（推荐）。
    """
    if not user_open_ids:
        return {}
    data = await post(
        f"/im/v1/chats/{chat_id}/members",
        json={"id_list": list(dict.fromkeys(user_open_ids))},
        params={"member_id_type": "open_id", "succeed_type": str(succeed_type)},
    )
    return data.get("data") or {}


async def get_chat_info(chat_id: str) -> Dict[str, Any]:
    """读群基本信息，重建按钮上展示用。"""
    data = await get(f"/im/v1/chats/{chat_id}")
    return data.get("data") or {}


async def list_chat_members(chat_id: str) -> List[str]:
    """返回当前群里所有成员的 open_id 列表（批量补成员前要先拿）。"""
    data = await get(
        f"/im/v1/chats/{chat_id}/members",
        params={"member_id_type": "open_id", "page_size": "100"},
    )
    items = (data.get("data") or {}).get("items") or []
    return [m.get("member_id", "") for m in items if m.get("member_id")]


# ── 消息发送 ────────────────────────────────────────────────────────────────

async def send_text(chat_id: str, text: str) -> Dict[str, Any]:
    """简单文本消息（应急 / 调试用）。"""
    data = await post(
        "/im/v1/messages",
        json={
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        },
        params={"receive_id_type": "chat_id"},
    )
    return data.get("data") or {}


async def send_card(chat_id: str, card: Dict[str, Any]) -> Dict[str, Any]:
    """飞书卡片消息（与 webhook 兜底用同一个卡片 schema）。"""
    data = await post(
        "/im/v1/messages",
        json={
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        },
        params={"receive_id_type": "chat_id"},
    )
    return data.get("data") or {}


def build_alert_card(
    title: str,
    content: str,
    template: str = "red",
) -> Dict[str, Any]:
    """与 notifier.send_feishu webhook 用同一种卡片结构，便于双路径行为一致。

    template：red / orange / blue / green / wathet（飞书卡片 header.template 配色）。
    """
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": template,
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": content}}
        ],
    }
