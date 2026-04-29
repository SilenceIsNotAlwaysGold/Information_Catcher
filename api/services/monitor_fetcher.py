import re
import json
import random
import logging
import asyncio
import httpx
import humps
from urllib.parse import urlparse, parse_qs, unquote
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)

_BASE_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.xiaohongshu.com/",
}


def _parse_count(value) -> int:
    if value is None:
        return 0
    s = str(value).replace(",", "").strip()
    if not s or s in ("", "0"):
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


def _extract_from_html(note_id: str, html: str) -> Optional[Dict]:
    if "noteDetailMap" not in html:
        # Login wall, captcha, or "笔记不存在" page — no detail map at all.
        if "登录" in html and "扫码" in html:
            logger.warning(f"[fetcher] {note_id}: response is the login wall (need cookie)")
        elif "笔记不存在" in html or "已删除" in html or "无法查看" in html:
            logger.warning(f"[fetcher] {note_id}: note appears to be deleted or private")
        else:
            logger.warning(f"[fetcher] {note_id}: noteDetailMap missing, HTML preview: {html[:200]!r}")
        return None
    matches = re.findall(r"window\.__INITIAL_STATE__=(\{.*?\})</script>", html, re.DOTALL)
    if not matches:
        logger.warning(f"[fetcher] {note_id}: __INITIAL_STATE__ regex did not match")
        return None
    try:
        state_raw = matches[0].replace("undefined", '""')
        state = humps.decamelize(json.loads(state_raw))
        note = state["note"]["note_detail_map"][note_id]["note"]
    except (KeyError, json.JSONDecodeError, IndexError) as e:
        logger.warning(f"[fetcher] {note_id}: state parse failed ({type(e).__name__}: {e})")
        return None

    interact = note.get("interact_info", {})
    raw_title = note.get("title") or ""
    raw_desc  = note.get("desc") or ""

    # Image list — detail page exposes higher-res URLs than search.
    images: list = []
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

    # Cover (rare to differ from images[0], but normalize anyway)
    cover = note.get("cover") or {}
    cover_url = ""
    if isinstance(cover, dict):
        cover_url = (cover.get("url_default") or cover.get("url_pre")
                     or cover.get("url") or "")

    # Video URL — only present on video notes.
    video_url = ""
    note_type = note.get("type") or "normal"
    if note_type == "video":
        video = note.get("video") or {}
        media = (video.get("media") or {}) if isinstance(video, dict) else {}
        stream = (media.get("stream") or {}) if isinstance(media, dict) else {}
        # Try several quality keys: h264 (most common) > h265 > av1
        for key in ("h264", "h265", "av1"):
            arr = stream.get(key)
            if isinstance(arr, list) and arr:
                first = arr[0]
                if isinstance(first, dict):
                    video_url = first.get("master_url") or first.get("backup_urls", [""])[0] or ""
                    if video_url:
                        break

    return {
        "title": (raw_title or raw_desc)[:200] if (raw_title or raw_desc) else "",
        "desc":  raw_desc[:5000],
        "liked_count": _parse_count(interact.get("liked_count")),
        "collected_count": _parse_count(interact.get("collected_count")),
        "comment_count": _parse_count(interact.get("comment_count")),
        "share_count": _parse_count(interact.get("share_count")),
        "cover_url": cover_url,
        "images": images,
        "video_url": video_url,
        "note_type": note_type,
    }


async def resolve_short_link(short_url: str) -> Optional[Dict]:
    """Follow xhslink.com redirect and extract note_id + xsec_token."""
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, max_redirects=10, timeout=15
        ) as client:
            resp = await client.get(short_url, headers=_BASE_HEADERS)
            final_url = str(resp.url)
    except Exception:
        return None

    parsed = urlparse(final_url)
    params = parse_qs(parsed.query)

    # Redirected to login page — real URL is in redirectPath param
    if parsed.path.startswith("/login"):
        redirect_path = params.get("redirectPath", [""])[0]
        if not redirect_path:
            return None
        actual_url = unquote(redirect_path)
        parsed = urlparse(actual_url)
        params = parse_qs(parsed.query)

    parts = parsed.path.strip("/").split("/")
    # Accept both /explore/{id} and /discovery/item/{id}
    if len(parts) < 2 or parts[0] not in ("explore",) and not (len(parts) >= 3 and parts[:2] == ["discovery", "item"]):
        return None

    note_id = parts[-1]
    xsec_token = params.get("xsec_token", [""])[0]
    xsec_source = params.get("xsec_source", ["app_share"])[0]

    return {
        "note_id": note_id,
        "xsec_token": xsec_token,
        "xsec_source": xsec_source,
        "note_url": f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token={xsec_token}&xsec_source={xsec_source}",
    }


async def fetch_note_metrics(
    note_id: str,
    xsec_token: str,
    xsec_source: str,
    cookie: Optional[str] = None,
    account: Optional[Dict[str, Any]] = None,
) -> tuple:
    """Fetch note metrics by parsing the note HTML page.

    Returns (metrics_dict_or_None, status). Status is one of:
      'ok'              — got valid metrics
      'login_required'  — XHS 302 to /login (this note is gated by XHS)
      'deleted'         — note no longer exists
      'error'           — request failed / unparseable HTML / other

    `account` takes precedence: when supplied, its cookie / user_agent / proxy_url
    are applied. `cookie` kept for backward compat when no account record exists.
    """
    url = (
        f"https://www.xiaohongshu.com/explore/{note_id}"
        f"?xsec_token={xsec_token}&xsec_source={xsec_source}"
    )
    headers = dict(_BASE_HEADERS)
    proxy: Optional[str] = None

    if account:
        acc_cookie = account.get("cookie") or cookie
        if acc_cookie:
            headers["Cookie"] = acc_cookie
        ua = (account.get("user_agent") or "").strip()
        if ua:
            headers["User-Agent"] = ua
        # effective_proxy_url：socks5+鉴权会被转成本地 http://127.0.0.1:port
        from . import proxy_forwarder
        eff = proxy_forwarder.effective_proxy_url(account)
        if eff:
            proxy = eff
    elif cookie:
        headers["Cookie"] = cookie

    await asyncio.sleep(random.uniform(1.0, 2.5))

    try:
        client_kwargs: Dict[str, Any] = {"timeout": 20}
        if proxy:
            client_kwargs["proxy"] = proxy
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location", "")
                if "/login" in location:
                    logger.warning(f"[fetcher] {note_id}: 302 → login wall (XHS gated)")
                    return None, "login_required"
                logger.warning(f"[fetcher] {note_id}: unexpected {resp.status_code} → {location[:80]}")
                return None, "error"
            if resp.status_code == 404:
                logger.warning(f"[fetcher] {note_id}: HTTP 404 (note deleted)")
                return None, "deleted"
            if resp.status_code != 200:
                logger.warning(
                    f"[fetcher] {note_id}: HTTP {resp.status_code} "
                    f"(final url: {resp.url})"
                )
                return None, "error"
            metrics = _extract_from_html(note_id, resp.text)
            if metrics is None:
                # _extract_from_html already logged the cause; map to a status
                if "登录" in resp.text and "扫码" in resp.text:
                    return None, "login_required"
                if "笔记不存在" in resp.text or "已删除" in resp.text:
                    return None, "deleted"
                return None, "error"
            return metrics, "ok"
    except Exception as e:
        logger.warning(f"[fetcher] {note_id}: request failed ({type(e).__name__}: {e})")
        return None, "error"
