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

    飞书侧支持双通道：
      - 应用机器人 chat_id（OAuth 绑定后，富卡片，可 @人）— 优先
      - 群机器人 webhook URL（兼容未绑定的老用户/群组级配置）— 兜底
    两者择优：如配了 chat_id 就走 chat，否则回退 webhook；都没配则跳过。
    """
    tasks = []
    if wecom_url:
        tasks.append(send_wecom(wecom_url, f"## {title}\n{md_content}"))
    if feishu_chat_id:
        tasks.append(send_feishu_chat(feishu_chat_id, title, md_content, template))
    elif feishu_url:
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

def _fmt_delta(n: int) -> str:
    """+123 / -5 / 0；正数加 + 号。"""
    return f"+{n}" if n > 0 else (str(n) if n != 0 else "0")


async def notify_daily_report(
    wecom_url: str,
    feishu_url: str,
    rows: List[Dict],
    group_name: str = "",
    prefix: str = "",
    feishu_chat_id: str = "",
    summary: Optional[Dict] = None,
) -> None:
    """每日日报：今日增量 + 涨幅排行 + 汇总。

    rows 每项（已由 scheduler 算好 24h delta，并按 liked_delta 降序排）：
      { title, note_id, xsec_token, platform,
        liked_now, collected_now, comment_now,
        liked_delta, collected_delta, comment_delta, is_new }
    summary（可选）：
      { posts_total, new_today, liked_delta, collected_delta, comment_delta }
    """
    if not rows and not (summary and summary.get("new_today")):
        return
    n_total = (summary or {}).get("posts_total", len(rows))
    title_label = (
        f"每日数据日报｜{group_name}（{n_total} 条监控）"
        if group_name else f"每日数据日报（{n_total} 条监控）"
    )
    lines = []
    if prefix:
        lines.append(prefix.rstrip())
    lines.append(f"**{title_label}**")
    lines.append("")

    # 汇总行
    if summary:
        s = summary
        lines.append(
            f"📊 **今日合计**：点赞 {_fmt_delta(s.get('liked_delta', 0))} ｜ "
            f"收藏 {_fmt_delta(s.get('collected_delta', 0))} ｜ "
            f"评论 {_fmt_delta(s.get('comment_delta', 0))}"
            + (f" ｜ 新增监控 {s['new_today']} 条" if s.get("new_today") else "")
        )
        lines.append("")

    # 涨幅排行（按 liked_delta 降序，取前 15；只列有正增量的）
    ranked = [r for r in rows if (r.get("liked_delta", 0) or 0) > 0][:15]
    if ranked:
        lines.append("🔥 **涨幅 TOP**（按点赞增量）")
        for i, r in enumerate(ranked, 1):
            title = (r.get("title") or r.get("note_id", ""))[:28]
            ld, cd, md = r.get("liked_delta", 0), r.get("collected_delta", 0), r.get("comment_delta", 0)
            ln = r.get("liked_now", 0)
            link = _note_link(r.get("note_id", ""), r.get("xsec_token", "")) if r.get("note_id") else ""
            head = f"[{title}]({link})" if link else title
            lines.append(
                f"{i}. {head}  点赞 **{_fmt_delta(ld)}**（{ln}）"
                f" ｜ 收藏 {_fmt_delta(cd)} ｜ 评论 {_fmt_delta(md)}"
            )
    else:
        lines.append("（今日所有监控帖子都没有点赞增长）")

    # 今日新增的监控帖（如果有）
    new_rows = [r for r in rows if r.get("is_new")]
    if new_rows:
        lines.append("")
        lines.append(f"🆕 **今日新增监控**（{len(new_rows)} 条）")
        for r in new_rows[:8]:
            title = (r.get("title") or r.get("note_id", ""))[:28]
            link = _note_link(r.get("note_id", ""), r.get("xsec_token", "")) if r.get("note_id") else ""
            lines.append(f"· {f'[{title}]({link})' if link else title}")

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


# ── Creator new posts alert ──────────────────────────────────────────────────

async def notify_creator_new_posts(
    wecom_url: str,
    feishu_url: str,
    creator_name: str,
    platform: str,
    posts: List[Dict],
    feishu_chat_id: str = "",
) -> None:
    """关注的博主发了新内容，给用户的飞书/企微推送一条。

    posts 项需含 post_id / title / url / xsec_token（XHS）。
    """
    if not posts:
        return
    label = {"xhs": "小红书", "douyin": "抖音", "mp": "公众号"}.get(platform, platform)
    title_line = f"**{creator_name or '博主'}** ({label}) 发布了 {len(posts)} 篇新内容"
    lines = [title_line, ""]
    for i, p in enumerate(posts[:5], 1):
        t = (p.get("title") or p.get("post_id", ""))[:40]
        url = p.get("url") or _note_link(
            p.get("post_id", ""), p.get("xsec_token", ""),
        )
        lines.append(f"{i}. [{t}]({url})")
    if len(posts) > 5:
        lines.append(f"\n（仅展示前 5 条，共 {len(posts)} 条）")
    await _push(
        wecom_url, feishu_url, "博主发新内容",
        "\n".join(lines), template="green",
        feishu_chat_id=feishu_chat_id,
    )


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


# ── 公众号凭证过期提醒（mp uin/key 30 分钟过期，限频 24h）──────────────────

async def notify_mp_auth_expired(
    wecom_url: str,
    feishu_url: str,
    feishu_chat_id: str = "",
    ret_code: object = None,
) -> None:
    """公众号阅读数 / 在看数 / 打赏数依赖 30 分钟一过期的 uin/key，
    fetcher 检测到失效就推这条提醒，让用户去刷一下。"""
    body = (
        "你的公众号客户端凭证（uin / key / pass_ticket）已过期，"
        "导致阅读数 / 在看数 / 打赏数暂时无法刷新。\n\n"
        "**最快的恢复方式**：在装了 Pulse CookieBridge 浏览器扩展的 Chrome 里，"
        "随便打开一篇公众号文章（手机分享出来的链接也行）—— 扩展会自动从 URL 抓"
        "新凭证推到 Pulse，30 秒内监控自动恢复。\n\n"
        "如果没装扩展，也可以去 Pulse 的「公众号 → 凭证设置」手动粘贴。"
    )
    if ret_code is not None:
        body += f"\n\n（接口返回码 ret={ret_code}，仅作技术排查参考）"
    await _push(
        wecom_url, feishu_url,
        "⚠️ 公众号凭证已过期",
        body,
        template="red",
        feishu_chat_id=feishu_chat_id,
    )

