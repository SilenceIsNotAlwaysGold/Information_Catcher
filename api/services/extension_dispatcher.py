"""扩展任务派发与结果落库 — 高层 service 层。

提供两类高层接口：
  - dispatch_xhs_search  / dispatch_douyin_search  ：给定 user_id + keyword，
    通过 ws 派任务给该用户的在线扩展，等结果回来 → 自动写入 trending_posts
  - has_online_extension(user_id)：scheduler 在做"扩展优先"决策时查询用

这些接口对调用方屏蔽了 ws/registry 细节，只暴露同步 await 风格。
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

from . import monitor_db

logger = logging.getLogger(__name__)


def _registry():
    """延迟导入避免循环依赖。"""
    from ..routers.extension import registry
    return registry


def has_online_extension(user_id: int) -> bool:
    return _registry().online_count(int(user_id)) > 0


def online_count(user_id: int) -> int:
    return _registry().online_count(int(user_id))


# ── 错误码翻译 ──────────────────────────────────────────────────────────────

# 扩展端 classifyFailure() 会把抓取失败原因归类为这几个稳定 code，后端在这里
# 翻译成用户友好的中文提示。增加新 code 时同步更新这张表。
_ERROR_CODE_MESSAGES = {
    "captcha_required": (
        "触发了平台滑块验证。请在浏览器里打开该平台手动通过一次滑块（任意页面操作即可），"
        "通常 5–10 分钟后再重试就能恢复。"
    ),
    "login_required": (
        "浏览器未登录该平台（已被跳转到登录页）。请在浏览器登录账号后重试。"
    ),
    "no_response_captured": (
        "未捕获到目标接口响应（可能已触发风控或网络异常）。建议降低任务频率，"
        "或在浏览器手动浏览几分钟后再试。"
    ),
    "no online extension": (
        "未检测到在线浏览器扩展。请先安装 TrendPulse Helper 并保持浏览器登录。"
    ),
}


def translate_error(raw: str) -> str:
    """把 raw error code 转成中文用户提示。未识别的 code 原样返回。"""
    if not raw:
        return "抓取失败（未知原因）"
    # registry 失败时可能返 'task xxx timeout after Ns'，归到 no_response
    if "timeout" in raw.lower():
        return f"扩展抓取超时（{raw}）。建议稍后重试或降低任务频率。"
    return _ERROR_CODE_MESSAGES.get(raw.strip(), raw)


async def dispatch_xhs_search(
    *,
    user_id: int,
    keyword: str,
    min_likes: int = 0,
    timeout_ms: int = 30000,
    pages: int = 2,
    overall_timeout: float = 90.0,
) -> Dict[str, Any]:
    """通过扩展派 1 次 XHS 关键词搜索，结果落 trending_posts。

    返回:
      {"ok": True, "captured": N, "inserted": M, "updated": K, "raw_hits": ...}
      或 {"ok": False, "error": "...", "stage": "..."}
    """
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}

    task = {
        "id": uuid.uuid4().hex,
        "type": "xhs.search",
        "payload": {
            "keyword": keyword,
            "min_likes": min_likes,
            "timeout_ms": timeout_ms,
            "pages": pages,
        },
    }
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        logger.warning(f"[ext-dispatch] xhs.search user={user_id} kw={keyword!r} dispatch failed: {e}")
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}

    notes = (result or {}).get("notes") or []
    inserted, updated = await ingest_xhs_notes(user_id=user_id, keyword=keyword, notes=notes)
    return {
        "ok": True,
        "captured": len(notes),
        "inserted": inserted,
        "updated": updated,
        "raw_hits": (result or {}).get("raw_hits", 0),
    }


async def dispatch_douyin_search(
    *,
    user_id: int,
    keyword: str,
    min_likes: int = 0,
    timeout_ms: int = 30000,
    pages: int = 2,
    overall_timeout: float = 90.0,
) -> Dict[str, Any]:
    """通过扩展派 1 次抖音关键词搜索 (P4 阶段实现)。"""
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}

    task = {
        "id": uuid.uuid4().hex,
        "type": "douyin.search",
        "payload": {
            "keyword": keyword,
            "min_likes": min_likes,
            "timeout_ms": timeout_ms,
            "pages": pages,
        },
    }
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        logger.warning(f"[ext-dispatch] douyin.search user={user_id} kw={keyword!r} dispatch failed: {e}")
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}

    notes = (result or {}).get("notes") or []
    inserted, updated = await ingest_douyin_notes(user_id=user_id, keyword=keyword, notes=notes)
    return {
        "ok": True,
        "captured": len(notes),
        "inserted": inserted,
        "updated": updated,
        "raw_hits": (result or {}).get("raw_hits", 0),
    }


async def dispatch_xhs_creator_posts(
    *, user_id: int, url: str, timeout_ms: int = 25000, overall_timeout: float = 60.0,
) -> Dict[str, Any]:
    """通过扩展拉小红书博主主页发布列表。"""
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "xhs.creator_posts", "payload": {"url": url, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, "posts": (result or {}).get("posts") or [], "raw_hits": (result or {}).get("raw_hits", 0)}


async def dispatch_douyin_creator_posts(
    *, user_id: int, url: str, timeout_ms: int = 25000, overall_timeout: float = 60.0,
) -> Dict[str, Any]:
    """通过扩展拉抖音博主主页发布列表。"""
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "douyin.creator_posts", "payload": {"url": url, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, "posts": (result or {}).get("posts") or [], "raw_hits": (result or {}).get("raw_hits", 0)}


async def dispatch_xhs_fetch_comments(
    *, user_id: int, note_id: str, xsec_token: str = "",
    timeout_ms: int = 20000, overall_timeout: float = 60.0,
) -> Dict[str, Any]:
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "xhs.fetch_comments",
            "payload": {"note_id": note_id, "xsec_token": xsec_token, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, "comments": (result or {}).get("comments") or [], "total": (result or {}).get("total", 0)}


async def dispatch_douyin_fetch_comments(
    *, user_id: int, aweme_id: str, timeout_ms: int = 20000, overall_timeout: float = 60.0,
) -> Dict[str, Any]:
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "douyin.fetch_comments",
            "payload": {"aweme_id": aweme_id, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, "comments": (result or {}).get("comments") or [], "total": (result or {}).get("total", 0)}


async def dispatch_douyin_live_status(
    *, user_id: int, live_url: str, timeout_ms: int = 12000, overall_timeout: float = 45.0,
) -> Dict[str, Any]:
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "douyin.live_status",
            "payload": {"live_url": live_url, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, **(result or {})}


async def dispatch_xhs_note_detail(
    *, user_id: int, note_id: str, xsec_token: str = "",
    timeout_ms: int = 15000, overall_timeout: float = 45.0,
) -> Dict[str, Any]:
    """补全单个 XHS 笔记详情（desc / images / video / 私密笔记）。"""
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "xhs.note_detail",
            "payload": {"note_id": note_id, "xsec_token": xsec_token, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, **(result or {})}


async def dispatch_douyin_note_detail(
    *, user_id: int, aweme_id: str, timeout_ms: int = 15000, overall_timeout: float = 45.0,
) -> Dict[str, Any]:
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}
    task = {"id": uuid.uuid4().hex, "type": "douyin.note_detail",
            "payload": {"aweme_id": aweme_id, "timeout_ms": timeout_ms}}
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, **(result or {})}


async def dispatch_publish(
    *, user_id: int, platform: str, payload: Dict[str, Any],
    overall_timeout: float = 180.0,
) -> Dict[str, Any]:
    """通过扩展模拟用户在 creator 平台发布。

    平台:
      - xhs:    creator.xiaohongshu.com/publish/publish
      - douyin: creator.douyin.com/creator-micro/content/upload

    payload 字段（按平台不同）:
      xhs:    title, body, images[], topics[], poi
      douyin: title, body, video_url 或 images[]
    """
    if platform not in ("xhs", "douyin"):
        return {"ok": False, "error": f"unsupported platform {platform}"}
    if not has_online_extension(user_id):
        return {"ok": False, "stage": "no_online_extension", "error": "no online extension", "detail": translate_error("no online extension")}

    task = {
        "id": uuid.uuid4().hex,
        "type": f"{platform}.publish",
        "payload": payload,
    }
    try:
        result = await _registry().dispatch(int(user_id), task, timeout=overall_timeout)
    except Exception as e:
        return {"ok": False, "stage": "dispatch", "error": str(e), "detail": translate_error(str(e))}
    return {"ok": True, **(result or {})}


async def ingest_xhs_notes(
    *, user_id: int, keyword: str, notes: List[Dict[str, Any]],
) -> Tuple[int, int]:
    """落库返回 (inserted, updated)。"""
    inserted = updated = 0
    for n in notes or []:
        try:
            note_id = str(n.get("note_id", "")).strip()
            if not note_id:
                continue
            is_new = await monitor_db.add_or_update_trending_post(
                note_id=note_id,
                title=(n.get("title") or "")[:200],
                desc_text="",
                note_url=n.get("url", "") or n.get("note_url", ""),
                xsec_token=n.get("xsec_token", ""),
                liked_count=int(n.get("liked_count", 0) or 0),
                collected_count=int(n.get("collected_count", 0) or 0),
                comment_count=int(n.get("comment_count", 0) or 0),
                keyword=keyword,
                author=(n.get("author") or "")[:100],
                cover_url=n.get("cover_url", "") or "",
                images="",
                video_url=n.get("video_url", "") or "",
                note_type=n.get("note_type", "normal") or "normal",
                platform="xhs",
                user_id=user_id,
            )
            if is_new:
                inserted += 1
            else:
                updated += 1
        except Exception as e:
            logger.warning(f"[ext-dispatch] ingest xhs note failed: {e}")
    return inserted, updated


async def ingest_douyin_notes(
    *, user_id: int, keyword: str, notes: List[Dict[str, Any]],
) -> Tuple[int, int]:
    """落库 (inserted, updated)。复用 trending_posts 表，platform=douyin。"""
    inserted = updated = 0
    for n in notes or []:
        try:
            aid = str(n.get("aweme_id") or n.get("post_id") or n.get("note_id") or "").strip()
            if not aid:
                continue
            is_new = await monitor_db.add_or_update_trending_post(
                note_id=aid,
                title=(n.get("title") or n.get("desc") or "")[:200],
                desc_text="",
                note_url=n.get("url") or f"https://www.iesdouyin.com/share/video/{aid}/",
                xsec_token="",
                liked_count=int(n.get("liked_count", 0) or n.get("digg_count", 0) or 0),
                collected_count=int(n.get("collected_count", 0) or n.get("collect_count", 0) or 0),
                comment_count=int(n.get("comment_count", 0) or 0),
                keyword=keyword,
                author=(n.get("author") or "")[:100],
                cover_url=n.get("cover_url", "") or "",
                images="",
                video_url=n.get("video_url", "") or "",
                note_type=n.get("note_type", "video") or "video",
                platform="douyin",
                user_id=user_id,
            )
            if is_new:
                inserted += 1
            else:
                updated += 1
        except Exception as e:
            logger.warning(f"[ext-dispatch] ingest douyin note failed: {e}")
    return inserted, updated
