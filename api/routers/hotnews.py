# -*- coding: utf-8 -*-
"""热点雷达 API（v2 板块 4）— 多源聚合 + 分类展示。

源在 services/hotnews_fetcher.py 注册。前端按 category（code/tech/policy/...）拉列表。
刷新策略：用户/admin 触发 + 后期 worker cron。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from .auth import get_current_user
from ..services import hotnews_fetcher, monitor_db
from ..services import db as _db

router = APIRouter(prefix="/hotnews", tags=["HotNews"])


@router.get("/sources", summary="内置热点源列表")
async def list_sources(current_user: dict = Depends(get_current_user)):
    return {
        "sources": [
            {"key": k, "label": v["label"], "category": v["category"]}
            for k, v in hotnews_fetcher.SOURCES.items()
        ],
    }


@router.get("/items", summary="按分类拉热点（默认所有分类）")
async def list_items(
    category: Optional[str] = None, source: Optional[str] = None,
    limit: int = 100,
    current_user: dict = Depends(get_current_user),
):
    where = []
    params = []
    if category:
        where.append("category=?"); params.append(category)
    if source:
        where.append("source=?"); params.append(source)
    sql = (
        "SELECT id, source, source_label, category, title, url, summary, "
        "       score, score_label, fetched_at "
        "FROM hotnews_items "
        + ("WHERE " + " AND ".join(where) + " " if where else "")
        + "ORDER BY fetched_at DESC, score DESC LIMIT ?"
    )
    params.append(int(min(limit, 500)))
    async with _db.connect(monitor_db.DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(sql, params) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"items": rows}


@router.post("/refresh", summary="刷新某源（admin 推荐；普通用户也可触发但有冷却）")
async def refresh(source: str, current_user: dict = Depends(get_current_user)):
    if source not in hotnews_fetcher.SOURCES:
        raise HTTPException(404, f"未知源：{source}")
    res = await hotnews_fetcher.refresh_source(source)
    return res


@router.post("/refresh-all", summary="刷新全部源（admin）")
async def refresh_all(current_user: dict = Depends(get_current_user)):
    if (current_user.get("role") or "").lower() != "admin":
        raise HTTPException(403, "需要管理员权限")
    return await hotnews_fetcher.refresh_all()
