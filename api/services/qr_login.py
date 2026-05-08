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

    # 扫码时浏览器同样走用户配置的代理：
    # 部署在云服务器（数据中心 IP）上时，XHS 风控可能拒绝下发登录态 cookie，
    # 表现为：用户手机点了「确认登录」，但服务器侧浏览器一直拿不到 web_session。
    # 配置代理后浏览器伪装成普通家庭/移动 IP，能绕过这层风控。
    # 注：proxy_forwarder 用 account.id 做 forwarder 的 key；这里给个负数临时 id
    # 跟真账号 id 区分，结束时清理。socks5+auth 代理会被 gost 转成本地 http。
    fake_aid = -int(time.time() * 1000)
    proto_account = {
        "id": fake_aid,
        "cookie": "",
        "proxy_url": account_template.get("proxy_url", "") or "",
        "user_agent": account_template.get("user_agent", "") or "",
        "viewport": account_template.get("viewport", "") or "",
        "timezone": account_template.get("timezone", "") or "Asia/Shanghai",
        "locale": account_template.get("locale", "") or "zh-CN",
        "fp_browser_type": "builtin",
    }

    # 主动启转发（socks5+auth → 本地 http），launch 时 effective_proxy_url 会拿到
    from . import proxy_forwarder
    try:
        await proxy_forwarder.ensure_forwarder(proto_account)
    except Exception as e:
        logger.warning(f"[qr_login] proxy forwarder start failed: {e}")

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
        "_fake_aid": fake_aid,  # 用于关闭浏览器时清理 gost forwarder
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
    last_web_session: str = ""
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

            # 小红书扫码登录的成功信号：web_session cookie 的值发生变化。
            # 2026-05 起 XHS 不再给访客下发 web_session，只有用户点确认登录后才下发；
            # 极少数情况会先给访客一个 web_session，登录后再替换。两种情况都覆盖：
            # 只要当前 web_session 是非空且不等于初始 baseline，就判 success。
            web_session = ""
            for c in cookies:
                if c.get("name") == "web_session":
                    web_session = c.get("value", "") or ""
                    break

            # web_session 值变化日志（便于排查）
            if web_session != last_web_session:
                logger.info(
                    f"[qr_login] {session_id} web_session changed: "
                    f"{last_web_session!r} → {web_session!r}"
                )
                last_web_session = web_session

            success = bool(web_session) and web_session != session["_no_logged"]

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
                    f"cookie_count={len(cookie_names)}, "
                    f"cookies={sorted(cookie_names)}, "
                    f"url={cur_url!r})"
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
        # 多租户：账号归属当前用户。template 由 router 注入 user_id
        user_id=tmpl.get("user_id"),
        platform=(tmpl.get("platform") or "xhs"),
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
    # 清理 gost forwarder（用 fake_aid 启起来的）
    fake_aid = session.pop("_fake_aid", None)
    if fake_aid is not None:
        try:
            from . import proxy_forwarder
            await proxy_forwarder.drop_forwarder(fake_aid)
        except Exception as e:
            logger.debug(f"[qr_login] drop forwarder error: {e}")
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
