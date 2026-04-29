"""
公众号 (mp.weixin.qq.com) 平台实现 - v1：URL 监控 + 静态详情。

通道：mp.weixin.qq.com/s?__biz=...&mid=...&idx=... 完全匿名可达。
HTML 内嵌 JS 全局变量：msg_title / msg_desc / nickname / biz / mid / idx /
                        msg_cdn_url / ct（时间戳）/ copyright_stat / msg_source_url
正文：<div id="js_content"> ... </div>

不实现：
  - search_trending：公众号无公开搜索
  - 阅读数 / 在看数：需要客户端凭证（uin/key/pass_ticket），单独 issue #22
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs, unquote

import httpx

from ..base import Platform

logger = logging.getLogger(__name__)


from .._ua_pool import random_mobile_ua


def _request_headers() -> dict:
    return {
        "User-Agent": random_mobile_ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }


def _build_post_id(biz: str, mid: str, idx: str) -> str:
    """公众号文章用 (biz, mid, idx) 三元组唯一标识。拼成单字符串作 note_id。"""
    return f"{biz}__{mid}__{idx}"


def _split_post_id(post_id: str) -> Optional[tuple[str, str, str]]:
    parts = (post_id or "").split("__")
    if len(parts) != 3:
        return None
    return parts[0], parts[1], parts[2]


def _extract_ids_from_url(url: str) -> Optional[Dict[str, str]]:
    """从 mp.weixin.qq.com URL 抽 biz/mid/idx。

    支持两种形态：
      - /s?__biz=xxx&mid=xxx&idx=1&...
      - /s/SHORT_HASH （无参数短链，需要先访问跟随 30x）
    """
    try:
        p = urlparse(url)
    except Exception:
        return None
    if "mp.weixin.qq.com" not in (p.hostname or ""):
        return None
    qs = parse_qs(p.query)
    biz = (qs.get("__biz") or [""])[0]
    mid = (qs.get("mid") or [""])[0]
    idx = (qs.get("idx") or [""])[0]
    if biz and mid and idx:
        return {"biz": biz, "mid": mid, "idx": idx}
    # /s/HASH 形态：没有 query 参数，需要 follow 拿真实 URL
    return None


def _parse_js_var(html: str, name: str) -> str:
    """提取 `var xxx = "..."` 或 `xxx: "..."` 格式的 JS 变量值。"""
    # var msg_title = '...'  或  var msg_title = "..."
    m = re.search(rf'var\s+{name}\s*=\s*["\']([^"\']*)["\']', html)
    if m:
        return m.group(1).strip()
    # 兜底：去掉引号情况
    m = re.search(rf'var\s+{name}\s*=\s*([^;\n]+)\s*;', html)
    if m:
        v = m.group(1).strip().strip("\"'")
        return v
    return ""


def _strip_html(s: str) -> str:
    """简易 HTML strip。仅用于摘要预览。"""
    s = re.sub(r"<script[^>]*>.*?</script>", " ", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<style[^>]*>.*?</style>", " ", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _extract_body(html: str) -> tuple[str, list[str]]:
    """抽 #js_content 正文和图片列表。返回 (纯文本预览, 图片 URL 列表)"""
    m = re.search(
        r'<div[^>]+id="js_content"[^>]*>(.*?)</div>\s*<(?:div|script)',
        html, re.DOTALL,
    )
    if not m:
        return "", []
    raw = m.group(1)
    # 收集图片
    imgs = re.findall(r'data-src="([^"]+)"', raw) or re.findall(r'src="(https?://mmbiz[^"]+)"', raw)
    return _strip_html(raw), imgs[:20]


class MpPlatform(Platform):
    name = "mp"
    label = "公众号"
    url_hints = ["mp.weixin.qq.com"]

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        link = (raw_url or "").strip()
        if not link:
            return None

        ids = _extract_ids_from_url(link)
        # 短链 /s/HASH 没参数 → 跟随一次 30x 拿真实 URL
        if not ids:
            try:
                async with httpx.AsyncClient(timeout=12, follow_redirects=True, max_redirects=3) as c:
                    r = await c.get(link, headers=_request_headers())
                    final = str(r.url)
                ids = _extract_ids_from_url(final)
                if ids:
                    link = final
            except Exception as e:
                logger.warning(f"[mp] short-link follow fail: {e}")
                return None

        if not ids:
            return None
        post_id = _build_post_id(ids["biz"], ids["mid"], ids["idx"])
        return {
            "platform": self.name,
            "post_id": post_id,
            "url": link,
        }

    async def fetch_detail(
        self, post: Dict[str, Any], account: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        # 优先用 post 里存的 URL；没有就根据 post_id 重建
        url = post.get("url") or post.get("note_url")
        if not url:
            ids = _split_post_id(post.get("post_id") or post.get("note_id") or "")
            if not ids:
                return None, "error"
            biz, mid, idx = ids
            url = f"https://mp.weixin.qq.com/s?__biz={biz}&mid={mid}&idx={idx}"

        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, max_redirects=5) as c:
                r = await c.get(url, headers=_request_headers())
        except Exception as e:
            logger.warning(f"[mp] request fail: {e}")
            return None, "error"

        if r.status_code != 200:
            return None, "error"

        text = r.text
        # 文章被删 / 违规
        if "环境异常" in text or "无法查看" in text or "已被发布者删除" in text:
            return None, "deleted"
        # 没有 msg_title 通常说明命中风控验证页
        title = _parse_js_var(text, "msg_title")
        if not title:
            # 兜底：尝试 og:title meta
            m = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', text)
            if m:
                title = m.group(1).strip()
        if not title:
            logger.warning(f"[mp] 无 msg_title, head={text[:160]!r}")
            return None, "error"

        desc = _parse_js_var(text, "msg_desc") or _parse_js_var(text, "msg_link")
        nickname = _parse_js_var(text, "nickname") or _parse_js_var(text, "user_name")
        cdn = _parse_js_var(text, "msg_cdn_url")
        ct = _parse_js_var(text, "ct")  # 发布时间戳（秒）
        copyright_stat = _parse_js_var(text, "copyright_stat")  # "11" = 原创
        source_url = _parse_js_var(text, "msg_source_url")  # 转载来源

        body_preview, body_imgs = _extract_body(text)
        # desc 留 200 字预览，正文最多 5000 给 AI 摘要
        body_for_ai = body_preview[:5000]

        return ({
            "title": title[:200],
            # 正文太长时把摘要+正文都塞 desc 字段（schema 已是 5000 上限）
            "desc": (desc + "\n\n" + body_for_ai).strip()[:5000],
            # 公众号没有点赞收藏（v1）；阅读数走单独 issue #22
            "liked_count": 0,
            "collected_count": 0,
            "comment_count": 0,
            "share_count": 0,
            "cover_url": cdn,
            "images": body_imgs,
            "video_url": "",
            "note_type": "article",
            "author": nickname,
            # 公众号专属字段（前端可选展示）
            "publish_ts": int(ct) if (ct and ct.isdigit()) else 0,
            "copyright_stat": copyright_stat,
            "source_url": source_url,
        }, "ok")
