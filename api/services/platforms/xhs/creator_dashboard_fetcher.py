"""小红书创作者中心数据采集（自营运营看板）。

跟监控/爆款的"对外公开数据"不同，这里抓的是用户自己账号在 creator.xiaohongshu.com
后台能看到的私有数据：
  - 粉丝数、粉丝增量
  - 笔记数 / 累计阅读 / 累计互动
  - 当日阅读 / 当日点赞 / 当日收藏 / 当日评论

实现取舍：
  - 用现有 monitor_accounts.cookie（一般是 .xiaohongshu.com 域，creator 子域可共享）
  - Playwright 加载 creator.xiaohongshu.com，拦截内部 API 响应抓数据
  - 内部接口字段易变，所以同时把原始 JSON 存 raw_json，UI 可二次展开
  - 字段抽取走「先按已知关键词扫，找不到给 0」防御性写法，不强校验

后续可以增量加：
  - 各笔记播放/完播/2s 跳出（需逐笔记访问 detail 页）
  - 涨粉来源（关注页/搜索/推荐）
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# 创作者中心后台几个常见接口（命中其中之一就抓 data）
_INTERESTING_PATTERNS = [
    re.compile(r"/api/galaxy/.*overview", re.I),
    re.compile(r"/api/galaxy/.*dashboard", re.I),
    re.compile(r"/api/galaxy/.*creator/info", re.I),
    re.compile(r"/api/galaxy/.*data/note/list", re.I),
    re.compile(r"/api/galaxy/user/dashboard", re.I),
    re.compile(r"/web_api/sns/v.*creator", re.I),
]


def _try_int(v: Any, default: int = 0) -> int:
    if v is None:
        return default
    try:
        if isinstance(v, str):
            v = v.replace(",", "").strip()
            if v.endswith("万"):
                return int(float(v[:-1]) * 10000)
            return int(float(v))
        return int(v)
    except (TypeError, ValueError):
        return default


def _walk_first(obj: Any, keys: Tuple[str, ...]) -> Optional[Any]:
    """深度遍历 dict/list 找到第一个匹配 keys 的值。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys:
                return v
            r = _walk_first(v, keys)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for item in obj:
            r = _walk_first(item, keys)
            if r is not None:
                return r
    return None


def _extract_metrics(payloads: List[Dict]) -> Dict[str, int]:
    """从抓到的所有 API 响应里挖关键字段。字段名按经验列。"""
    merged: Dict[str, Any] = {}
    for p in payloads:
        if isinstance(p, dict):
            merged.setdefault("__list__", []).append(p)
    flat = merged.get("__list__", [])

    def _v(*keys) -> int:
        for src in flat:
            r = _walk_first(src, keys)
            if r is not None:
                return _try_int(r)
        return 0

    return {
        "fans_count":    _v("fans_count", "fansCount", "follower_count", "followers"),
        "fans_delta":    _v("fans_delta", "fansDelta", "new_fans", "fans_increase"),
        "notes_count":   _v("notes_count", "notesCount", "note_count"),
        "total_views":   _v("total_views", "totalViews", "impressions", "view_count"),
        "total_likes":   _v("total_likes", "totalLikes", "like_count"),
        "total_collects":_v("total_collects", "totalCollects", "collect_count"),
        "total_comments":_v("total_comments", "totalComments", "comment_count"),
        "daily_views":   _v("daily_views", "dailyViews", "today_views"),
        "daily_likes":   _v("daily_likes", "dailyLikes", "today_likes"),
        "daily_collects":_v("daily_collects", "dailyCollects", "today_collects"),
        "daily_comments":_v("daily_comments", "dailyComments", "today_comments"),
    }


async def fetch_creator_dashboard(
    account: Dict[str, Any], timeout_ms: int = 25000,
) -> Optional[Dict[str, Any]]:
    """登录创作者中心，抓今天的运营数据快照。

    返回 dict（含 raw_json 字段）；失败返回 None。
    """
    if not account or not account.get("cookie"):
        logger.warning("[creator-dash] account 必须带 cookie")
        return None
    if (account.get("platform") or "xhs") != "xhs":
        return None

    from ...account_browser import open_account_context

    captured: List[Dict[str, Any]] = []

    async with open_account_context(account) as (_browser, context):
        # creator 子域的 cookie：复用账号 cookie（一般 .xiaohongshu.com 域共享子域）
        # 但部分关键 cookie 可能只设到 www 子域，这里再写一份到 creator 域兜底
        try:
            cookie_str = account.get("cookie") or ""
            extras = []
            for part in cookie_str.split(";"):
                part = part.strip()
                if "=" in part:
                    name, _, value = part.partition("=")
                    extras.append({
                        "name": name.strip(),
                        "value": value.strip(),
                        "domain": ".xiaohongshu.com",
                        "path": "/",
                    })
            if extras:
                await context.add_cookies(extras)
        except Exception as e:
            logger.debug(f"[creator-dash] add creator cookies skipped: {e}")

        page = await context.new_page()

        async def on_response(response):
            url = response.url or ""
            if response.status != 200:
                return
            if not any(p.search(url) for p in _INTERESTING_PATTERNS):
                return
            try:
                body = await response.json()
            except Exception:
                return
            if not isinstance(body, dict):
                return
            data = body.get("data") if "data" in body else body
            captured.append(data if isinstance(data, dict) else {"raw": data})

        page.on("response", on_response)

        try:
            await page.goto(
                "https://creator.xiaohongshu.com/creator-zhida/dashboard",
                wait_until="domcontentloaded", timeout=timeout_ms,
            )
            await asyncio.sleep(4)
            # 滚动一下触发额外懒加载
            try:
                await page.mouse.wheel(0, 800)
            except Exception:
                pass
            await asyncio.sleep(3)
        except Exception as e:
            logger.warning(f"[creator-dash] dashboard 加载失败: {e}")

        if not captured:
            try:
                body_text = await page.evaluate(
                    "() => document.body.innerText.slice(0, 200)"
                )
                if "登录" in body_text and ("扫码" in body_text or "登录后查看" in body_text):
                    logger.warning(
                        f"[creator-dash] account '{account.get('name')}' "
                        f"creator 后台 cookie 失效（提示登录）"
                    )
            except Exception:
                pass
            return None

    metrics = _extract_metrics(captured)
    metrics["raw_json"] = json.dumps(captured, ensure_ascii=False)[:200_000]
    metrics["snapshot_date"] = date.today().isoformat()
    return metrics
