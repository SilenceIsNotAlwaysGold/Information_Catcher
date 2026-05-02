"""
XHS 平台实现：包装现有 monitor_fetcher（详情）和 trending_fetcher（搜索）。

为什么是 wrapper 而不是 import 重写：
  现有两个 fetcher 已经经过大量线上验证、风控调优、token 失效处理等。
  抽象层只负责调度，不重写底层抓取逻辑。
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse, parse_qs

from ..base import Platform
from ... import monitor_fetcher, trending_fetcher

logger = logging.getLogger(__name__)


class XHSPlatform(Platform):
    name = "xhs"
    label = "小红书"
    url_hints = ["xiaohongshu.com", "xhslink.com"]

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        link = (raw_url or "").strip()
        if not link:
            return None

        # 短链或非 xhs 域名（例如微信复制出来的纯 ID 串）走短链 resolver
        if "xhslink.com" in link or "xiaohongshu.com" not in link:
            info = await monitor_fetcher.resolve_short_link(link)
            if not info:
                return None
        else:
            parsed = urlparse(link)
            params = parse_qs(parsed.query)
            parts = parsed.path.strip("/").split("/")
            if len(parts) < 2 or parts[0] != "explore":
                return None
            info = {
                "note_id": parts[1],
                "xsec_token": params.get("xsec_token", [""])[0],
                # 强制 app_share，公开通道
                "xsec_source": "app_share",
                "note_url": link,
            }

        # 不管是哪种来源，xsec_source 都强制 app_share（实测稳定）
        info["xsec_source"] = "app_share"
        return {
            "platform": self.name,
            "post_id": info["note_id"],
            "url": info["note_url"],
            "xsec_token": info.get("xsec_token", ""),
            "xsec_source": info["xsec_source"],
        }

    async def fetch_detail(
        self, post: Dict[str, Any], account: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        return await monitor_fetcher.fetch_note_metrics(
            note_id=post.get("note_id") or post.get("post_id"),
            xsec_token=post.get("xsec_token", ""),
            xsec_source=post.get("xsec_source", "app_share"),
            cookie=post.get("account_cookie"),
            account=account,
        )

    async def search_trending(
        self, keyword: str, account: Dict[str, Any], min_likes: int = 0,
    ) -> List[Dict[str, Any]]:
        # 现有签名：(keyword, account, min_likes)
        return await trending_fetcher.search_trending_notes(keyword, account, min_likes)

    async def fetch_creator_posts(
        self, creator_url: str, account: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """抓 XHS 博主主页发布列表。

        URL 形如 https://www.xiaohongshu.com/user/profile/{user_id}（可带 ?xsec_token=...）。
        实现：用账号 cookie 在 Playwright 里加载主页，拦截 user_posted API。
        XHS 主页未登录会跳登录墙，必须带 cookie。
        """
        if not account or not account.get("cookie"):
            logger.warning("[xhs] creator追新 需要带 cookie 的账号")
            return []
        if (account.get("platform") or "xhs") != "xhs":
            logger.warning(f"[xhs] creator account platform={account.get('platform')} 非小红书")
            return []

        from ...account_browser import open_account_context

        # 解析 user_id（备用：构造主页 URL 用）
        uid_match = re.search(r"/user/profile/([^/?#]+)", creator_url or "")
        user_id = uid_match.group(1) if uid_match else ""

        collected: List[Dict[str, Any]] = []
        creator_name = ""

        async with open_account_context(account) as (_browser, context):
            page = await context.new_page()

            async def on_response(response):
                url = response.url or ""
                # 主接口：/api/sns/web/v1/user_posted
                # 兜底：/api/sns/web/v1/feed 偶尔用于补全；search/notes 不会出现在博主页
                if ("user_posted" not in url) or response.status != 200:
                    return
                try:
                    body = await response.json()
                except Exception:
                    return
                data = body.get("data") or {}
                notes = data.get("notes") or []
                nonlocal creator_name
                for note in notes:
                    if not isinstance(note, dict):
                        continue
                    nid = note.get("note_id") or note.get("id")
                    if not nid:
                        continue
                    tok = note.get("xsec_token") or ""
                    user = note.get("user") or {}
                    if not creator_name:
                        creator_name = (
                            user.get("nick_name")
                            or user.get("nickname")
                            or user.get("name")
                            or ""
                        )
                    title = (
                        note.get("display_title")
                        or note.get("title")
                        or ""
                    )
                    # 时间字段在 user_posted 里通常没有；feed 接口才有 time，这里给 0
                    ts = note.get("time") or note.get("create_time") or 0
                    try:
                        published_at = int(ts) if ts else 0
                    except (TypeError, ValueError):
                        published_at = 0
                    collected.append({
                        "post_id": str(nid),
                        "url": (
                            f"https://www.xiaohongshu.com/explore/{nid}"
                            f"?xsec_token={tok}&xsec_source=app_share"
                        ),
                        "title": title[:200],
                        "creator_name": creator_name,
                        "published_at": published_at,
                        "xsec_token": tok,
                    })

            page.on("response", on_response)

            try:
                # 先访问首页让 cookie 生效
                await page.goto(
                    "https://www.xiaohongshu.com/explore",
                    wait_until="domcontentloaded",
                    timeout=15000,
                )
                await asyncio.sleep(2)
                # 主页 URL：用户给的 creator_url 优先，如果只有 user_id 就构造一个
                target = (creator_url or "").strip()
                if not target.startswith("http"):
                    if user_id:
                        target = f"https://www.xiaohongshu.com/user/profile/{user_id}"
                    else:
                        logger.warning(f"[xhs] creator URL 无法解析: {creator_url}")
                        return []
                try:
                    async with page.expect_response(
                        lambda r: "user_posted" in r.url and r.status == 200,
                        timeout=20000,
                    ):
                        await page.goto(target, wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    # 兜底：导航完成但没等到 user_posted（可能是懒加载），滚一下再等
                    await page.mouse.wheel(0, 800)
                    await asyncio.sleep(3)
                else:
                    await asyncio.sleep(2)
            except Exception as e:
                logger.warning(f"[xhs] creator '{creator_url}' 加载失败: {e}")

            # 没拿到任何 note 时检测一下登录墙
            if not collected:
                try:
                    body_text = await page.evaluate(
                        "() => document.body.innerText.slice(0, 200)"
                    )
                    if "登录后查看" in body_text or "扫码登录" in body_text:
                        logger.warning(
                            f"[xhs] account '{account.get('name')}' cookie 似乎已失效，"
                            f"博主主页跳登录墙。请重新扫码登录。"
                        )
                except Exception:
                    pass

        logger.info(f"[xhs] creator='{creator_url}' fetched {len(collected)} posts")
        return collected
