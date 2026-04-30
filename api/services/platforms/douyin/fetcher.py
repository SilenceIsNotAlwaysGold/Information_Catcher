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

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urlparse

import httpx

from ..base import Platform

logger = logging.getLogger(__name__)


from .._ua_pool import random_mobile_ua, MOBILE_UAS

# 默认 UA（保持向后兼容，verify_proxy_chain 等内部脚本会引用）
_UA_IPHONE = MOBILE_UAS[0]


def _request_headers() -> dict:
    """每次请求随机一个 UA，降低被风控按 UA 频次的概率。"""
    return {
        "User-Agent": random_mobile_ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.iesdouyin.com/",
    }


# 向后兼容：旧代码引用 _HEADERS（如 verify_proxy_chain.py）。
# 新代码用 _request_headers() 拿随机 UA。
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
            r = await c.get(short_url, headers=_request_headers())
            final = str(r.url)
    except Exception as e:
        logger.warning(f"[douyin] short-link resolve fail: {e}")
        return None
    return _extract_aweme_id_from_url(final)


def _parse_router_data(html: str) -> Optional[Dict[str, Any]]:
    """从 HTML 抠出 window._ROUTER_DATA = {...} 并解 JSON。

    注意：HTML 里 `_ROUTER_DATA = ...` 后面接的是 JS 代码而不是干净 JSON 结尾，
    必须用 raw_decode 容忍剩余字符。
    """
    m = re.search(r'_ROUTER_DATA\s*=\s*(\{.+)', html, re.DOTALL)
    if not m:
        return None
    raw = m.group(1)
    try:
        decoder = json.JSONDecoder()
        data, _end = decoder.raw_decode(raw)
        return data
    except Exception as e:
        logger.warning(f"[douyin] _ROUTER_DATA parse fail: {e}")
        return None


