# -*- coding: utf-8 -*-
"""运维健康相关：webhook 测试、cookie 健康度概览。

路由前缀 /monitor/health。
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..services import monitor_db, notifier
from .auth import get_current_user

router = APIRouter(prefix="/monitor/health", tags=["Health"])


# ── 请求模型 ───────────────────────────────────────────────────────────────

class TestWebhookRequest(BaseModel):
    channel: str  # "wecom" 或 "feishu"
    url: str
    text: Optional[str] = "Pulse 测试通知 ✅ 收到此消息说明 webhook 配置正确。"


# ── /test-webhook：测试任意 URL ────────────────────────────────────────────

@router.post("/test-webhook")
async def test_webhook(
    body: TestWebhookRequest,
    _user=Depends(get_current_user),
):
    """测试单个 webhook URL 是否可用。

    失败时不抛异常，统一返回 {ok, channel, message}，便于前端给出友好提示。
    """
    channel = (body.channel or "").lower().strip()
    url = (body.url or "").strip()

    if not url:
        return {"ok": False, "channel": channel, "message": "Webhook URL 不能为空"}

    if channel not in ("wecom", "feishu"):
        return {
            "ok": False,
            "channel": channel,
            "message": f"未知渠道 '{channel}'，仅支持 wecom / feishu",
        }

    try:
        if channel == "wecom":
            ok = await notifier.send_wecom(url, body.text or "")
        else:
            ok = await notifier.send_feishu(
                url, "Pulse Webhook 测试", body.text or "", "blue"
            )
    except Exception as e:  # noqa: BLE001 — 兜底，避免任何异常打到前端
        return {
            "ok": False,
            "channel": channel,
            "message": f"请求异常：{e}",
        }

    if ok:
        return {
            "ok": True,
            "channel": channel,
            "message": "测试消息已发送，请到群里确认是否收到。",
        }
    return {
        "ok": False,
        "channel": channel,
        "message": "调用 webhook 失败，请检查 URL 是否正确、机器人是否启用。",
    }


# ── /test-current-webhooks：测试已保存的两个 webhook ───────────────────────

@router.post("/test-current-webhooks")
async def test_current_webhooks(_user=Depends(get_current_user)):
    """读取当前租户已保存的 webhook，分别测试企业微信和飞书。"""
    settings = await monitor_db.get_all_settings()
    wecom_url = (settings.get("webhook_url") or "").strip()
    feishu_url = (settings.get("feishu_webhook_url") or "").strip()

    text = "Pulse 测试通知 ✅ 收到此消息说明 webhook 配置正确。"

    async def _try_wecom() -> bool:
        if not wecom_url:
            return False
        try:
            return await notifier.send_wecom(wecom_url, text)
        except Exception:
            return False

    async def _try_feishu() -> bool:
        if not feishu_url:
            return False
        try:
            return await notifier.send_feishu(
                feishu_url, "Pulse Webhook 测试", text, "blue"
            )
        except Exception:
            return False

    return {
        "wecom": await _try_wecom(),
        "feishu": await _try_feishu(),
        "wecom_configured": bool(wecom_url),
        "feishu_configured": bool(feishu_url),
    }
