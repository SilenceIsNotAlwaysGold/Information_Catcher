"""创作者中心运营数据 API。

GET  /api/creator-stats/list         查询历史快照（默认 30 天）
GET  /api/creator-stats/latest       每个账号最近一行（看板首页）
POST /api/creator-stats/run-now      手动触发抓取（指定 account_id 或全部）
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..services import monitor_db as db
from ..services import scheduler as sched
from .auth import get_current_user

router = APIRouter(prefix="/creator-stats", tags=["创作者数据"])


class RunNowReq(BaseModel):
    account_id: Optional[int] = None


@router.get("/list")
async def list_stats(
    account_id: Optional[int] = Query(None),
    days: int = Query(30, ge=1, le=365),
    current_user: dict = Depends(get_current_user),
):
    rows = await db.creator_stats_list(
        user_id=current_user["id"], account_id=account_id, days=days,
    )
    return {"items": rows, "days": days}


@router.get("/latest")
async def latest_stats(current_user: dict = Depends(get_current_user)):
    rows = await db.creator_stats_latest_per_account(user_id=current_user["id"])
    return {"items": rows}


@router.post("/run-now")
async def run_now(
    req: RunNowReq,
    current_user: dict = Depends(get_current_user),
):
    """手动触发一次抓取。account_id 给定时只跑该账号；不给跑所有授权账号。

    校验：account_id 给定时必须属于当前用户或为共享账号。
    """
    if req.account_id:
        acc = await db.get_account(req.account_id)
        if not acc:
            raise HTTPException(status_code=404, detail="账号不存在")
        # 多租户校验：只能跑自己的或共享的
        owner = acc.get("user_id")
        if owner is not None and owner != current_user["id"] and not acc.get("is_shared"):
            raise HTTPException(status_code=403, detail="无权操作此账号")
    await sched.run_creator_dashboard(account_id=req.account_id)
    return {"ok": True}
