import asyncio
import httpx
from typing import List, Dict


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


async def _push(wecom_url: str, feishu_url: str, title: str, md_content: str, template: str = "red"):
    tasks = []
    if wecom_url:
        tasks.append(send_wecom(wecom_url, f"## {title}\n{md_content}"))
    if feishu_url:
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
) -> None:
    content = f"{detail_text}\n\n[查看帖子]({_note_link(note_id, xsec_token)})"
    await _push(wecom_url, feishu_url, f"{alert_name} · {title or note_id}", content)


# ── Trending alert ───────────────────────────────────────────────────────────

async def notify_trending(
    wecom_url: str,
    feishu_url: str,
    keyword: str,
    posts: List[Dict],
) -> None:
    lines = [f"**关键词「{keyword}」** 发现 {len(posts)} 篇热门新内容\n"]
    for i, p in enumerate(posts[:5], 1):
        title = (p.get("title") or p.get("note_id", ""))[:40]
        liked = p.get("liked_count", 0)
        collected = p.get("collected_count", 0)
        link = _note_link(p["note_id"], p.get("xsec_token", ""))
        lines.append(f"{i}. [{title}]({link})  点赞 {liked} | 收藏 {collected}")
    content = "\n".join(lines)
    await _push(wecom_url, feishu_url, "热门内容速报", content, template="orange")


# ── Daily report ─────────────────────────────────────────────────────────────

async def notify_daily_report(
    wecom_url: str,
    feishu_url: str,
    rows: List[Dict],
    group_name: str = "",
    prefix: str = "",
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
    await _push(wecom_url, feishu_url, title_label, content, template="blue")


# ── New comments on monitored posts ──────────────────────────────────────────

async def notify_new_comments(
    wecom_url: str,
    feishu_url: str,
    note_title: str,
    note_id: str,
    xsec_token: str,
    new_comments: List[Dict],
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
    await _push(wecom_url, feishu_url, "新评论通知", "\n".join(lines))


# ── Cookie health alert ──────────────────────────────────────────────────────

async def notify_cookie_expired(
    wecom_url: str,
    feishu_url: str,
    account_names: List[str],
) -> None:
    if not account_names:
        return
    lines = [f"**{len(account_names)} 个账号 Cookie 已失效**\n"]
    for name in account_names:
        lines.append(f"- {name}")
    lines.append("\n请前往「监控设置 → 账号管理」重新扫码登录，否则相关抓取功能（监控、热门）将无法工作。")
    await _push(wecom_url, feishu_url, "⚠️ 账号 Cookie 失效", "\n".join(lines), template="red")

