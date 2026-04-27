"""
Fetch comments for a XHS note via Playwright (intercepts /comment/page API).
"""
import asyncio
import logging
from typing import Dict, List

from .account_browser import open_account_context

logger = logging.getLogger(__name__)


async def fetch_note_comments(
    note_id: str,
    xsec_token: str,
    account: Dict,
    max_count: int = 20,
    timeout_ms: int = 15000,
) -> List[Dict]:
    """
    Navigate to note page, intercept /comment/page API response.
    Returns list of comment dicts: comment_id, content, user_name, user_id, create_time.
    """
    if not account.get("cookie") and (account.get("fp_browser_type") or "builtin") == "builtin":
        return []

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
                    logger.debug(f"[comment_fetcher] parse error: {e}")

        page.on("response", on_response)

        try:
            url = (
                f"https://www.xiaohongshu.com/explore/{note_id}"
                f"?xsec_token={xsec_token}&xsec_source=pc_feed"
            )
            await page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            await asyncio.sleep(2)
        except Exception as e:
            logger.warning(f"[comment_fetcher] page load error for {note_id}: {e}")

    logger.info(f"[comment_fetcher] note={note_id} fetched {len(collected)} comments")
    return collected[:max_count]
