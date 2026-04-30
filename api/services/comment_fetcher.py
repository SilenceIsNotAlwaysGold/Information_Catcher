"""
Fetch comments for a note via Playwright.

平台分发：
  - xhs:    拦截 /comment/page
  - douyin: 拦截 /aweme/v1/web/comment/list/
"""
import asyncio
import logging
from typing import Dict, List

from .account_browser import open_account_context

logger = logging.getLogger(__name__)


async def _fetch_xhs_comments(
    note_id: str, xsec_token: str, account: Dict, max_count: int, timeout_ms: int,
) -> List[Dict]:
    collected: List[Dict] = []

    async with open_account_context(account) as (_browser, context):
        page = await context.new_page()

        async def on_response(response):
            if "comment/page" in response.url and response.status == 200:
                try:
                    body = await response.json()
                    data = body.get("data", {}) or body
                    comments = data.get("comments", [])
                    for c in comments[:max_count]:
                        user_info = c.get("user_info", {})
                        content = c.get("content", "")
                        if not content:
                            continue
                        collected.append({
                            "comment_id": c.get("id", ""),
                            "content": content[:500],
                            "user_name": user_info.get("nickname", ""),
                            "user_id": user_info.get("user_id", ""),
                            "liked_count": c.get("liked_count", 0),
                            "create_time": c.get("create_time", 0),
                        })
                except Exception as e:
                    logger.debug(f"[comment_fetcher][xhs] parse error: {e}")

        page.on("response", on_response)

        try:
            url = (
                f"https://www.xiaohongshu.com/explore/{note_id}"
                f"?xsec_token={xsec_token}&xsec_source=pc_feed"
            )
            await page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            await asyncio.sleep(2)
        except Exception as e:
            logger.warning(f"[comment_fetcher][xhs] page load error for {note_id}: {e}")

    return collected[:max_count]


async def _fetch_douyin_comments(
    aweme_id: str, account: Dict, max_count: int, timeout_ms: int,
) -> List[Dict]:
    """拦截 /aweme/v1/web/comment/list/ 响应。"""
    collected: List[Dict] = []

    async with open_account_context(account) as (_browser, context):
        page = await context.new_page()

        async def on_response(response):
            url = response.url or ""
            if "comment/list" not in url or response.status != 200:
                return
            try:
                body = await response.json()
            except Exception:
                return
            comments = body.get("comments") or []
            for c in comments[:max_count]:
                cid = c.get("cid") or c.get("comment_id")
                if not cid:
                    continue
                user = c.get("user") or {}
                text = c.get("text") or ""
                if not text:
                    continue
                collected.append({
                    "comment_id": str(cid),
                    "content": text[:500],
                    "user_name": user.get("nickname", "") or "",
                    "user_id": user.get("uid", "") or user.get("sec_uid", "") or "",
                    "liked_count": int(c.get("digg_count") or 0),
                    "create_time": int(c.get("create_time") or 0),
                })

        page.on("response", on_response)

        try:
            video_url = f"https://www.douyin.com/video/{aweme_id}"
            async with page.expect_response(
                lambda r: "comment/list" in r.url and r.status == 200,
                timeout=timeout_ms,
            ):
                await page.goto(video_url, wait_until="domcontentloaded", timeout=timeout_ms)
            await asyncio.sleep(2)
        except Exception as e:
            logger.warning(f"[comment_fetcher][douyin] {aweme_id} 加载失败: {e}")

    return collected[:max_count]


async def fetch_note_comments(
    note_id: str,
    xsec_token: str,
    account: Dict,
    max_count: int = 20,
    timeout_ms: int = 15000,
) -> List[Dict]:
    """
    平台分发：根据 account.platform 选择拉取通道。
    Returns: list of {comment_id, content, user_name, user_id, liked_count, create_time}
    """
    if not account.get("cookie") and (account.get("fp_browser_type") or "builtin") == "builtin":
        return []

    platform = (account.get("platform") or "xhs").lower()
    if platform == "douyin":
        result = await _fetch_douyin_comments(note_id, account, max_count, timeout_ms)
    else:
        result = await _fetch_xhs_comments(note_id, xsec_token, account, max_count, timeout_ms)

    logger.info(f"[comment_fetcher][{platform}] note={note_id} fetched {len(result)} comments")
    return result
