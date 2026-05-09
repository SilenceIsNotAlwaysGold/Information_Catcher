"""媒体归档查询 API。"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from ..services import monitor_db as db
from ..services import media_archiver
from ..services import storage
from .auth import get_current_user

router = APIRouter(prefix="/archive", tags=["归档"])


@router.get("/list", summary="归档媒体列表")
async def list_archive(
    platform: str = Query("", description="xhs / douyin / mp，留空全部"),
    note_id: str = Query("", description="按 note 过滤"),
    status: str = Query("", description="pending | done | failed，留空全部"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
):
    items = await db.archive_list_for_user(
        user_id=current_user["id"], platform=platform,
        note_id=note_id, status=status, limit=limit, offset=offset,
    )
    total = await db.archive_count_for_user(
        user_id=current_user["id"], platform=platform, status=status,
    )
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/status", summary="归档配置 + 工作状态")
async def archive_status(_: dict = Depends(get_current_user)):
    enabled = await media_archiver.is_enabled()
    threshold = await media_archiver.archive_threshold()
    backend = await storage.active_backend()
    return {
        "enabled": enabled,
        "min_likes": threshold,
        "storage_backend": backend,
        "ready": enabled and backend != "none",
    }


@router.post("/run-now", summary="立即触发一次归档 worker")
async def run_archive_now(_: dict = Depends(get_current_user)):
    """手动触发一轮：抓一批 pending 行下载 + 上传。"""
    if not await media_archiver.is_enabled():
        raise HTTPException(status_code=400, detail="归档未启用（settings 里 media_archive_enabled）")
    if (await storage.active_backend()) == "none":
        raise HTTPException(status_code=400, detail="未配置存储后端（S3 / 七牛）")
    await media_archiver.run_archive_worker()
    return {"ok": True}
