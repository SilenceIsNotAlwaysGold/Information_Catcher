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
    # P0-7：原来按 `<h2 class="h3 lh-condensed">` 字面量 split，GitHub 一改 class
    # 属性串/顺序就抓 0 条。改为按稳定的 trending 行容器 <article class="Box-row">
    # 切分（class 用 \b...\b 容忍前后其它 class / 属性顺序），并保留宽松 h2 兜底。
    blocks = re.split(r'<article[^>]+class="[^"]*\bBox-row\b[^"]*"[^>]*>', html)[1:]
    if not blocks:
        blocks = re.split(r'<h2[^>]*\blh-condensed\b[^>]*>', html)[1:]
    for blk in blocks:
        # 一个 trending block 截至下一个明显锚点（约 5000 字符够用）
        chunk = blk[:6000]
        m_href = re.search(r'href="(/[^/"\s?#]+/[^/"\s?#]+)"', chunk)
        if not m_href:
            continue
        href = m_href.group(1)
        name = href.lstrip("/")
        # 过滤明显非仓库链接（赞助/登录/话题等）——避免抓到行内其它 /a/b 链接
        if name.split("/")[0].lower() in {
            "login", "sponsors", "topics", "collections", "trending",
            "about", "settings", "marketplace", "features",
        }:
            continue
        url = f"https://github.com{href}"
        # 描述：第一个 <p class="col-9 ...">...</p>
        m_desc = re.search(r'<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)</p>', chunk)
        summary = ""
        if m_desc:
            summary = re.sub(r"<[^>]+>", "", m_desc.group(1)).strip()[:300]
        # 星标：锚定 stargazers 链接（稳），取其 svg 后的数字文本
        # 现 GitHub 结构：<a href="/o/r/stargazers"...><svg.../></svg> 1,234 </a>
        stars = 0
        star_label = ""
        # svg 的 path d="..." 较长（~750 字），上限给到 1800 才能跨过到数字
        m_star = re.search(
            r'href="/[^"]+/stargazers"[\s\S]{0,1800}?</svg>\s*([\d,]+)', chunk)
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


# ── B 站热门视频（开放 JSON）─────────────────────────────────────────────
@_register("bilibili_hot", "B 站热门", "entertainment")
async def fetch_bilibili_hot() -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
        r = await cli.get(
            "https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1",
            headers={
                "User-Agent": "Mozilla/5.0 PulseBot/1.0",
                "Referer": "https://www.bilibili.com/",
            },
        )
        try:
            data = r.json()
        except Exception:
            return []
    items: List[Dict[str, Any]] = []
    for v in ((data.get("data") or {}).get("list") or [])[:30]:
        title = v.get("title") or ""
        bvid = v.get("bvid") or ""
        if not (title and bvid):
            continue
        stat = v.get("stat") or {}
        view = int(stat.get("view") or 0)
        items.append({
            "title": title,
            "url": f"https://www.bilibili.com/video/{bvid}",
            "summary": v.get("desc") or (v.get("owner") or {}).get("name") or "",
            "score": view,
            "score_label": f"{view:,} 播放",
            "published_at": "",
        })
    return items


# ── Solidot（IT 资讯，多年稳定 RSS）─────────────────────────────────────
@_register("solidot", "Solidot", "tech")
async def fetch_solidot() -> List[Dict[str, Any]]:
    return await _fetch_rss("https://www.solidot.org/index.rss", score_label_from_pubdate=True)


