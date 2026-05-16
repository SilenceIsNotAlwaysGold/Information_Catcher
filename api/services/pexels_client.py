# -*- coding: utf-8 -*-
"""Pexels 图片搜索客户端（免费 API，注册即给 key）。

用途：AI PPT 的 image_right / cover 布局根据 image_query 拉一张配图。
计费：不耗 AI 点（Pexels 免费 200 req/h、20000 req/月，对单用户够用）。

Key 来源（按优先级）：
  1. monitor_settings['pexels_api_key']  ← admin 后台填
  2. PEXELS_API_KEY 环境变量              ← 兜底

缓存：进程内 LRU（query→(image_bytes, url)），生命周期 1 小时；防止同次 PPT
渲染时多个 image_right 用同关键词反复打外网。
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional, Tuple

import httpx

from . import monitor_db

logger = logging.getLogger(__name__)

# query → (fetched_at, image_bytes, source_url)。最大 64 条，老的踢掉
_CACHE: dict = {}
_CACHE_MAX = 64
_CACHE_TTL = 3600  # 1h


async def _get_api_key() -> str:
    """admin 设的优先，环境变量兜底。"""
    try:
        v = (await monitor_db.get_setting("pexels_api_key", "")).strip()
        if v:
            return v
    except Exception:
        pass
    return os.getenv("PEXELS_API_KEY", "").strip()


def _cache_get(query: str) -> Optional[Tuple[bytes, str]]:
    rec = _CACHE.get(query)
    if not rec:
        return None
    ts, blob, url = rec
    if time.time() - ts > _CACHE_TTL:
        _CACHE.pop(query, None)
        return None
    return (blob, url)


def _cache_put(query: str, blob: bytes, url: str):
    if len(_CACHE) >= _CACHE_MAX:
        # 删最老
        oldest = min(_CACHE.items(), key=lambda kv: kv[1][0])[0]
        _CACHE.pop(oldest, None)
    _CACHE[query] = (time.time(), blob, url)


async def search_one(query: str, *, orientation: str = "landscape") -> Optional[Tuple[bytes, str]]:
    """搜一张图：返回 (image_bytes, source_url)，失败/没 key/没结果都返回 None。

    orientation: 'landscape' | 'portrait' | 'square'
    """
    q = (query or "").strip()
    if not q:
        return None
    cached = _cache_get(q)
    if cached:
        return cached
    api_key = await _get_api_key()
    if not api_key:
        logger.debug("[pexels] api key 未配置；search 跳过 query=%s", q)
        return None
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
            r = await cli.get(
                "https://api.pexels.com/v1/search",
                params={"query": q, "per_page": 5, "orientation": orientation},
                headers={"Authorization": api_key},
            )
            if r.status_code != 200:
                logger.warning("[pexels] search 状态 %s for q=%s: %s", r.status_code, q, r.text[:200])
                return None
            data = r.json()
            photos = data.get("photos") or []
            if not photos:
                return None
            # 取第一张的 large 尺寸（约 940×650，足够 PPT 用）
            src = photos[0].get("src") or {}
            img_url = src.get("large") or src.get("medium") or src.get("original")
            page_url = photos[0].get("url") or ""
            if not img_url:
                return None
            # 下载图片本体
            img_r = await cli.get(img_url)
            if img_r.status_code != 200 or not img_r.content:
                return None
            blob = img_r.content
            _cache_put(q, blob, page_url)
            return (blob, page_url)
    except Exception as exc:
        logger.warning("[pexels] search 异常 q=%s: %s", q, exc)
        return None
