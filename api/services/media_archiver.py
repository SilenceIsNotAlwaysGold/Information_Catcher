"""媒体归档 worker。

作用：
  * 业务侧（trending / monitor）发现新爆款笔记时，调 archive_post() 登记。
  * 后台 APScheduler job 定时拉一批 pending 行，httpx 下载原始 CDN URL，
    上传到 S3 / 七牛，记录公网 URL 到 media_archive。
  * 失败重试 3 次后置 'failed'。

设计取舍：
  - 不做秒下载：登记跟下载解耦，避免拖慢 trending/monitor 主流程；下载在后台
    跑，单次跑一批（_BATCH_SIZE）。
  - 不下载所有图片：仅在 should_archive() 通过时才登记（点赞 ≥ 阈值，平台过滤等）。
  - 下载并发受限（_CONCURRENCY），避免给 CDN 灌爆。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from . import monitor_db, storage

logger = logging.getLogger(__name__)

_BATCH_SIZE = 30
_CONCURRENCY = 4
_DOWNLOAD_TIMEOUT = 60
_DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)


async def archive_threshold() -> int:
    """点赞 ≥ 这个值才归档。默认 5000。"""
    raw = await monitor_db.get_setting("media_archive_min_likes", "5000")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 5000


async def is_enabled() -> bool:
    raw = await monitor_db.get_setting("media_archive_enabled", "0")
    return raw == "1"


def _ext_from_url(url: str, default: str = "jpg") -> str:
    """从 URL 末尾猜后缀。XHS CDN URL 大多没有显式扩展名，就走默认。"""
    try:
        path = urlparse(url).path
        last = path.rsplit("/", 1)[-1]
        if "." in last:
            ext = last.rsplit(".", 1)[-1].lower()
            if ext and len(ext) <= 5 and ext.isalnum():
                return ext
    except Exception:
        pass
    return default


def _content_type_for_kind(kind: str, suffix: str) -> str:
    if kind == "video":
        return {"mp4": "video/mp4", "mov": "video/quicktime"}.get(
            suffix, "video/mp4",
        )
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp",
        "avif": "image/avif", "gif": "image/gif",
    }.get(suffix, "image/jpeg")


async def archive_post(
    *,
    user_id: Optional[int],
    platform: str,
    note_id: str,
    note_url: str,
    note_title: str = "",
    author: str = "",
    cover_url: str = "",
    images: Optional[List[str]] = None,
    video_url: str = "",
    liked_count: int = 0,
) -> int:
    """业务方调用：把一条爆款笔记的所有媒体登记入归档队列。

    返回登记成功的行数（去重后）。
    """
    if not await is_enabled():
        return 0
    if liked_count < await archive_threshold():
        return 0
    if not note_id:
        return 0

    rows = 0
    # 封面
    if cover_url:
        rid = await monitor_db.archive_enqueue(
            user_id=user_id, platform=platform, note_id=note_id,
            note_url=note_url, note_title=note_title, author=author,
            kind="cover", src_url=cover_url,
        )
        if rid:
            rows += 1
    # 图集
    for url in (images or []):
        if not url or url == cover_url:
            continue
        rid = await monitor_db.archive_enqueue(
            user_id=user_id, platform=platform, note_id=note_id,
            note_url=note_url, note_title=note_title, author=author,
            kind="image", src_url=url,
        )
        if rid:
            rows += 1
    # 视频
    if video_url:
        rid = await monitor_db.archive_enqueue(
            user_id=user_id, platform=platform, note_id=note_id,
            note_url=note_url, note_title=note_title, author=author,
            kind="video", src_url=video_url,
        )
        if rid:
            rows += 1
    return rows


async def _download_and_upload(row: Dict[str, Any]) -> None:
    src_url = row["src_url"]
    kind = row["kind"]
    archive_id = int(row["id"])
    note_id = row["note_id"]
    user_id = row.get("user_id")
    suffix = _ext_from_url(
        src_url, default=("mp4" if kind == "video" else "jpg"),
    )
    headers = {
        "User-Agent": _DEFAULT_UA,
        "Referer": "https://www.xiaohongshu.com/",
    }

    try:
        async with httpx.AsyncClient(
            timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True,
        ) as client:
            resp = await client.get(src_url, headers=headers)
        if resp.status_code != 200:
            await monitor_db.archive_mark_failed(
                archive_id, f"HTTP {resp.status_code} from CDN",
            )
            return
        data = resp.content
        if not data:
            await monitor_db.archive_mark_failed(archive_id, "empty body")
            return
    except Exception as e:
        await monitor_db.archive_mark_failed(
            archive_id, f"download failed: {type(e).__name__}: {e}",
        )
        return

    sha = hashlib.sha256(data).hexdigest()
    backend = await storage.active_backend()
    if backend == "none":
        await monitor_db.archive_mark_failed(
            archive_id, "no storage backend configured (S3/qiniu)",
        )
        return

    public_url, err = await storage.upload_bytes(
        data, suffix=suffix, kind=kind, user_id=user_id, note_id=note_id,
        content_type=_content_type_for_kind(kind, suffix),
    )
    if not public_url:
        await monitor_db.archive_mark_failed(archive_id, err or "upload failed")
        return

    await monitor_db.archive_mark_done(
        archive_id, storage_url=public_url, storage_backend=backend,
        sha256=sha, size_bytes=len(data),
    )


async def run_archive_worker() -> None:
    """APScheduler 周期性入口：拉一批 pending 行下载并上传。"""
    if not await is_enabled():
        return
    rows = await monitor_db.archive_list_pending(limit=_BATCH_SIZE)
    if not rows:
        return
    backend = await storage.active_backend()
    if backend == "none":
        logger.warning(
            "[archive] %d pending media but no storage backend configured", len(rows),
        )
        return
    logger.info(
        "[archive] processing %d pending media (backend=%s)", len(rows), backend,
    )
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(r):
        async with sem:
            await _download_and_upload(r)

    await asyncio.gather(*[_one(r) for r in rows], return_exceptions=True)