def _find_aweme_detail(data: Dict[str, Any], aweme_id: str) -> Optional[Dict[str, Any]]:
    """_ROUTER_DATA → loaderData → "video_(id)/page" → videoInfoRes → item_list[0]"""
    try:
        loader = (data or {}).get("loaderData") or {}
    except AttributeError:
        return None
    # key 名带括号：'video_(id)/page'，先精确取，没有就遍历
    page = loader.get("video_(id)/page")
    if not isinstance(page, dict):
        for k, v in loader.items():
            if isinstance(v, dict) and "videoInfoRes" in v:
                page = v
                break
    if not isinstance(page, dict):
        return None
    info = page.get("videoInfoRes") or {}
    items = info.get("item_list") if isinstance(info, dict) else None
    if not items or not isinstance(items, list):
        return None
    # item_list 通常只有 1 条；id 不一致也接受（避免老缓存）
    for item in items:
        if isinstance(item, dict) and (item.get("desc") or item.get("video")):
            return item
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
                r = await c.get(url, headers=_request_headers())
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
        # 真实验证墙才算 login_required（avoid SDK 脚本里的 verify/captcha 字符串误伤）
        if "安全验证" in r.text or "滑块验证" in r.text or "captcha-verify-image" in r.text:
            return None, "login_required"
        data = _parse_router_data(r.text)
        if not data:
            logger.warning(f"[douyin] {aid}: 无 _ROUTER_DATA, head={r.text[:160]!r}")
            return None, "error"
        detail = _find_aweme_detail(data, aid)
        if not detail:
            logger.warning(f"[douyin] {aid}: _ROUTER_DATA 无 item_list / detail")
            return None, "error"

        stats = detail.get("statistics") or {}
        author = detail.get("author") or {}
        video = detail.get("video") or {}
        # 视频流 url：play_addr.url_list[0]
        play = video.get("play_addr") or {}
        url_list = play.get("url_list") if isinstance(play, dict) else None
        video_url = url_list[0] if url_list else ""
        # 无水印版本：playwm → play 替换（实测 2026-04 仍然有效）
        video_url_clean = video_url.replace("/aweme/v1/playwm/", "/aweme/v1/play/") if video_url else ""
        # 封面
        cover = video.get("cover") or video.get("origin_cover") or {}
        cl = cover.get("url_list") if isinstance(cover, dict) else None
        cover_url = cl[0] if cl else ""

        title = detail.get("desc") or ""

        # 话题：优先 cha_list，没有就 desc 里 #xxx 提取
        tags: list = []
        for c in (detail.get("cha_list") or []):
            if isinstance(c, dict):
                name = c.get("cha_name") or ""
                if name:
                    tags.append(name)
        if not tags and title:
            tags = re.findall(r"#([^\s#@\[\]]{1,20})", title)

        # 配乐：抖音视频独有的「同款原声」入口
        music = detail.get("music") or {}
        music_title = music.get("title") if isinstance(music, dict) else ""
        music_id = music.get("id") or music.get("mid") if isinstance(music, dict) else None

        return ({
            "title": title[:200],
            "desc": title[:5000],
            "tags": tags[:20],
            "music_title": music_title or "",
            "music_id": str(music_id) if music_id else "",
            "liked_count": _parse_count(stats.get("digg_count")),
            "collected_count": _parse_count(stats.get("collect_count")),
            "comment_count": _parse_count(stats.get("comment_count")),
            "share_count": _parse_count(stats.get("share_count")),
            "cover_url": cover_url,
            "images": [],
            "video_url": video_url,
            "video_url_clean": video_url_clean,
            "note_type": "video",
            "author": author.get("nickname") or "",
        }, "ok")

    async def search_trending(
        self, keyword: str, account: Dict[str, Any], min_likes: int = 0,
    ) -> List[Dict[str, Any]]:
        """关键词搜索抖音热门视频。

        实现：用账号 cookie 在 Playwright 里加载 douyin.com/search 页，
        让浏览器自己签 X-Bogus / a_bogus，拦截 /aweme/v1/web/search/item 响应。

        要求：account.platform='douyin' 且 cookie 含 sessionid_ss/sessionid。
        """
        if not account or not account.get("cookie"):
            logger.warning("[douyin] search 需要带 cookie 的账号")
            return []
        if (account.get("platform") or "xhs") != "douyin":
            logger.warning(f"[douyin] search 账号 platform={account.get('platform')} 非抖音")
            return []

        from urllib.parse import quote
        from ...account_browser import open_account_context

        collected: List[Dict[str, Any]] = []

        async with open_account_context(account) as (_browser, context):
            page = await context.new_page()

            async def on_response(response):
                # 拦截搜索接口（多个 endpoint 名都可能命中）
                url = response.url or ""
                if "search/item" not in url and "search/general/multi" not in url:
                    return
                if response.status != 200:
                    return
                try:
                    body = await response.json()
                except Exception:
                    return
                items = body.get("data", []) or []
                for item in items:
                    aweme = item.get("aweme_info") or item.get("aweme") or item
                    if not isinstance(aweme, dict):
                        continue
                    aid = aweme.get("aweme_id") or aweme.get("awemeId")
                    if not aid:
                        continue
                    stats = aweme.get("statistics") or {}
                    digg = _parse_count(stats.get("digg_count"))
                    if digg < min_likes:
                        continue
                    author = aweme.get("author") or {}
                    video = aweme.get("video") or {}
                    cover = video.get("cover") or {}
                    cover_list = cover.get("url_list") if isinstance(cover, dict) else None
                    play = video.get("play_addr") or {}
                    play_list = play.get("url_list") if isinstance(play, dict) else None
                    title = (aweme.get("desc") or "")[:200]
                    collected.append({
                        "note_id": aid,
                        "title": title,
                        "desc_text": aweme.get("desc") or "",
                        "xsec_token": "",
                        "note_url": f"https://www.iesdouyin.com/share/video/{aid}/",
                        "liked_count": digg,
                        "collected_count": _parse_count(stats.get("collect_count")),
                        "comment_count": _parse_count(stats.get("comment_count")),
                        "author": author.get("nickname") or "",
                        "cover_url": (cover_list[0] if cover_list else ""),
                        "images": [],
                        "video_url": (play_list[0] if play_list else ""),
                        "note_type": "video",
                    })

            page.on("response", on_response)

            try:
                # 先访问首页让 cookie 加载
                await page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(2)
                # 搜索页 URL
                search_url = f"https://www.douyin.com/search/{quote(keyword)}?type=video"
                async with page.expect_response(
                    lambda r: ("search/item" in r.url or "search/general/multi" in r.url) and r.status == 200,
                    timeout=20000,
                ):
                    await page.goto(search_url, wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(3)
            except Exception as e:
                logger.warning(f"[douyin] search '{keyword}' 加载失败: {e}")

        logger.info(f"[douyin] keyword='{keyword}' found {len(collected)} videos >= {min_likes} likes")
        return collected

    async def fetch_creator_posts(
        self, creator_url: str, account: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """抓博主主页发布列表。

        URL 形如 https://www.douyin.com/user/{sec_uid}
        实现：用账号 cookie 在 Playwright 里加载主页，拦截 /aweme/v1/web/aweme/post API
        让浏览器自己签 X-Bogus。
        """
        if not account or not account.get("cookie"):
            logger.warning("[douyin] creator追新 需要带 cookie 的账号")
            return []
        if (account.get("platform") or "xhs") != "douyin":
            logger.warning(f"[douyin] creator account platform={account.get('platform')} 非抖音")
            return []

        from ...account_browser import open_account_context

        # 解析 sec_uid（拿来取昵称用，不强校验）
        sec_uid_match = re.search(r"/user/([^/?#]+)", creator_url or "")
        sec_uid = sec_uid_match.group(1) if sec_uid_match else ""

        collected: List[Dict[str, Any]] = []
        creator_name = ""

        async with open_account_context(account) as (_browser, context):
            page = await context.new_page()

            async def on_response(response):
                url = response.url or ""
                if "aweme/post" not in url or response.status != 200:
                    return
                try:
                    body = await response.json()
                except Exception:
                    return
                aweme_list = body.get("aweme_list") or []
                nonlocal creator_name
                for aw in aweme_list:
                    if not isinstance(aw, dict):
                        continue
                    aid = aw.get("aweme_id") or aw.get("awemeId")
                    if not aid:
                        continue
                    author = aw.get("author") or {}
                    if not creator_name:
                        creator_name = author.get("nickname") or ""
                    desc = aw.get("desc") or ""
                    create_time = aw.get("create_time") or 0
                    collected.append({
                        "post_id": str(aid),
                        "url": f"https://www.douyin.com/video/{aid}",
                        "title": desc[:200],
                        "creator_name": creator_name,
                        "published_at": int(create_time) if create_time else 0,
                        "xsec_token": "",
                    })

            page.on("response", on_response)

            try:
                await page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(2)
                target = creator_url
                if not target.startswith("http"):
                    target = f"https://www.douyin.com/user/{sec_uid}" if sec_uid else f"https://www.douyin.com/{target}"
                async with page.expect_response(
                    lambda r: "aweme/post" in r.url and r.status == 200,
                    timeout=20000,
                ):
                    await page.goto(target, wait_until="domcontentloaded", timeout=15000)
                await asyncio.sleep(3)
            except Exception as e:
                logger.warning(f"[douyin] creator '{creator_url}' 加载失败: {e}")

        logger.info(f"[douyin] creator='{creator_url}' fetched {len(collected)} posts")
        return collected
