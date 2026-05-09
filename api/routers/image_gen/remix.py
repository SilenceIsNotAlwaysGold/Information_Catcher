# -*- coding: utf-8 -*-
"""作品仿写：粘贴链接 → 异步生成 N 套（图 + 文案）。

异步任务流：
1. POST /remix-tasks 提交（仅入队，立即返回 task_id）
2. scheduler 后台 worker 取 pending 任务，逐套生图 + AI 写文案
3. GET /remix-tasks/{id} 轮询进度
"""
from __future__ import annotations

import base64
import logging
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import monitor_db, monitor_fetcher, quota_service
from ...services.platforms import detect_platform

logger = logging.getLogger(__name__)

router = APIRouter()


class FetchPostRequest(BaseModel):
    """粘贴作品 URL → 返回所有图（前端选用哪张作参考）+ 文案。"""
    url: str


class CreateRemixTaskRequest(BaseModel):
    post_url: str
    ref_image_idx: int = 0       # 选第几张图作为参考（默认封面）
    count: int = 5               # 1–30 套
    size: Optional[str] = None   # 留空用配置默认


@router.post("/fetch-post-cover", summary="拉取作品所有图 + 文案（仿写第一步）")
async def fetch_post_cover(
    req: FetchPostRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """返回 {images: [{url, b64?}, ...], title, desc, platform, post_id}。

    images 第 0 张默认是封面。前端展示缩略图条让用户选参考图。
    为了节省带宽，只把缩略图 URL 给前端，b64 在用户提交任务时由后端再次下载。
    """
    raw_url = (req.url or "").strip()
    if not raw_url:
        return {"error": "URL 不能为空"}

    plat = detect_platform(raw_url)
    if not plat:
        return {"error": "无法识别 URL 所属平台（仅支持小红书/抖音）"}

    info = await plat.resolve_url(raw_url)
    if not info:
        return {"error": "URL 解析失败，请确认链接有效"}

    if plat.name == "xhs":
        metrics, status = await monitor_fetcher.fetch_note_metrics(
            note_id=info["post_id"],
            xsec_token=info.get("xsec_token", ""),
            xsec_source=info.get("xsec_source", "app_share"),
            account=None,
        )
    else:
        metrics, status = await plat.fetch_detail(
            {"post_id": info["post_id"], "note_id": info["post_id"],
             "url": info.get("url", "")}, account=None,
        )

    if not metrics:
        reason_map = {
            "deleted": "笔记已被删除 / 仅自己可见 / 被屏蔽。请换一篇匿名能打开的链接。",
            "login_required": "该链接需要登录态（XHS 跳转登录页）。请用「分享」链接（xsec_source=app_share）。",
            "error": "抓取失败，可能被风控或链接已失效，过几分钟重试。",
        }
        return {"error": reason_map.get(status, f"作品抓取失败（status={status}）")}

    images = list(metrics.get("images") or [])
    cover_url = metrics.get("cover_url") or ""
    if cover_url and cover_url not in images:
        images.insert(0, cover_url)
    if not images:
        return {"error": "未能从作品中提取到任何图片"}

    return {
        "images": images,
        "title": metrics.get("title") or "",
        "desc": (metrics.get("desc") or "")[:500],
        "platform": plat.name,
        "platform_label": plat.label,
        "post_id": info["post_id"],
        "post_url": info.get("url") or raw_url,
    }


@router.post("/remix-tasks", summary="提交仿写任务（异步）")
async def create_remix_task(
    req: CreateRemixTaskRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    if not (req.post_url or "").strip():
        raise HTTPException(status_code=400, detail="post_url 必填")
    count = max(1, min(int(req.count or 1), 30))
    ref_idx = max(0, int(req.ref_image_idx or 0))

    # 配额检查：今日仿写套数（admin 不限）
    await quota_service.check_or_raise(current_user, "daily_remix_sets", delta=count)

    # 立刻先解析一次，验证可达 + 拿参考图 URL，避免任务跑起来才发现链接挂了
    plat = detect_platform(req.post_url)
    if not plat:
        raise HTTPException(status_code=400, detail="无法识别平台")
    info = await plat.resolve_url(req.post_url)
    if not info:
        raise HTTPException(status_code=400, detail="URL 解析失败")

    if plat.name == "xhs":
        metrics, status = await monitor_fetcher.fetch_note_metrics(
            note_id=info["post_id"],
            xsec_token=info.get("xsec_token", ""),
            xsec_source=info.get("xsec_source", "app_share"),
            account=None,
        )
    else:
        metrics, status = await plat.fetch_detail(
            {"post_id": info["post_id"], "note_id": info["post_id"],
             "url": info.get("url", "")}, account=None,
        )
    if not metrics:
        raise HTTPException(status_code=400, detail=f"作品抓取失败（status={status}）")

    imgs = list(metrics.get("images") or [])
    cover = metrics.get("cover_url") or ""
    if cover and cover not in imgs:
        imgs.insert(0, cover)
    if not imgs:
        raise HTTPException(status_code=400, detail="该作品没有图片可作为参考")

    if ref_idx >= len(imgs):
        ref_idx = 0
    ref_url = imgs[ref_idx]

    user_id = current_user.get("id") if current_user else None
    task_id = await monitor_db.create_remix_task(
        user_id=user_id,
        post_url=req.post_url,
        post_title=metrics.get("title") or "",
        post_desc=(metrics.get("desc") or "")[:1000],
        platform=plat.name,
        ref_image_url=ref_url,
        ref_image_idx=ref_idx,
        count=count,
        size=(req.size or "").strip(),
    )

    # 用量计数（按提交套数；任务失败也算消耗，因为已经占用了 worker 资源）
    try:
        await quota_service.record_usage(user_id, "remix_sets", delta=count)
    except Exception as e:
        logger.warning(f"[remix] record_usage failed: {e}")

    return {"task_id": task_id, "status": "pending", "count": count}


@router.get("/remix-tasks/{task_id}", summary="查询仿写任务进度 + 结果")
async def get_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    task = await monitor_db.get_remix_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and task.get("user_id") != current_user.get("id"):
        raise HTTPException(status_code=403, detail="无权查看")
    return task


@router.get("/remix-tasks", summary="我的仿写任务列表")
async def list_remix_tasks(
    limit: int = 30,
    current_user: dict = Depends(get_current_user),
) -> dict:
    role = (current_user or {}).get("role") or "user"
    user_id = current_user.get("id") if current_user else None
    scope_uid = None if role == "admin" else user_id
    rows = await monitor_db.list_remix_tasks(
        user_id=scope_uid, limit=max(1, min(limit, 100)),
    )
    return {"tasks": rows}


@router.delete("/remix-tasks/{task_id}", summary="删除仿写任务")
async def delete_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    task = await monitor_db.get_remix_task(task_id)
    if not task:
        return {"ok": False, "error": "任务不存在"}
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and task.get("user_id") != current_user.get("id"):
        return {"ok": False, "error": "无权操作"}
    await monitor_db.delete_remix_task(task_id)
    return {"ok": True}
