"""
Unified Playwright browser factory for monitor accounts.

Supports three backends:
  * builtin    — Playwright Chromium with per-account proxy + fingerprint
                 (user_agent / viewport / timezone / locale) and stealth.min.js
  * adspower   — AdsPower local HTTP API (http://local.adspower.net:50325)
  * bitbrowser — BitBrowser local HTTP API

Usage:
    async with open_account_context(account) as (browser, context):
        page = await context.new_page()
        ...
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

_STEALTH_JS_PATH = Path(__file__).parent.parent.parent / "libs" / "stealth.min.js"
_DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
_stealth_cache: Optional[str] = None


def _load_stealth() -> str:
    global _stealth_cache
    if _stealth_cache is None:
        try:
            _stealth_cache = _STEALTH_JS_PATH.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning(f"[browser] failed to load stealth.min.js: {e}")
            _stealth_cache = ""
    return _stealth_cache


def _parse_viewport(viewport: str) -> Optional[Dict[str, int]]:
    if not viewport:
        return None
    try:
        w, h = viewport.lower().replace(" ", "").split("x")
        return {"width": int(w), "height": int(h)}
    except Exception:
        return None


def validate_proxy_url(proxy_url: str) -> Optional[str]:
    """校验代理 URL 格式。返回 None 表示可用，返回字符串则是给前端的拒绝原因。

    支持的协议：http / https / socks5 / socks5h。socks5+鉴权会由 proxy_forwarder
    在本机起 gost 转发为 http://127.0.0.1:port，再交给 Playwright/httpx。
    """
    if not proxy_url or not proxy_url.strip():
        return None
    url = proxy_url.strip()
    try:
        p = urlparse(url)
    except Exception as e:
        return f"代理 URL 格式无效: {e}"
    scheme = (p.scheme or "").lower()
    if scheme not in ("http", "https", "socks5", "socks5h"):
        return f"不支持的代理协议 '{scheme}'，请使用 http / https / socks5"
    if not p.hostname:
        return "代理 URL 缺少 host"
    return None


def _parse_proxy(proxy_url: str) -> Optional[Dict[str, str]]:
    """Convert `http://user:pass@host:port` / `socks5://...` to Playwright proxy dict.

    Playwright Chromium does not support SOCKS5 proxy authentication — if credentials
    are present on a socks5:// URL they are silently dropped so the proxy still routes
    traffic (IP-allowlisted proxies continue to work).
    """
    if not proxy_url:
        return None
    url = proxy_url.strip()
    if not url:
        return None
    try:
        p = urlparse(url)
        if not p.hostname:
            return None
        scheme = p.scheme or "http"
        # Playwright Chromium does not support SOCKS5 proxy authentication. Stripping
        # the credentials does not help — the proxy server then rejects the unauthed
        # connection (ERR_SOCKS_CONNECTION_FAILED). Skip the proxy entirely and let
        # Chromium connect directly; users who need an authenticated proxy must use
        # HTTP/HTTPS, not SOCKS5.
        if scheme == "socks5" and (p.username or p.password):
            logger.warning(
                "[browser] SOCKS5 proxy auth is not supported by Playwright — "
                "skipping proxy and using direct connection. Use HTTP/HTTPS if you "
                "need authenticated proxying."
            )
            return None
        server = f"{scheme}://{p.hostname}:{p.port}" if p.port else f"{scheme}://{p.hostname}"
        cfg = {"server": server}
        if p.username:
            cfg["username"] = p.username
        if p.password:
            cfg["password"] = p.password
        return cfg
    except Exception as e:
        logger.warning(f"[browser] invalid proxy_url '{proxy_url}': {e}")
        return None


def _cookie_str_to_list(cookie_str: str, domain: str = ".xiaohongshu.com") -> List[Dict]:
    cookies: List[Dict] = []
    if not cookie_str:
        return cookies
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        cookies.append({
            "name": name.strip(),
            "value": value.strip(),
            "domain": domain,
            "path": "/",
        })
    return cookies


# ── Backends ────────────────────────────────────────────────────────────────

async def _open_builtin(pw, account: Dict) -> Tuple:
    launch_kwargs = {"headless": True, "args": ["--no-sandbox"]}
    # 使用 effective_proxy_url：socks5+鉴权会被转成本地 http://127.0.0.1:port
    from . import proxy_forwarder
    eff = proxy_forwarder.effective_proxy_url(account)
    proxy_cfg = _parse_proxy(eff) if eff else None
    if proxy_cfg:
        launch_kwargs["proxy"] = proxy_cfg

    browser = await pw.chromium.launch(**launch_kwargs)

    ctx_kwargs = {
        "user_agent": (account.get("user_agent") or "").strip() or _DEFAULT_UA,
        "locale": (account.get("locale") or "").strip() or "zh-CN",
        "timezone_id": (account.get("timezone") or "").strip() or "Asia/Shanghai",
    }
    vp = _parse_viewport(account.get("viewport", ""))
    if vp:
        ctx_kwargs["viewport"] = vp

    context = await browser.new_context(**ctx_kwargs)

    stealth = _load_stealth()
    if stealth:
        await context.add_init_script(stealth)

    cookie = account.get("cookie", "")
    if cookie:
        # cookie 按 platform 设到对应域：xhs 默认；抖音 .douyin.com；公众号 mp 域
        platform = (account.get("platform") or "xhs").lower()
        cookie_domain = {
            "xhs": ".xiaohongshu.com",
            "douyin": ".douyin.com",
            "mp": ".weixin.qq.com",
        }.get(platform, ".xiaohongshu.com")
        await context.add_cookies(_cookie_str_to_list(cookie, domain=cookie_domain))
    return browser, context


async def _resolve_adspower_ws(api_url: str, profile_id: str) -> str:
    """AdsPower returns {"code":0,"data":{"ws":{"puppeteer":"ws://..."}}}."""
    base = (api_url or "").rstrip("/") or "http://local.adspower.net:50325"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(f"{base}/api/v1/browser/start", params={"user_id": profile_id})
        body = resp.json()
    if body.get("code") != 0:
        raise RuntimeError(f"adspower start failed: {body}")
    ws = body.get("data", {}).get("ws", {}).get("puppeteer")
    if not ws:
        raise RuntimeError(f"adspower returned no ws endpoint: {body}")
    return ws


async def _resolve_bitbrowser_ws(api_url: str, profile_id: str) -> str:
    """BitBrowser returns {"success":true,"data":{"ws":"ws://..."}}."""
    base = (api_url or "").rstrip("/") or "http://127.0.0.1:54345"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(f"{base}/browser/open", json={"id": profile_id})
        body = resp.json()
    if not body.get("success"):
        raise RuntimeError(f"bitbrowser open failed: {body}")
    ws = body.get("data", {}).get("ws")
    if not ws:
        raise RuntimeError(f"bitbrowser returned no ws endpoint: {body}")
    return ws


async def _open_fp_browser(pw, account: Dict, backend: str) -> Tuple:
    profile_id = (account.get("fp_profile_id") or "").strip()
    api_url = (account.get("fp_api_url") or "").strip()
    if not profile_id:
        raise RuntimeError(f"{backend}: fp_profile_id is required")

    if backend == "adspower":
        ws = await _resolve_adspower_ws(api_url, profile_id)
    elif backend == "bitbrowser":
        ws = await _resolve_bitbrowser_ws(api_url, profile_id)
    else:
        raise RuntimeError(f"unsupported fp browser backend: {backend}")

    browser = await pw.chromium.connect_over_cdp(ws)
    context = browser.contexts[0] if browser.contexts else await browser.new_context()

    cookie = account.get("cookie", "")
    if cookie:
        try:
            await context.add_cookies(_cookie_str_to_list(cookie))
        except Exception as e:
            logger.warning(f"[browser] {backend} add_cookies failed: {e}")
    return browser, context


# ── Public API ──────────────────────────────────────────────────────────────

async def launch_builtin_session(account: Dict) -> Tuple:
    """Launch a Playwright chromium session in 'builtin' mode.

    Returns (playwright, browser, context). Caller is responsible for cleanup —
    useful for long-lived interactive flows (e.g. QR login) that can't use the
    context manager. Always forces builtin backend; FP-browser modes don't fit
    an interactive scan-to-login flow.
    """
    from playwright.async_api import async_playwright
    pw = await async_playwright().start()
    try:
        browser, context = await _open_builtin(pw, account)
        return pw, browser, context
    except Exception:
        await pw.stop()
        raise


async def close_session(pw, browser) -> None:
    try:
        await browser.close()
    except Exception as e:
        msg = str(e).lower()
        if "closed" not in msg and "disconnected" not in msg:
            logger.debug(f"[browser] close error: {e}")
    try:
        await pw.stop()
    except Exception:
        pass


@asynccontextmanager
async def open_account_context(account: Dict):
    """Yield (browser, context) for the given account record; cleans up on exit.

    `account` is a dict from monitor_db.get_account(...) containing at minimum:
      cookie, proxy_url, user_agent, viewport, timezone, locale,
      fp_browser_type, fp_profile_id, fp_api_url
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError as e:
        raise RuntimeError("playwright not installed") from e

    backend = (account.get("fp_browser_type") or "builtin").strip() or "builtin"

    async with async_playwright() as pw:
        if backend in ("adspower", "bitbrowser"):
            browser, context = await _open_fp_browser(pw, account, backend)
        else:
            browser, context = await _open_builtin(pw, account)
        try:
            yield browser, context
        finally:
            try:
                await browser.close()
            except Exception as e:
                msg = str(e).lower()
                if "closed" not in msg and "disconnected" not in msg:
                    logger.debug(f"[browser] close error: {e}")