# ── 百度热搜（公开 JSON 接口）────────────────────────────────────────────
@_register("baidu_hot", "百度热搜", "entertainment")
async def fetch_baidu_hot() -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
        r = await cli.get(
            "https://top.baidu.com/api/board?platform=wise&tab=realtime",
            headers={"User-Agent": "Mozilla/5.0 PulseBot/1.0",
                     "Referer": "https://top.baidu.com/"},
        )
        try:
            data = r.json()
        except Exception:
            return []
    items: List[Dict[str, Any]] = []
    # data.cards[0].content[0].content  ← 真正的列表（百度套了两层 content）
    try:
        cards_list = (data.get("data") or {}).get("cards") or []
        first_card = cards_list[0] if cards_list else {}
        inner = first_card.get("content") or []
        items_raw = inner[0].get("content") if inner else []
    except Exception:
        items_raw = []
    if not isinstance(items_raw, list):
        items_raw = []
    # 兜底：如果直接是平铺的（不同 platform 可能不一样）
    if not items_raw and isinstance(inner, list) and inner and isinstance(inner[0], dict) and "word" in inner[0]:
        items_raw = inner
    for x in items_raw[:30]:
        title = x.get("word") or x.get("query") or ""
        if not title:
            continue
        url = x.get("url") or x.get("appUrl") or f"https://www.baidu.com/s?wd={title}"
        score = 0
        try:
            score = int(x.get("hotScore") or 0)
        except Exception:
            pass
        items.append({
            "title": title,
            "url": url,
            "summary": (x.get("desc") or "")[:240],
            "score": score,
            "score_label": f"{score:,} 热度" if score else "",
            "published_at": "",
        })
    return items


# ── IT之家 RSS（业内最稳的 RSS 之一）─────────────────────────────────────
@_register("ithome", "IT 之家", "tech")
async def fetch_ithome() -> List[Dict[str, Any]]:
    return await _fetch_rss(
        "https://www.ithome.com/rss/",
        score_label_from_pubdate=True,
    )


# ── 少数派最新（公开 JSON，sspai matrix）────────────────────────────────
@_register("sspai", "少数派 Matrix", "tech")
async def fetch_sspai() -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
        r = await cli.get(
            "https://sspai.com/api/v1/article/index/page/get?limit=30&offset=0&created_at=0&sort=matrix",
            headers={"User-Agent": "Mozilla/5.0 PulseBot/1.0"},
        )
        try:
            data = r.json()
        except Exception:
            return []
    items: List[Dict[str, Any]] = []
    for x in (data.get("data") or [])[:30]:
        title = x.get("title") or ""
        aid = x.get("id")
        if not (title and aid):
            continue
        like = int(x.get("like_count") or 0)
        items.append({
            "title": title,
            "url": f"https://sspai.com/post/{aid}",
            "summary": (x.get("summary") or "")[:240],
            "score": like,
            "score_label": f"{like} 赞" if like else "",
            "published_at": "",
        })
    return items


# ── 通用 RSS 解析（标准 RSS 2.0 / Atom 都吃）─────────────────────────────

async def _fetch_rss(url: str, *, score_label_from_pubdate: bool = False) -> List[Dict[str, Any]]:
    """简陋但够用的 RSS 解析（不引第三方库，避免增加依赖）。"""
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as cli:
        r = await cli.get(url, headers={"User-Agent": "Mozilla/5.0 PulseBot/1.0"})
        text = r.text
    items: List[Dict[str, Any]] = []
    # 切 <item> 或 <entry>
    chunks = re.findall(r"<item\b[\s\S]*?</item>", text, flags=re.I)
    if not chunks:
        chunks = re.findall(r"<entry\b[\s\S]*?</entry>", text, flags=re.I)

    def _extract(tag: str, blk: str) -> str:
        # 兼容 <title>x</title> 和 <title><![CDATA[x]]></title>
        m = re.search(rf"<{tag}\b[^>]*>([\s\S]*?)</{tag}>", blk, flags=re.I)
        if not m:
            return ""
        s = m.group(1).strip()
        s = re.sub(r"^<!\[CDATA\[", "", s)
        s = re.sub(r"\]\]>$", "", s)
        s = re.sub(r"<[^>]+>", "", s)
        return s.strip()

    for blk in chunks[:30]:
        title = _extract("title", blk)
        if not title:
            continue
        # link 可能是 <link>...</link> 或 atom 风格 <link href="..."/>
        url2 = _extract("link", blk)
        if not url2:
            m = re.search(r'<link[^>]*href="([^"]+)"', blk, flags=re.I)
            if m:
                url2 = m.group(1)
        if not url2:
            continue
        desc = _extract("description", blk) or _extract("summary", blk) or _extract("content", blk)
        pub = _extract("pubDate", blk) or _extract("published", blk) or _extract("updated", blk)
        items.append({
            "title": title[:300],
            "url": url2,
            "summary": desc[:240],
            "score": 0,
            "score_label": pub[:30] if score_label_from_pubdate else "",
            "published_at": pub,
        })
    return items


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
