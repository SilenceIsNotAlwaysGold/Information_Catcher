# -*- coding: utf-8 -*-
"""AI 旅游攻略 —— 输入目的地+天数+偏好，一次 LLM 调用生成完整行程。

走 ai_client.call_text 平台模型 + 计费扣点（feature=travel_plan）。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ...services import ai_client, monitor_db
from ...services import db as _db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio/travel", tags=["AI-Studio-Travel"])
DB_PATH = monitor_db.DB_PATH


_SYSTEM = """你是经验丰富的旅行规划师。根据用户给的目的地、天数、预算和偏好，
输出一份可直接照着走的行程。要点：每天分上午/下午/晚上三段，
每段包含具体地点（含简要交通建议）、推荐时长、餐厅或小吃推荐、预估花费；
结尾给「实用 tips」（4-6 条，含天气/出行/避坑）和「总预算估算」。
严格只输出 JSON（不要任何代码块标记或解释）。格式：
{"title":"...", "days":[{"day":1,"morning":"...","afternoon":"...","evening":"...","food":"...","transport":"...","cost":"..."}], "tips":["...","..."], "budget_estimate":"..."}
"""


class CreatePlanIn(BaseModel):
    dest_city: str = Field(..., min_length=1, max_length=80)
    days: int = Field(3, ge=1, le=14)
    budget: str = ""
    travel_style: str = ""
    extra_prefs: str = ""
    text_model_id: Optional[int] = None


def _strip_codeblock(s: str) -> str:
    t = s.strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t.lower().startswith("json"):
            t = t[4:].strip()
    return t


@router.post("/plans", summary="生成一份旅游攻略（扣 travel_plan 点）")
async def create_plan(body: CreatePlanIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    user_prompt = (
        f"目的地：{body.dest_city}\n"
        f"天数：{body.days} 天\n"
        f"预算：{body.budget or '不限'}\n"
        f"风格偏好：{body.travel_style or '不限'}\n"
        f"其它要求：{(body.extra_prefs or '').strip()[:1000] or '无'}\n\n"
        "请生成完整行程 JSON。"
    )
    raw = await ai_client.call_text(
        user_prompt, model_id=body.text_model_id, user_id=uid,
        feature="travel_plan", system_prompt=_SYSTEM,
        temperature=0.6, max_tokens=2500,
    )
    txt = _strip_codeblock(raw)
    try:
        plan = json.loads(txt)
        if not isinstance(plan, dict) or "days" not in plan:
            raise ValueError("缺 days")
    except Exception as e:
        raise HTTPException(
            502,
            f"AI 返回的行程不是合法 JSON：{str(e)[:100]}；原始（前 200 字符）：{raw[:200]}",
        )
    title = (plan.get("title") or f"{body.dest_city} {body.days} 日游").strip()[:100]
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO travel_plans(user_id, title, dest_city, days, budget, travel_style, "
            "extra_prefs, plan_json, text_model_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (uid, title, body.dest_city.strip(), int(body.days), body.budget.strip()[:200],
             body.travel_style.strip()[:80], (body.extra_prefs or "").strip()[:1000],
             json.dumps(plan, ensure_ascii=False), body.text_model_id),
        )
        await db.commit()
        plan_id = cur.lastrowid
    return {"ok": True, "id": plan_id, "title": title, "plan": plan}


@router.get("/plans", summary="我的旅游攻略列表")
async def list_plans(limit: int = 50, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT id, title, dest_city, days, budget, travel_style, created_at "
            "FROM travel_plans WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (uid, int(min(limit, 200))),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"plans": rows}


@router.get("/plans/{pid}", summary="攻略详情（含完整 plan JSON）")
async def get_plan(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM travel_plans WHERE id=? AND user_id=?", (int(pid), uid),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "攻略不存在或无权访问")
    d = dict(row)
    try:
        d["plan"] = json.loads(d.get("plan_json") or "{}")
    except Exception:
        d["plan"] = {}
    d.pop("plan_json", None)
    return d


@router.delete("/plans/{pid}", summary="删除攻略")
async def delete_plan(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM travel_plans WHERE id=? AND user_id=?", (int(pid), uid),
        )
        await db.commit()
    return {"ok": True}
