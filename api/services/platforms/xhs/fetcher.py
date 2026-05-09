"""
XHS 平台实现：包装现有 monitor_fetcher（详情）和 trending_fetcher（搜索）。

为什么是 wrapper 而不是 import 重写：
  现有两个 fetcher 已经经过大量线上验证、风控调优、token 失效处理等。
  抽象层只负责调度，不重写底层抓取逻辑。

fetch_creator_posts 三路抓取（按性能排序）：
  1) HTML 直拉：httpx GET user/profile/{id} 解析 __INITIAL_STATE__
  2) httpx + sign_service：调 /api/sns/web/v1/user_posted（支持翻页）
  3) Playwright 兜底：原浏览器拦截 user_posted XHR
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, urlparse

import httpx
import humps

from ..base import Platform
from ... import monitor_fetcher, trending_fetcher
from .sign_service import cookie_str_to_dict, get_sign_service

logger = logging.getLogger(__name__)

_HOST = "https://edith.xiaohongshu.com"
_DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)


def _request_headers(account: Optional[Dict] = None) -> Dict[str, str]:
    ua = ((account or {}).get("user_agent") or "").strip() or _DEFAULT_UA
    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.xiaohongshu.com/",
    }
    cookie = ((account or {}).get("cookie") or "").strip()
    if cookie:
        headers["Cookie"] = cookie
    return headers


def _proxy_url(account: Optional[Dict]) -> Optional[str]:
    if not account:
        return None
    try:
        from ... import proxy_forwarder
        return proxy_forwarder.effective_proxy_url(account) or None
    except Exception:
        return None


def _user_id_from_url(creator_url: str) -> str:
    m = re.search(r"/user/profile/([^/?#]+)", creator_url or "")
    return m.group(1) if m else ""


def _xsec_token_from_url(creator_url: str) -> str:
    try:
        return parse_qs(urlparse(creator_url).query).get("xsec_token", [""])[0]
    except Exception:
        return ""


def _normalize_user_posted_notes(
    notes: List[Dict], creator_name_carry: str = "",
) -> Tuple[List[Dict], str]:
    """user_posted API/HTML 共用的 notes -> 统一 schema。返回 (列表, 创作者名)。"""
    out: List[Dict] = []
    creator_name = creator_name_carry
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
                user.get("nick_name") or user.get("nickname")
                or user.get("name") or ""
            )
        title = note.get("display_title") or note.get("title") or ""
        ts = note.get("time") or note.get("create_time") or 0
        try:
            published_at = int(ts) if ts else 0
        except (TypeError, ValueError):
            published_at = 0
        out.append({
            "post_id": str(nid),
            "url": (
                f"https://www.xiaohongshu.com/explore/{nid}"
                f"?xsec_token={tok}&xsec_source=app_share"
            ),
            "title": (title or "")[:200],
            "creator_name": creator_name,
            "published_at": published_at,
            "xsec_token": tok,
        })
    return out, creator_name


async def _fetch_creator_via_html(
    creator_url: str, account: Optional[Dict],
) -> Optional[List[Dict]]:
    """快路径 1：直接 GET 创作者主页，解析 HTML 里的 __INITIAL_STATE__。"""
    user_id = _user_id_from_url(creator_url)
    if not user_id:
        return None

    target = creator_url.strip()
    if not target.startswith("http"):
        target = f"https://www.xiaohongshu.com/user/profile/{user_id}"

    headers = _request_headers(account)
    proxy = _proxy_url(account)
    client_kwargs: Dict[str, Any] = {"timeout": 20, "follow_redirects": True}
    if proxy:
        client_kwargs["proxy"] = proxy

    await asyncio.sleep(random.uniform(0.5, 1.5))

    try:
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.get(target, headers=headers)
        if resp.status_code != 200:
            logger.info(f"[xhs-html] creator HTTP {resp.status_code} — fallback")
            return None
        html = resp.text or ""
    except Exception as e:
        logger.info(f"[xhs-html] creator request failed: {e} — fallback")
        return None

    if "__INITIAL_STATE__" not in html:
        # 大概率 SPA 没渲染（小红书时不时把 user 页改为纯 CSR）
        if "登录" in html and ("扫码" in html or "登录后查看" in html):
            logger.warning("[xhs-html] creator login wall — cookie may be expired")
        return None

    matches = re.findall(
        r"window\.__INITIAL_STATE__=(\{.*?\})</script>", html, re.DOTALL,
    )
    if not matches:
        return None
    try:
        state_raw = matches[0].replace("undefined", '""')
        state = humps.decamelize(json.loads(state_raw))
    except Exception as e:
        logger.info(f"[xhs-html] state parse failed: {e}")
        return None

    user_state = state.get("user") or {}
    notes: List[Dict] = []
    # 不同版本的 SSR：notes 可能在 user.notes / user.notes_data / user.user_page_data
    candidates = (
        user_state.get("notes"),
        user_state.get("user_page_data", {}).get("notes") if isinstance(user_state.get("user_page_data"), dict) else None,
        user_state.get("note_list"),
    )
    for cand in candidates:
        if isinstance(cand, list) and cand:
            # 二维数组（按页分组）兼容
            if isinstance(cand[0], list):
                for sub in cand:
                    notes.extend([n for n in sub if isinstance(n, dict)])
            else:
                notes = [n for n in cand if isinstance(n, dict)]
            break

    if not notes:
        # SSR 数据有但没 notes（小红书版本差异），让 fallback 接管
        logger.info("[xhs-html] state.user.notes empty — fallback")
        return None

    # 创作者名兜底从 user_state 头部信息取
    name_carry = ""
    user_info = user_state.get("user_page_data") or user_state
    if isinstance(user_info, dict):
        name_carry = (
            user_info.get("nickname")
            or user_info.get("nick_name")
            or user_info.get("name")
            or ""
        )

    out, _ = _normalize_user_posted_notes(notes, name_carry)
    return out


async def _fetch_creator_via_signed_api(
    creator_url: str, account: Optional[Dict],
) -> Optional[List[Dict]]:
    """快路径 2：sign_service + httpx 调 user_posted 翻页接口。"""
    if not account or not (account.get("cookie") or "").strip():
        return None
    user_id = _user_id_from_url(creator_url)
    if not user_id:
        return None
    cookie_dict = cookie_str_to_dict(account["cookie"])
    a1 = cookie_dict.get("a1", "")
    if not a1:
        return None

    xsec_token = _xsec_token_from_url(creator_url)
    uri = "/api/sns/web/v1/user_posted"
    params = {
        "num": 30,
        "cursor": "",
        "user_id": user_id,
        "xsec_token": xsec_token,
        "xsec_source": "pc_feed",
    }

    svc = await get_sign_service()
    sign_headers = await svc.sign(uri=uri, a1=a1, params=params)
    if not sign_headers:
        return None

    headers = {
        "User-Agent": (account.get("user_agent") or "").strip() or _DEFAULT_UA,
        "Cookie": account["cookie"],
        "Origin": "https://www.xiaohongshu.com",
        "Referer": "https://www.xiaohongshu.com/",
        **sign_headers,
    }
    proxy = _proxy_url(account)
    client_kwargs: Dict[str, Any] = {"timeout": 20}
    if proxy:
        client_kwargs["proxy"] = proxy

    try:
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.get(f"{_HOST}{uri}", params=params, headers=headers)
        if resp.status_code in (461, 471):
            logger.warning(f"[xhs-api] user_posted CAPTCHA HTTP {resp.status_code} — fallback")
            return None
        if resp.status_code != 200:
            logger.info(f"[xhs-api] user_posted HTTP {resp.status_code} — fallback")
            return None
        data = resp.json()
    except Exception as e:
        logger.info(f"[xhs-api] user_posted request failed: {e} — fallback")
        return None

    if not data.get("success"):
        logger.info(f"[xhs-api] user_posted biz error: {data.get('msg')!r} — fallback")
        return None

    notes = ((data.get("data") or {}).get("notes")) or []
    out, _ = _normalize_user_posted_notes(notes)
    return out if out else None


async def _fetch_creator_via_playwright(
    creator_url: str, account: Optional[Dict],
) -> List[Dict]:
    """慢路径：原 Playwright 拦截实现，保留作为 fallback。"""
    if not account or not account.get("cookie"):
        logger.warning("[xhs] creator追新 需要带 cookie 的账号")
        return []
    if (account.get("platform") or "xhs") != "xhs":
        logger.warning(f"[xhs] creator account platform={account.get('platform')} 非小红书")
        return []

    from ...account_browser import open_account_context

    user_id = _user_id_from_url(creator_url)
    collected: List[Dict] = []
    creator_name = ""

    async with open_account_context(account) as (_browser, context):
        page = await context.new_page()

        async def on_response(response):
            url = response.url or ""
            if ("user_posted" not in url) or response.status != 200:
                return
            try:
                body = await response.json()
            except Exception:
                return
            data = body.get("data") or {}
            notes = data.get("notes") or []
            nonlocal creator_name
            normalized, creator_name = _normalize_user_posted_notes(
                notes, creator_name,
            )
            collected.extend(normalized)

        page.on("response", on_response)

        try:
            await page.goto(
                "https://www.xiaohongshu.com/explore",
                wait_until="domcontentloaded", timeout=15000,
            )
            await asyncio.sleep(2)
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
                await page.mouse.wheel(0, 800)
                await asyncio.sleep(3)
            else:
                await asyncio.sleep(2)
        except Exception as e:
            logger.warning(f"[xhs] creator '{creator_url}' 加载失败: {e}")

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

    return collected


class XHSPlatform(Platform):
    name = "xhs"
    label = "小红书"
    url_hints = ["xiaohongshu.com", "xhslink.com"]

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        link = (raw_url or "").strip()
        if not link:
            return None

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
                "xsec_source": "app_share",
                "note_url": link,
            }

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
        return await trending_fetcher.search_trending_notes(keyword, account, min_likes)

    async def fetch_creator_posts(
        self, creator_url: str, account: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """抓 XHS 博主主页发布列表。

        三路抓取按性能排序：
          1) HTML 直拉（无需登录、最快，~200ms）
          2) sign_service + httpx /user_posted（需 cookie，~500ms）
          3) Playwright 拦截（兜底，~3-5s）
        前两路任一成功即返回；都失败时走 Playwright 兜底。
        """
        # 路线 1：HTML 直拉。account 可选（无 cookie 也可能成功，看 SSR 是否给）
        try:
            html_notes = await _fetch_creator_via_html(creator_url, account)
        except Exception as e:
            logger.warning(f"[xhs] creator HTML 路径异常: {e}")
            html_notes = None
        if html_notes:
            logger.info(
                f"[xhs] creator='{creator_url}' via HTML: {len(html_notes)} posts"
            )
            return html_notes

        # 路线 2：sign_service 直调 user_posted（要 cookie + a1）
        try:
            api_notes = await _fetch_creator_via_signed_api(creator_url, account)
        except Exception as e:
            logger.warning(f"[xhs] creator signed API 异常: {e}")
            api_notes = None
        if api_notes:
            logger.info(
                f"[xhs] creator='{creator_url}' via signed API: {len(api_notes)} posts"
            )
            return api_notes

        # 路线 3：原 Playwright 拦截兜底
        pw_notes = await _fetch_creator_via_playwright(creator_url, account)
        logger.info(
            f"[xhs] creator='{creator_url}' via Playwright fallback: "
            f"{len(pw_notes)} posts"
        )
        return pw_notes
