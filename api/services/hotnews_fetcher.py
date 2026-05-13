# -*- coding: utf-8 -*-
"""热点雷达 — 多源抓取器。

每个 source 是一个 async 函数，返回 list[dict]，每条含：
  {title, url, summary, score, score_label, published_at}
统一由 refresh_source(key) 调度 + 写库 + 去重。

骨架版先接两个稳定源：
  - hn (Hacker News API)
  - github_trending (HTML 解析)
后续可加：36kr / zhihu_hot / weibo_hot / v2ex / juejin / dev_to / ...
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Callable, Dict, List, Optional

import httpx

from . import monitor_db
from . import db as _db

logger = logging.getLogger(__name__)


# ── 源定义 ─────────────────────────────────────────────────────────────────

# key → {label, category, fetcher}
SOURCES: Dict[str, Dict[str, Any]] = {}


def _register(key: str, label: str, category: str):
    """装饰器：注册一个 source。"""
    def deco(fn):
        SOURCES[key] = {"label": label, "category": category, "fetcher": fn}
        return fn
    return deco


# ── Hacker News（最稳，JSON API）───────────────────────────────────────────

@_register("hn", "Hacker News", "code")
async def fetch_hn(limit: int = 30) -> List[Dict[str, Any]]:
    """HN top stories：先拿 id 列表，再批量取详情。"""
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get("https://hacker-news.firebaseio.com/v0/topstories.json")
        ids = r.json()[:limit]

        async def _one(sid: int):
            try:
                d = (await cli.get(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json")).json() or {}
                if d.get("type") != "story":
                    return None
                return {
                    "title": d.get("title") or "",
                    "url": d.get("url") or f"https://news.ycombinator.com/item?id={sid}",
                    "summary": (d.get("text") or "")[:300],
                    "score": int(d.get("score") or 0),
                    "score_label": f"{d.get('score', 0)} points",
                    "published_at": "",
                }
            except Exception:
                return None

        results = await asyncio.gather(*[_one(i) for i in ids])
    return [r for r in results if r and r.get("title")]


# ── GitHub Trending（HTML 解析）─────────────────────────────────────────────

@_register("github_trending", "GitHub Trending", "code")
async def fetch_github_trending(limit: int = 25) -> List[Dict[str, Any]]:
    """抓 https://github.com/trending 当日热门仓库。
    解析每个 <h2 class="h3 lh-condensed"> 块内 owner/repo + 描述 + 星标。
    """
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
        r = await cli.get(
            "https://github.com/trending",
            headers={"User-Agent": "Mozilla/5.0 PulseBot/1.0"},
        )
        html = r.text
    items: List[Dict[str, Any]] = []
    # GitHub Trending HTML 结构演化后 <h2> 后跟的 <a> 中间会插入若干 data-* 属性，
    # 锚点在 h2 + 容器到下个 h2 之间找 href="/owner/repo" + 描述 + stars
    blocks = re.split(r'<h2 class="h3 lh-condensed">', html)[1:]  # 跳过第一个（页面标题）
    for blk in blocks:
        # 一个 trending block 截至下一个明显锚点（约 5000 字符够用）
        chunk = blk[:6000]
        m_href = re.search(r'href="(/[^/"]+/[^/"]+)"', chunk)
        if not m_href:
            continue
        href = m_href.group(1)
        url = f"https://github.com{href}"
        # 仓库名 = href 去掉前导 /
        name = href.lstrip("/")
        # 描述：第一个 <p class="col-9 ...">...</p>
        m_desc = re.search(r'<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)</p>', chunk)
        summary = ""
        if m_desc:
            summary = re.sub(r"<[^>]+>", "", m_desc.group(1)).strip()[:300]
        # 星标：第一个 octicon-star 之后的数字
        stars = 0
        star_label = ""
        m_star = re.search(r'octicon-star[\s\S]{0,500}?>\s*([\d,]+)', chunk)
        if m_star:
            try:
                stars = int(m_star.group(1).replace(",", ""))
                star_label = f"{stars:,} stars"
            except Exception:
                pass
        items.append({
            "title": name,
            "url": url,
            "summary": summary,
            "score": stars,
            "score_label": star_label,
            "published_at": "",
        })
        if len(items) >= limit:
            break
    return items


# ── V2EX 热议（中文社区热门，JSON API，稳定）──────────────────────────────

@_register("v2ex_hot", "V2EX 最热", "tech")
async def fetch_v2ex_hot() -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get("https://www.v2ex.com/api/topics/hot.json",
                          headers={"User-Agent": "Mozilla/5.0 PulseBot/1.0"})
        data = r.json()
    items = []
    for t in data[:30]:
        items.append({
            "title": t.get("title") or "",
            "url": t.get("url") or "",
            "summary": (t.get("content") or "")[:200],
            "score": int(t.get("replies") or 0),
            "score_label": f"{t.get('replies', 0)} 回复",
            "published_at": "",
        })
    return items


# ── 微博热搜（公开 JSON 接口）────────────────────────────────────────────

@_register("weibo_hot", "微博热搜", "entertainment")
async def fetch_weibo_hot() -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
        r = await cli.get(
            "https://weibo.com/ajax/side/hotSearch",
            headers={
                "User-Agent": "Mozilla/5.0 PulseBot/1.0",
                "Referer": "https://weibo.com/",
            },
        )
        try:
            data = r.json()
        except Exception:
            return []
    items = []
    realtime = (data.get("data") or {}).get("realtime") or []
    for x in realtime[:30]:
        title = x.get("word") or x.get("note") or ""
        if not title:
            continue
        # 微博话题搜索页
        from urllib.parse import quote
        url = f"https://s.weibo.com/weibo?q={quote('#' + title + '#')}"
        items.append({
            "title": title,
            "url": url,
            "summary": x.get("subject_label") or "",
            "score": int(x.get("num") or 0),
            "score_label": f"{x.get('num', 0):,} 热度" if x.get("num") else "",
            "published_at": "",
        })
    return items


# ── 36 氪 / 知乎 暂未接入（反爬较严，需要 cookie / 复杂签名）
# TODO（v2.1）：换 newsnow 项目里现成的爬取实现，或者用 RSSHub。


# ── 调度 & 落库 ────────────────────────────────────────────────────────────

async def refresh_source(key: str) -> Dict[str, Any]:
    """跑一个源 → 写库（按 (source, url) 去重，存在则更 score+fetched_at）。"""
    if key not in SOURCES:
        return {"ok": False, "error": f"未知源：{key}"}
    meta = SOURCES[key]
    try:
        items = await meta["fetcher"]()
    except Exception as e:
        logger.warning(f"[hotnews] fetch {key} failed: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    added, updated = 0, 0
    async with _db.connect(monitor_db.DB_PATH) as db:
        for it in items:
            url = (it.get("url") or "").strip()
            if not url or not it.get("title"):
                continue
            async with db.execute(
                "SELECT id FROM hotnews_items WHERE source=? AND url=?", (key, url),
            ) as cur:
                row = await cur.fetchone()
            if row:
                await db.execute(
                    "UPDATE hotnews_items SET title=?, summary=?, score=?, score_label=?, "
                    "fetched_at=datetime('now','localtime') WHERE id=?",
                    (it.get("title", "")[:300], it.get("summary", "")[:1000],
                     int(it.get("score") or 0), it.get("score_label", "")[:50], int(row[0])),
                )
                updated += 1
            else:
                await db.execute(
                    "INSERT INTO hotnews_items(source, source_label, category, title, url, "
                    "summary, score, score_label, published_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (key, meta["label"], meta["category"],
                     it.get("title", "")[:300], url, it.get("summary", "")[:1000],
                     int(it.get("score") or 0), it.get("score_label", "")[:50],
                     it.get("published_at", "")),
                )
                added += 1
        await db.commit()
    return {"ok": True, "source": key, "added": added, "updated": updated, "total": len(items)}


async def refresh_all() -> Dict[str, Any]:
    """跑所有内置源，供 worker cron 用。"""
    results = []
    for key in SOURCES.keys():
        results.append(await refresh_source(key))
    return {"results": results}
