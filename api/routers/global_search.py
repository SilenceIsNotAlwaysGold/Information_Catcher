# -*- coding: utf-8 -*-
"""全局搜索：跨三平台搜帖子/作者/直播间。

路由前缀 /monitor/search。前端 ⌘K 弹窗调用，结果分三段返回：
- posts:    全文搜索（title + summary，复用 db.search_posts，已支持多关键词 LIKE）
- creators: list_creators 后内存过滤 name/url（数据量小，<10k）
- lives:    list_lives 后内存过滤 streamer_name/room_url
"""
from typing import Optional

from fastapi import APIRouter, Depends

from ..services import monitor_db as db
from .auth import get_current_user
from .monitor import _scope_uid

router = APIRouter(prefix="/monitor/search", tags=["Search"])


def _post_url(platform: str, note_id: str, fallback: Optional[str]) -> str:
    """依平台规则拼帖子的真实 URL；公众号 note_id 无意义，直接回退到 db 里存的 url。"""
    if platform == "xhs":
        return f"https://www.xiaohongshu.com/explore/{note_id}"
    if platform == "douyin":
        return f"https://www.douyin.com/video/{note_id}"
    # mp / 其他：用数据库里的 url 字段（公众号是 mp.weixin.qq.com 永久链接）
    return fallback or ""


@router.get("", summary="全局搜索：帖子 + 作者 + 直播间")
async def global_search(
    q: str = "",
    limit: int = 20,
    current_user: dict = Depends(get_current_user),
):
    q = (q or "").strip()
    limit = max(1, min(int(limit or 20), 50))

    if len(q) < 1:
        return {"posts": [], "creators": [], "lives": []}

    uid = _scope_uid(current_user)
    q_lower = q.lower()

    # 帖子：用现成的 search_posts（多关键词 LIKE，已带 user_id 隔离）
    post_rows = await db.search_posts(q=q, user_id=uid, limit=limit)
    posts = []
    for r in post_rows:
        platform = r.get("platform") or ""
        note_id = r.get("note_id") or ""
        # XHS / 抖音用规则拼，公众号用 db 里的 note_url / short_url
        fallback = r.get("note_url") or r.get("short_url") or ""
        posts.append({
            "platform": platform,
            "note_id": note_id,
            "title": r.get("title") or "",
            "url": _post_url(platform, note_id, fallback),
            "liked_count": int(r.get("liked_count") or 0),
            "comment_count": int(r.get("comment_count") or 0),
        })

    # 作者：全捞内存过滤（量小）
    creator_rows = await db.list_creators(user_id=uid)
    creators = []
    for r in creator_rows:
        name = (r.get("creator_name") or "").lower()
        url = (r.get("creator_url") or "").lower()
        if q_lower in name or q_lower in url:
            creators.append({
                "platform": r.get("platform") or "",
                "id": int(r.get("id") or 0),
                "name": r.get("creator_name") or "",
                "url": r.get("creator_url") or "",
            })
            if len(creators) >= limit:
                break

    # 直播间：同样全捞内存过滤
    live_rows = await db.list_lives(user_id=uid)
    lives = []
    for r in live_rows:
        name = (r.get("streamer_name") or "").lower()
        url = (r.get("room_url") or "").lower()
        if q_lower in name or q_lower in url:
            lives.append({
                "platform": r.get("platform") or "",
                "id": int(r.get("id") or 0),
                "streamer_name": r.get("streamer_name") or "",
                "url": r.get("room_url") or "",
            })
            if len(lives) >= limit:
                break

    return {"posts": posts, "creators": creators, "lives": lives}
