"""
Fetch trending XHS posts by keyword using Playwright.
Intercepts the XHS internal search API response which is signed by the browser.
Requires a valid account cookie (web_session + a1, etc.).
"""

import asyncio
import logging
from typing import Dict, List
from urllib.parse import quote

from .account_browser import open_account_context

logger = logging.getLogger(__name__)


def _parse_count(value) -> int:
    if value is None:
        return 0
    s = str(value).replace(",", "").strip()
    if not s:
        return 0
    if s.endswith("万"):
        try:
            return int(float(s[:-1]) * 10000)
        except ValueError:
            return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


async def search_trending_notes(
    keyword: str,
    account: Dict,
    min_likes: int = 1000,
    timeout_ms: int = 12000,
) -> List[Dict]:
    """
    Search XHS for notes by keyword using the given account's browser context.
    Returns a list of note dicts with engagement metrics.
    """
    if not account.get("cookie") and (account.get("fp_browser_type") or "builtin") == "builtin":
        logger.warning("[trending] builtin account has no cookie, skipping search")
        return []

    collected: List[Dict] = []

    async with open_account_context(account) as (_browser, context):
        page = await context.new_page()

        async def on_response(response):
            if "search/notes" in response.url and response.status == 200:
                try:
                    body = await response.json()
                    items = (
                        body.get("data", {}).get("items", [])
                        or body.get("items", [])
                    )
                    for item in items:
                        note = item.get("note_card") or item
                        interact = note.get("interact_info", {})
                        liked = _parse_count(interact.get("liked_count"))
                        collected_cnt = _parse_count(interact.get("collected_count"))
                        comment = _parse_count(interact.get("comment_count"))
                        if liked < min_likes:
                            continue
                        note_id = note.get("note_id") or item.get("id", "")
                        if not note_id:
                            continue
                        xsec_token = item.get("xsec_token", "")
                        author_info = note.get("user", {})
                        # XHS search response (current schema): title in `display_title`,
                        # author nickname in `nick_name`. Search payload doesn't include
                        # the note body — only title is available; desc stays empty until
                        # we fetch the detail page.
                        title = (
                            note.get("display_title")
                            or note.get("title")
                            or ""
                        )
                        nick = author_info.get("nick_name") or author_info.get("nickname") or ""
                        collected.append({
                            "note_id": note_id,
                            "title": title[:200],
                            "desc_text": "",
                            "xsec_token": xsec_token,
                            "note_url": (
                                f"https://www.xiaohongshu.com/explore/{note_id}"
                                f"?xsec_token={xsec_token}&xsec_source=pc_search"
                            ),
                            "liked_count": liked,
                            "collected_count": collected_cnt,
                            "comment_count": comment,
                            "author": nick,
                        })
                except Exception as e:
                    logger.debug(f"[trending] parse response error: {e}")

        page.on("response", on_response)

        try:
            # SPA navigation: load the home page first so the React app boots,
            # then drive the search via the visible input — that is what triggers
            # the internal /search/notes XHR.
            await page.goto(
                "https://www.xiaohongshu.com/explore",
                wait_until="domcontentloaded",
                timeout=timeout_ms,
            )
            await asyncio.sleep(2)

            # Use `page.wait_for_response` *while* navigating so we don't miss the
            # request that fires before our listener attaches.
            search_url = (
                f"https://www.xiaohongshu.com/search_result"
                f"?keyword={quote(keyword)}&source=web_search&type=51"
            )
            try:
                async with page.expect_response(
                    lambda r: "search/notes" in r.url and r.status == 200,
                    timeout=15000,
                ):
                    await page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
            except Exception:
                # Fallback: navigation completed but no search/notes — try scrolling
                # to trigger lazy load.
                await page.mouse.wheel(0, 800)
                await asyncio.sleep(3)
            else:
                await asyncio.sleep(2)

        except Exception as e:
            logger.warning(f"[trending] page load error for '{keyword}': {e}")

        # Detect login-required state (cookie expired). XHS shows the login wall
        # on the search page when there is no valid web_session, and crucially
        # never fires the /search/notes XHR — explain the situation in the log.
        if not collected:
            try:
                body_text = await page.evaluate(
                    "() => document.body.innerText.slice(0, 200)"
                )
                if "登录后查看" in body_text or "扫码登录" in body_text:
                    logger.warning(
                        f"[trending] account '{account.get('name')}' cookie appears "
                        f"expired — XHS shows login wall on search page. "
                        f"Re-login via the QR-code flow to refresh the cookie."
                    )
            except Exception:
                pass

    logger.info(f"[trending] keyword='{keyword}' found {len(collected)} posts >= {min_likes} likes")
    return collected
