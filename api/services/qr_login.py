"""
XHS QR code login flow for the Web UI.

Usage:
    session = await start_session(account_template)
    # → {"session_id": "...", "qr_image": "<base64 png>"}

    status = get_status(session_id)
    # → {"status": "waiting" | "success" | "expired" | "failed" | "cancelled",
    #    "qr_image": "...", "account_id": 42?, "error": "..."}

Sessions are kept in memory; successful logins auto-create a monitor_account.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Dict, Optional

from . import monitor_db as db
from .account_browser import launch_builtin_session, close_session

logger = logging.getLogger(__name__)

_SESSION_TTL = 300   # 5 min — browser stays open
_REAP_AFTER   = 120  # keep terminal status visible this long after completion
_POLL_INTERVAL = 2

_sessions: Dict[str, Dict] = {}


# ── helpers ─────────────────────────────────────────────────────────────────

def _reap_old():
    """Drop sessions whose browsers closed more than _REAP_AFTER seconds ago."""
    now = time.time()
    dead = [
        sid for sid, s in _sessions.items()
        if s.get("closed_at") and now - s["closed_at"] > _REAP_AFTER
    ]
    for sid in dead:
        _sessions.pop(sid, None)


async def _capture_qr(page) -> Optional[str]:
    """Return the QR code <img> src data-URL stripped to just the base64 body.

    Tries multiple selectors; XHS occasionally renames the QR image class.
    """
    # Try a list of possible selectors. The first hit wins.
    candidates = [
        "img.qrcode-img",
        ".qrcode-img img",
        ".login-container img[src^='data:image']",
        "img[src^='data:image/png;base64']",
    ]

    matched: Optional[str] = None
    for sel in candidates:
        try:
            await page.wait_for_selector(sel, timeout=15000, state="visible")
            matched = sel
            break
        except Exception:
            continue

    if not matched:
        # Fallback: try clicking the top-right 登录 button to surface the modal,
        # then retry the candidate list.
        try:
            await page.get_by_text("登录", exact=True).first.click(timeout=4000)
        except Exception:
            try:
                btn = page.locator(
                    "xpath=//*[@id='app']/div[1]/div[2]/div[1]/ul/div[1]/button"
                )
                await btn.click(timeout=4000)
            except Exception as e:
                logger.warning(f"[qr_login] login button not found: {e}")
                return None
        for sel in candidates:
            try:
                await page.wait_for_selector(sel, timeout=10000, state="visible")
                matched = sel
                break
            except Exception:
                continue

    if not matched:
        logger.warning(
            f"[qr_login] QR image not found after retries; final URL={page.url}"
        )
        return None

    try:
        src = await page.eval_on_selector(matched, "el => el.src")
    except Exception as e:
        logger.warning(f"[qr_login] QR src read failed (sel={matched}): {e}")
        return None

    if not src:
        return None
    return src


async def _current_web_session(context) -> str:
    cookies = await context.cookies()
    for c in cookies:
        if c.get("name") == "web_session":
            return c.get("value", "") or ""
    return ""


async def _snapshot_cookie_str(context) -> str:
    cookies = await context.cookies()
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name"))


# ── session lifecycle ──────────────────────────────────────────────────────

async def start_session(account_template: Dict) -> Dict:
    """Launch browser, surface the QR, start watcher. Returns session_id+qr."""
    _reap_old()

    # QR login is an interactive local operation (the user physically scans with
    # their phone), so the browser should use the machine's direct connection —
    # no proxy.  The proxy_url from the template is stored on the saved account
    # and used later by the background monitoring service.
    proto_account = {
        "cookie": "",
        "proxy_url": "",
        "user_agent": account_template.get("user_agent", "") or "",
        "viewport": account_template.get("viewport", "") or "",
        "timezone": account_template.get("timezone", "") or "Asia/Shanghai",
        "locale": account_template.get("locale", "") or "zh-CN",
        "fp_browser_type": "builtin",
    }

    pw, browser, context = await launch_builtin_session(proto_account)
    page = await context.new_page()

    try:
        # Open the dedicated login page — QR code shows by default, no need
        # to click anything to surface the modal.
        await page.goto(
            "https://www.xiaohongshu.com/login",
            wait_until="domcontentloaded",
            timeout=25000,
        )
    except Exception as e:
        await close_session(pw, browser)
        raise RuntimeError(f"无法访问小红书登录页: {e}") from e

    qr_image = await _capture_qr(page)
    if not qr_image:
        await close_session(pw, browser)
        raise RuntimeError("未能获取二维码，请重试（可能是代理或网络问题）")

    no_logged = await _current_web_session(context)

    session_id = secrets.token_urlsafe(12)
    session = {
        "session_id": session_id,
        "created_at": time.time(),
        "status": "waiting",         # waiting | success | expired | failed | cancelled
        "qr_image": qr_image,
        "account_template": account_template,
        "account_id": None,
        "error": "",
        "_pw": pw,
        "_browser": browser,
        "_context": context,
        "_page": page,
        "_no_logged": no_logged,
        "_task": None,
        "closed_at": None,
    }
    _sessions[session_id] = session
    session["_task"] = asyncio.create_task(_watch(session_id))
    return {"session_id": session_id, "qr_image": qr_image}


async def _watch(session_id: str):
    session = _sessions.get(session_id)
    if not session:
        return
    logger.info(
        f"[qr_login] watcher started: session={session_id} "
        f"initial_web_session={session['_no_logged']!r}"
    )
    last_cookie_names: set = set()
    last_url: str = ""
    poll_count = 0
    try:
        start = time.time()
        while True:
            if session["status"] in ("success", "expired", "failed", "cancelled"):
                break
            if time.time() - start > _SESSION_TTL:
                session["status"] = "expired"
                logger.info(f"[qr_login] {session_id} expired (ttl)")
                break

            ctx = session["_context"]
            page = session.get("_page")
            try:
                cookies = await ctx.cookies()
            except Exception as e:
                session["status"] = "failed"
                session["error"] = f"浏览器会话异常: {e}"
                logger.error(f"[qr_login] {session_id} ctx.cookies() failed: {e}")
                break

            # Trace cookie / URL changes — XHS occasionally renames the session
            # cookie, so logging *all* cookie names lets us spot a working name.
            cookie_names = {c.get("name") for c in cookies if c.get("name")}
            new_cookies = cookie_names - last_cookie_names
            try:
                cur_url = page.url if page else ""
            except Exception:
                cur_url = ""
            if new_cookies:
                logger.info(
                    f"[qr_login] {session_id} new cookies: {sorted(new_cookies)}"
                )
            if cur_url != last_url:
                logger.info(f"[qr_login] {session_id} url changed: {cur_url}")
            last_cookie_names = cookie_names
            last_url = cur_url

            # Login success heuristic: web_session changed, OR the page URL
            # navigated away from the home/login page after a scan.
            web_session = ""
            for c in cookies:
                if c.get("name") == "web_session":
                    web_session = c.get("value", "") or ""
                    break

            success = bool(web_session) and web_session != session["_no_logged"]
            if not success and "web_session" in new_cookies:
                # Cookie just appeared this poll — count as success even if it
                # equals the (empty) baseline by some race.
                success = True

            if success:
                try:
                    cookie_str = await _snapshot_cookie_str(ctx)
                    acc_id = await _save_account(session, cookie_str)
                    session["account_id"] = acc_id
                    session["status"] = "success"
                    logger.info(
                        f"[qr_login] {session_id} login SUCCESS, account_id={acc_id}, "
                        f"cookie len={len(cookie_str)}"
                    )
                except Exception as e:
                    session["status"] = "failed"
                    session["error"] = f"保存账号失败: {e}"
                    logger.error(f"[qr_login] {session_id} save failed: {e}")
                break

            poll_count += 1
            if poll_count % 10 == 0:
                logger.info(
                    f"[qr_login] {session_id} still waiting "
                    f"(poll #{poll_count}, web_session={web_session!r}, "
                    f"cookie_count={len(cookie_names)})"
                )
            await asyncio.sleep(_POLL_INTERVAL)
    finally:
        await _close_browser(session)


async def _save_account(session: Dict, cookie_str: str) -> int:
    tmpl = session["account_template"]
    name = (tmpl.get("name") or "").strip() or f"扫码_{int(time.time())}"
    return await db.add_account(
        name=name,
        cookie=cookie_str,
        proxy_url=tmpl.get("proxy_url", "") or "",
        user_agent=tmpl.get("user_agent", "") or "",
        viewport=tmpl.get("viewport", "") or "",
        timezone=tmpl.get("timezone", "") or "Asia/Shanghai",
        locale=tmpl.get("locale", "") or "zh-CN",
        fp_browser_type="builtin",
        fp_profile_id="",
        fp_api_url="",
    )


async def _close_browser(session: Dict):
    pw = session.pop("_pw", None)
    browser = session.pop("_browser", None)
    session.pop("_context", None)
    session.pop("_page", None)
    if browser:
        try:
            await close_session(pw, browser)
        except Exception as e:
            logger.debug(f"[qr_login] close error: {e}")
    session["closed_at"] = time.time()


def get_status(session_id: str) -> Optional[Dict]:
    s = _sessions.get(session_id)
    if not s:
        return None
    return {
        "session_id": session_id,
        "status": s["status"],
        "qr_image": s["qr_image"] if s["status"] == "waiting" else "",
        "account_id": s.get("account_id"),
        "error": s.get("error", ""),
    }


async def cancel_session(session_id: str) -> bool:
    s = _sessions.get(session_id)
    if not s:
        return False
    if s["status"] == "waiting":
        s["status"] = "cancelled"
    # The watcher coroutine will close the browser when its loop sees the new status.
    return True
