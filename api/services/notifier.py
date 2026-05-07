import asyncio
import logging
import httpx
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)


# ── WeChat Work ──────────────────────────────────────────────────────────────

async def send_wecom(webhook_url: str, content: str) -> bool:
    if not webhook_url:
        return False
    payload = {"msgtype": "markdown", "markdown": {"content": content}}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(webhook_url, json=payload)
            return resp.json().get("errcode") == 0
    except Exception:
        return False


# ── Feishu ───────────────────────────────────────────────────────────────────

async def send_feishu(webhook_url: str, title: str, content: str, template: str = "red") -> bool:
    if not webhook_url:
        return False
    payload = {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": template,
            },
            "elements": [{"tag": "markdown", "content": content}],
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(webhook_url, json=payload)
            data = resp.json()
            return data.get("StatusCode") == 0 or data.get("code") == 0
    except Exception:
        return False


async def send_feishu_chat(chat_id: str, title: str, content: str, template: str = "red") -> bool:
    """走应用机器人的 im/v1/messages，给指定群发飞书卡片。

    比 webhook 路径多个好处：可 @人 / 卡片交互按钮 / 撤回。当前先用同样的卡片结构
    保证视觉一致。
    """
    if not chat_id:
        return False
    try:
        from .feishu import chat as chat_api
        card = chat_api.build_alert_card(title, content, template=template)
        await chat_api.send_card(chat_id, card)
        return True
    except Exception as e:
        logger.warning(f"[notifier] send_feishu_chat failed (chat_id={chat_id}): {e}")
        return False


async def _push(
    wecom_url: str,
    feishu_url: str,
    title: str,
    md_content: str,
    template: str = "red",
    feishu_chat_id: str = "",
):
    """统一推送。

    飞书路径优先级：feishu_chat_id（应用机器人）→ feishu_url（webhook 兜底）。
    两者只走其一，避免双重通知。chat_id 发送失败时自动回落 webhook。
    """
    tasks = []
    if wecom_url:
        tasks.append(send_wecom(wecom_url, f"## {title}\n{md_content}"))

    feishu_sent = False
    if feishu_chat_id:
        feishu_sent = await send_feishu_chat(feishu_chat_id, title, md_content, template)
    if not feishu_sent and feishu_url:
        tasks.append(send_feishu(feishu_url, title, md_content, template))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _note_link(note_id: str, xsec_token: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token={xsec_token}"


# ── Unified alert ────────────────────────────────────────────────────────────

async def notify_metric(
    wecom_url: str,
    feishu_url: str,
    title: str,
    note_id: str,
    xsec_token: str,
    alert_name: str,
    detail_text: str,
    feishu_chat_id: str = "",
) -> None:
    content = f"{detail_text}\n\n[查看帖子]({_note_link(note_id, xsec_token)})"
    await _push(wecom_url, feishu_url, f"{alert_name} · {title or note_id}", content,
                feishu_chat_id=feishu_chat_id)


# ── Trending alert ───────────────────────────────────────────────────────────

async def notify_trending(
    wecom_url: str,
    feishu_url: str,
    keyword: str,
    posts: List[Dict],
    feishu_chat_id: str = "",
) -> None:
    lines = [f"**关键词「{keyword}」** 发现 {len(posts)} 篇热门新内容\n"]
    for i, p in enumerate(posts[:5], 1):
        title = (p.get("title") or p.get("note_id", ""))[:40]
        liked = p.get("liked_count", 0)
        collected = p.get("collected_count", 0)
        link = _note_link(p["note_id"], p.get("xsec_token", ""))
        lines.append(f"{i}. [{title}]({link})  点赞 {liked} | 收藏 {collected}")
    content = "\n".join(lines)
    await _push(wecom_url, feishu_url, "热门内容速报", content, template="orange",
                feishu_chat_id=feishu_chat_id)


# ── Daily report ─────────────────────────────────────────────────────────────

async def notify_daily_report(
    wecom_url: str,
    feishu_url: str,
    rows: List[Dict],
    group_name: str = "",
    prefix: str = "",
    feishu_chat_id: str = "",
) -> None:
    if not rows:
        return
    title_label = (
        f"每日数据日报｜{group_name}（共 {len(rows)} 条）"
        if group_name else f"每日数据日报（共 {len(rows)} 条）"
    )
    header = f"{prefix}**{title_label}**\n" if prefix else f"**{title_label}**\n"
    lines = [header]
    for i, r in enumerate(rows[:20], 1):
        title = (r.get("title") or r.get("note_id", ""))[:30]
        liked = r.get("liked_count", 0)
        collected = r.get("collected_count", 0)
        comment = r.get("comment_count", 0)
        lines.append(f"{i}. **{title}**  点赞 {liked} | 收藏 {collected} | 评论 {comment}")
    if len(rows) > 20:
        lines.append(f"\n（仅展示前 20 条，共 {len(rows)} 条）")
    content = "\n".join(lines)
    await _push(wecom_url, feishu_url, title_label, content, template="blue",
                feishu_chat_id=feishu_chat_id)


# ── New comments on monitored posts ──────────────────────────────────────────

async def notify_new_comments(
    wecom_url: str,
    feishu_url: str,
    note_title: str,
    note_id: str,
    xsec_token: str,
    new_comments: List[Dict],
    feishu_chat_id: str = "",
) -> None:
    if not new_comments:
        return
    lines = [f"**帖子「{note_title or note_id}」** 收到 {len(new_comments)} 条新评论\n"]
    for c in new_comments[:8]:
        user = c.get("user_name", "匿名")
        content = (c.get("content", ""))[:100]
        lines.append(f"**{user}**：{content}")
    link = _note_link(note_id, xsec_token)
    lines.append(f"\n[查看帖子]({link})")
    await _push(wecom_url, feishu_url, "新评论通知", "\n".join(lines),
                feishu_chat_id=feishu_chat_id)


# ── Cookie health alert ──────────────────────────────────────────────────────

async def notify_cookie_expired(
    wecom_url: str,
    feishu_url: str,
    account_names: List[str],
    feishu_chat_id: str = "",
) -> None:
    if not account_names:
        return
    lines = [f"**{len(account_names)} 个账号 Cookie 已失效**\n"]
    for name in account_names:
        lines.append(f"- {name}")
    lines.append("\n请前往「监控设置 → 账号管理」重新扫码登录，否则相关抓取功能（监控、热门）将无法工作。")
    await _push(wecom_url, feishu_url, "⚠️ 账号 Cookie 失效", "\n".join(lines), template="red",
                feishu_chat_id=feishu_chat_id)

