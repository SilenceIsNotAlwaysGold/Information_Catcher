"""
Cookie health check for monitor accounts.

XHS gates the search-results page behind a login wall, so we use it as a probe:
loading `/search_result?keyword=...` with a valid cookie shows the result list,
without a valid cookie shows the "登录后查看搜索结果" prompt and never fires
`/api/sns/web/v1/search/notes`. Reading the body text is enough to tell which.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Dict

from .account_browser import open_account_context

logger = logging.getLogger(__name__)

_PROBE_URL = (
    "https://www.xiaohongshu.com/search_result"
    "?keyword=test&source=web_search&type=51"
)
_LOGIN_HINTS = ("登录后查看", "扫码登录", "请先登录")


async def check_cookie(account: Dict) -> str:
    """Return 'valid' | 'expired'. Errors count as expired so the user is alerted."""
    if not account.get("cookie") and (account.get("fp_browser_type") or "builtin") == "builtin":
        return "expired"

    try:
        async with open_account_context(account) as (_browser, context):
            page = await context.new_page()
            await page.goto(_PROBE_URL, wait_until="domcontentloaded", timeout=15000)
            await asyncio.sleep(3)
            try:
                body_text = await page.evaluate(
                    "() => document.body ? document.body.innerText.slice(0, 300) : ''"
                )
            except Exception:
                body_text = ""

            if any(hint in body_text for hint in _LOGIN_HINTS):
                return "expired"
            return "valid"
    except Exception as e:
        logger.warning(f"[cookie_check] account '{account.get('name')}' probe failed: {e}")
        return "expired"
