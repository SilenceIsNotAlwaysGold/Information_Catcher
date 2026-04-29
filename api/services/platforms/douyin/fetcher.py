"""
抖音平台实现：分享链接解析 + 详情页匿名抓取。

核心通道：iesdouyin.com 移动端分享页（PC UA 会被劫持，必须 mobile UA）
  GET https://www.iesdouyin.com/share/video/{aweme_id}/
  返回 HTML 内嵌 <script id="RENDER_DATA">...urlencoded JSON...</script>

短链：v.douyin.com/xxx/ → 30x 跳转拿 aweme_id
长链：www.douyin.com/video/{id}  或  iesdouyin.com/share/video/{id}/

不实现 search_trending（抖音搜索 API 需 X-Bogus 签名，留待 #10 后续 milestone）
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

import httpx

from ..base import Platform

logger = logging.getLogger(__name__)


_UA_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
)

_HEADERS = {
    "User-Agent": _UA_IPHONE,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://www.iesdouyin.com/",
}


def _parse_count(value) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).replace(",", "").strip()
    if not s:
        return 0
    if s.endswith("万"):
        try:
            return int(float(s[:-1]) * 10000)
        except ValueError:
            return 0
    if s.endswith("w") or s.endswith("W"):
        try:
            return int(float(s[:-1]) * 10000)
        except ValueError:
            return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def _extract_aweme_id_from_url(url: str) -> Optional[str]:
    """从抖音长链直接提取 aweme_id，不命中返回 None。"""
    try:
        p = urlparse(url)
    except Exception:
        return None
    host = (p.hostname or "").lower()
    parts = [seg for seg in p.path.strip("/").split("/") if seg]
    # www.douyin.com/video/{id}
    if "douyin.com" in host and len(parts) >= 2 and parts[0] == "video":
        return parts[1]
    # iesdouyin.com/share/video/{id}/
    if "iesdouyin.com" in host and len(parts) >= 3 and parts[0] == "share" and parts[1] == "video":
        return parts[2]
    # discovery / note 等其他形态可拓展
    return None


async def _resolve_short_link(short_url: str) -> Optional[str]:
    """v.douyin.com/xxx → 跟随 30x 拿到带 aweme_id 的真实 URL。"""
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True, max_redirects=5) as c:
            r = await c.get(short_url, headers=_HEADERS)
            final = str(r.url)
    except Exception as e:
        logger.warning(f"[douyin] short-link resolve fail: {e}")
        return None
    return _extract_aweme_id_from_url(final)


def _parse_render_data(html: str) -> Optional[Dict[str, Any]]:
    """从 HTML 抠出 RENDER_DATA 并解 JSON。"""
    m = re.search(
        r'<script[^>]*id="RENDER_DATA"[^>]*>([^<]+)</script>',
        html,
    )
    if not m:
        return None
    try:
        return json.loads(unquote(m.group(1)))
    except Exception as e:
        logger.warning(f"[douyin] RENDER_DATA parse fail: {e}")
        return None


def _find_aweme_detail(data: Dict[str, Any], aweme_id: str) -> Optional[Dict[str, Any]]:
    """RENDER_DATA 顶层是 {idx: {...aweme: {detail: {...}}}}，遍历找出 detail。"""
    for v in (data or {}).values():
        if not isinstance(v, dict):
            continue
        aw = v.get("aweme")
        if not isinstance(aw, dict):
            continue
        detail = aw.get("detail") or aw.get("detailItem") or {}
        if isinstance(detail, dict) and detail.get("awemeId") == aweme_id:
            return detail
        # 部分版本字段名 aweme_id
        if isinstance(detail, dict) and detail.get("aweme_id") == aweme_id:
            return detail
        if isinstance(detail, dict) and detail.get("itemId") == aweme_id:
            return detail
        # 兜底：返回第一个看起来像 detail 的对象
        if isinstance(detail, dict) and (detail.get("desc") or detail.get("video")):
            return detail
    return None


class DouyinPlatform(Platform):
    name = "douyin"
    label = "抖音"
    url_hints = ["douyin.com", "iesdouyin.com"]

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        link = (raw_url or "").strip()
        if not link:
            return None
        # 先看长链能不能直接抠 ID
        aid = _extract_aweme_id_from_url(link)
        if not aid and "v.douyin.com" in link:
            aid = await _resolve_short_link(link)
        if not aid:
            return None
        return {
            "platform": self.name,
            "post_id": aid,
            "url": f"https://www.iesdouyin.com/share/video/{aid}/",
        }

    async def fetch_detail(
        self, post: Dict[str, Any], account: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        aid = post.get("post_id") or post.get("note_id")
        if not aid:
            return None, "error"
        url = f"https://www.iesdouyin.com/share/video/{aid}/"
        # account 这里暂不使用（匿名通道已可达）；保留参数兼容 Platform 接口
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as c:
                r = await c.get(url, headers=_HEADERS)
        except Exception as e:
            logger.warning(f"[douyin] {aid}: request error {e}")
            return None, "error"
        if r.status_code in (301, 302, 303, 307, 308):
            loc = r.headers.get("location", "")
            if "verify" in loc.lower() or "captcha" in loc.lower():
                logger.warning(f"[douyin] {aid}: 验证墙 → {loc[:80]}")
                return None, "login_required"
            logger.warning(f"[douyin] {aid}: unexpected {r.status_code} → {loc[:80]}")
            return None, "error"
        if r.status_code == 404:
            return None, "deleted"
        if r.status_code != 200:
            return None, "error"
        body_low = r.text.lower()
        if ("verify" in body_low and "captcha" in body_low) or ("验证码" in r.text):
            return None, "login_required"
        data = _parse_render_data(r.text)
        if not data:
            logger.warning(f"[douyin] {aid}: 无 RENDER_DATA, head={r.text[:160]!r}")
            return None, "error"
        detail = _find_aweme_detail(data, aid)
        if not detail:
            return None, "error"

        stats = detail.get("statistics") or detail.get("stats") or {}
        author = detail.get("author") or {}
        video = detail.get("video") or {}
        # 视频流 url：play_addr.url_list[0]，部分字段叫 playAddr
        play = (
            video.get("play_addr") or video.get("playAddr")
            or video.get("play") or {}
        )
        url_list = play.get("url_list") if isinstance(play, dict) else None
        if not url_list and isinstance(play, dict):
            url_list = play.get("urlList")
        video_url = url_list[0] if url_list else ""
        # 封面
        cover = video.get("cover") or video.get("origin_cover") or video.get("originCover") or {}
        if isinstance(cover, dict):
            cl = cover.get("url_list") or cover.get("urlList") or []
            cover_url = cl[0] if cl else ""
        else:
            cover_url = ""

        title = detail.get("desc") or ""
        return ({
            "title": title[:200],
            "desc": title[:5000],
            "liked_count": _parse_count(
                stats.get("digg_count") or stats.get("diggCount")
            ),
            "collected_count": _parse_count(
                stats.get("collect_count") or stats.get("collectCount")
            ),
            "comment_count": _parse_count(
                stats.get("comment_count") or stats.get("commentCount")
            ),
            "share_count": _parse_count(
                stats.get("share_count") or stats.get("shareCount")
            ),
            "cover_url": cover_url,
            "images": [],
            "video_url": video_url,
            "note_type": "video",
            "author": author.get("nickname") or author.get("name") or "",
        }, "ok")

    async def search_trending(
        self, keyword: str, account: Dict[str, Any], min_likes: int = 0,
    ) -> List[Dict[str, Any]]:
        # 抖音搜索需 X-Bogus 签名，作为单独 milestone 实现
        raise NotImplementedError("抖音搜索功能开发中（需要 X-Bogus 签名拦截）")
