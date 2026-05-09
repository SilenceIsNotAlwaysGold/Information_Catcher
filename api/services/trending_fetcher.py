"""
Fetch trending XHS posts by keyword.

主路线（快）：
  调用 sign_service 拿签名头 → httpx 直接 POST edith.xiaohongshu.com /search/notes
  典型耗时 200-500ms（vs Playwright 全启动 3-5s）。

兜底路线（稳）：
  签名服务失败 / API 直连返回异常 → 走原来的 Playwright 拦截 search/notes 响应。
  保留原实现以应对 mnsv2 算法变更等不可控因素。
"""

import asyncio
import json
import logging
import random
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import httpx

from .account_browser import open_account_context
from .platforms.xhs.sign_service import cookie_str_to_dict, get_sign_service

logger = logging.getLogger(__name__)

_HOST = "https://edith.xiaohongshu.com"
_DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)


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


def _gen_search_id() -> str:
    """与 src/platforms/xhs/help.py::get_search_id 等价的 base36 id。"""
    import time as _t

    e = int(_t.time() * 1000) << 64
    t = int(random.uniform(0, 2147483646))
    n = e + t
    if n == 0:
        return "0"
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    sign = ""
    if n < 0:
        sign = "-"
        n = -n
    while n > 0:
        n, r = divmod(n, 36)
        out.append(chars[r])
    return sign + "".join(reversed(out))


def _normalize_items(items: List[Dict], min_likes: int) -> List[Dict]:
    """把 search/notes 接口返回的 items 转成上游统一 schema。"""
    collected: List[Dict] = []
    for item in items:
        note = item.get("note_card") or item
        interact = note.get("interact_info", {})
        liked = _parse_count(interact.get("liked_count"))
        if liked < min_likes:
            continue
        note_id = note.get("note_id") or item.get("id", "")
        if not note_id:
            continue
        xsec_token = item.get("xsec_token", "") or note.get("xsec_token", "")
        author = note.get("user", {}) or {}
        title = note.get("display_title") or note.get("title") or ""
        nick = author.get("nick_name") or author.get("nickname") or ""

        cover_url = ""
        cover = note.get("cover") or {}
        if isinstance(cover, dict):
            cover_url = (
                cover.get("url_default") or cover.get("url_pre")
                or cover.get("url") or ""
            )

        images: List[str] = []
        for img in (note.get("image_list") or []):
            if not isinstance(img, dict):
                continue
            info_list = img.get("info_list") or []
            picked = ""
            for info in info_list:
                if info.get("image_scene") == "WB_DFT":
                    picked = info.get("url", "")
                    break
            if not picked and info_list:
                picked = info_list[0].get("url", "")
            if not picked:
                picked = img.get("url", "") or img.get("url_default", "")
            if picked:
                images.append(picked)

        note_type = note.get("type") or "normal"
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
            "collected_count": _parse_count(interact.get("collected_count")),
            "comment_count": _parse_count(interact.get("comment_count")),
            "author": nick,
            "cover_url": cover_url,
            "images": images,
            "video_url": "",
            "note_type": note_type,
        })
    return collected


async def _search_via_signed_api(
    keyword: str, account: Dict, min_likes: int,
) -> Optional[List[Dict]]:
    """快路径：sign_service + httpx。失败返回 None 让上层 fallback。"""
    cookie = (account.get("cookie") or "").strip()
    if not cookie:
        return None
    cookie_dict = cookie_str_to_dict(cookie)
    a1 = cookie_dict.get("a1", "")
    if not a1:
        logger.info("[trending] cookie missing a1 — sign_service path skipped")
        return None

    uri = "/api/sns/web/v1/search/notes"
    payload = {
        "keyword": keyword,
        "page": 1,
        "page_size": 20,
        "search_id": _gen_search_id(),
        "sort": "general",
        "note_type": 0,
    }

    svc = await get_sign_service()
    sign_headers = await svc.sign(uri=uri, a1=a1, payload=payload)
    if not sign_headers:
        return None

    headers = {
        "User-Agent": (account.get("user_agent") or "").strip() or _DEFAULT_UA,
        "Cookie": cookie,
        "Origin": "https://www.xiaohongshu.com",
        "Referer": "https://www.xiaohongshu.com/",
        "Content-Type": "application/json;charset=UTF-8",
        **sign_headers,
    }

    proxy: Optional[str] = None
    try:
        from . import proxy_forwarder
        eff = proxy_forwarder.effective_proxy_url(account)
        if eff:
            proxy = eff
    except Exception:
        pass

    client_kwargs: Dict[str, Any] = {"timeout": 20}
    if proxy:
        client_kwargs["proxy"] = proxy

    body_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    try:
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.post(f"{_HOST}{uri}", content=body_bytes, headers=headers)
        if resp.status_code in (461, 471):
            logger.warning(
                f"[trending] CAPTCHA on search/notes (HTTP {resp.status_code}) — fallback"
            )
            return None
        if resp.status_code != 200:
            logger.warning(f"[trending] signed API HTTP {resp.status_code} — fallback")
            return None
        data = resp.json()
    except Exception as e:
        logger.warning(f"[trending] signed API request failed ({e}) — fallback")
        return None

    if not data.get("success"):
        # 常见：300012 IP 风控；-100 / -101 签名失败
        code = data.get("code")
        msg = data.get("msg")
        logger.warning(f"[trending] signed API biz error code={code} msg={msg!r} — fallback")
        return None

    payload_data = data.get("data") or {}
    items = payload_data.get("items") or []
    return _normalize_items(items, min_likes)


async def _search_via_playwright(
    keyword: str, account: Dict, min_likes: int, timeout_ms: int,
) -> List[Dict]:
    """慢路径：原 Playwright 拦截路线，作为 fallback。"""
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
                    collected.extend(_normalize_items(items, min_likes))
                except Exception as e:
                    logger.debug(f"[trending] parse response error: {e}")

        page.on("response", on_response)

        try:
            await page.goto(
                "https://www.xiaohongshu.com/explore",
                wait_until="domcontentloaded", timeout=timeout_ms,
            )
            await asyncio.sleep(2)
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
                await page.mouse.wheel(0, 800)
                await asyncio.sleep(3)
            else:
                await asyncio.sleep(2)
        except Exception as e:
            logger.warning(f"[trending] page load error for '{keyword}': {e}")

        if not collected:
            try:
                body_text = await page.evaluate(
                    "() => document.body.innerText.slice(0, 200)"
                )
                if "登录后查看" in body_text or "扫码登录" in body_text:
                    logger.warning(
                        f"[trending] account '{account.get('name')}' cookie appears "
                        f"expired — XHS shows login wall on search page."
                    )
            except Exception:
                pass

    return collected


async def search_trending_notes(
    keyword: str,
    account: Dict,
    min_likes: int = 1000,
    timeout_ms: int = 12000,
) -> List[Dict]:
    """
    主入口：先尝试 sign_service + httpx，失败兜底 Playwright。
    保持原签名兼容。
    """
    # 用 sign_service 走快路径
    fast = await _search_via_signed_api(keyword, account, min_likes)
    if fast is not None:
        logger.info(
            f"[trending] keyword='{keyword}' via signed API: {len(fast)} posts >= {min_likes} likes"
        )
        return fast

    # 兜底：Playwright 拦截
    slow = await _search_via_playwright(keyword, account, min_likes, timeout_ms)
    logger.info(
        f"[trending] keyword='{keyword}' via Playwright fallback: "
        f"{len(slow)} posts >= {min_likes} likes"
    )
    return slow
