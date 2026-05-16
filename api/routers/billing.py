# -*- coding: utf-8 -*-
"""SaaS 计费 API：用户余额/流水 + 模型单价 + admin 充值后台。

用户侧（任意登录用户）：
  GET  /api/billing/me                 当前余额 + 最近流水
  GET  /api/billing/ledger             我的流水分页
  GET  /api/billing/model-prices       各模型单价表（前端 ModelSelector 标价用）

admin 侧（仅 admin）：
  POST /api/admin/billing/recharge     给用户充值 {user_id, amount, note}
  POST /api/admin/billing/adjust       手动纠错 {user_id, delta, note}
  POST /api/admin/billing/grant        手动赠送 {user_id, amount, note}
  GET  /api/admin/billing/users/{uid}/ledger   看某用户流水
  GET  /api/admin/billing/reconcile    全员对账（返回不一致的用户）
"""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..services import auth_service, billing_service, monitor_db
from ..services import db as _db
from .auth import get_admin_user, get_current_user

router = APIRouter(prefix="/billing", tags=["Billing"])
admin_router = APIRouter(prefix="/admin/billing", tags=["Billing-Admin"])


def _fnum(d: Decimal) -> float:
    return float(d)


# ── 用户侧 ─────────────────────────────────────────────────────────────────

@router.get("/me", summary="我的余额 + 最近流水")
async def my_billing(current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    bal = await billing_service.get_balance(uid)
    led = await billing_service.list_ledger(uid, limit=20)
    return {"balance": _fnum(bal), "recent_ledger": led}


@router.get("/ledger", summary="我的流水（分页）")
async def my_ledger(
    limit: int = 50, offset: int = 0,
    current_user: dict = Depends(get_current_user),
):
    uid = int(current_user["id"])
    rows = await billing_service.list_ledger(uid, limit=min(int(limit), 200), offset=int(offset))
    return {"ledger": rows, "balance": _fnum(await billing_service.get_balance(uid))}


@router.get("/model-prices", summary="各模型单价（前端标价用）")
async def model_prices(current_user: dict = Depends(get_current_user)):
    """返回所有 published 平台模型的 price_per_call + feature_pricing，
    供 ModelSelector 在下拉里标注 "(0.3 点/次)" 之类。"""
    out = []
    async with _db.connect(monitor_db.DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT m.id, m.model_id, m.display_name, m.usage_type, m.is_default, "
            "       m.supports_vision, m.price_per_call, m.feature_pricing, p.name AS provider_name "
            "FROM ai_models m JOIN ai_providers p ON m.provider_id=p.id "
            "WHERE m.published=1 AND p.enabled=1 AND m.owner_user_id IS NULL "
            "ORDER BY m.usage_type, m.sort_order, m.id"
        ) as cur:
            for r in await cur.fetchall():
                d = dict(r)
                try:
                    d["feature_pricing"] = json.loads(d.get("feature_pricing") or "{}")
                except Exception:
                    d["feature_pricing"] = {}
                d["price_per_call"] = float(d.get("price_per_call") or 1)
                out.append(d)
    # 也带上 feature 默认价表，前端能解释每个 feature 大概多少钱
    return {"models": out, "default_feature_price": {
        k: float(v) for k, v in billing_service.DEFAULT_FEATURE_PRICE.items()
    }}


# ── admin 侧 ───────────────────────────────────────────────────────────────

class RechargeIn(BaseModel):
    user_id: int
    amount: float
    note: str = ""


class AdjustIn(BaseModel):
    user_id: int
    delta: float        # 可正可负
    note: str           # 必填


def _check_user_exists(uid: int):
    u = auth_service.get_user_by_id(int(uid))
    if not u:
        raise HTTPException(status_code=404, detail=f"用户 {uid} 不存在")
    return u


@admin_router.post("/recharge", summary="给用户充值")
async def admin_recharge(body: RechargeIn, admin: dict = Depends(get_admin_user)):
    _check_user_exists(body.user_id)
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="充值金额必须 > 0")
    bal = await billing_service.recharge(
        body.user_id, body.amount, operator=str(admin.get("username") or "admin"), note=body.note,
    )
    return {"ok": True, "user_id": body.user_id, "balance": _fnum(bal)}


@admin_router.post("/adjust", summary="手动纠错（delta 可正可负）")
async def admin_adjust(body: AdjustIn, admin: dict = Depends(get_admin_user)):
    _check_user_exists(body.user_id)
    if not body.note.strip():
        raise HTTPException(status_code=400, detail="adjust 必须填 note 说明原因")
    bal = await billing_service.adjust(
        body.user_id, body.delta, operator=str(admin.get("username") or "admin"), note=body.note.strip(),
    )
    return {"ok": True, "user_id": body.user_id, "balance": _fnum(bal)}


@admin_router.post("/grant", summary="手动赠送")
async def admin_grant(body: RechargeIn, admin: dict = Depends(get_admin_user)):
    _check_user_exists(body.user_id)
    if body.amount <= 0:
        raise HTTPException(status_code=400, detail="赠送金额必须 > 0")
    bal = await billing_service.grant(body.user_id, body.amount, note=body.note or "admin_grant")
    return {"ok": True, "user_id": body.user_id, "balance": _fnum(bal)}


@admin_router.get("/users/{uid}/ledger", summary="看某用户的流水")
async def admin_user_ledger(
    uid: int, limit: int = 100, offset: int = 0,
    admin: dict = Depends(get_admin_user),
):
    _check_user_exists(uid)
    rows = await billing_service.list_ledger(uid, limit=min(int(limit), 500), offset=int(offset))
    bal = await billing_service.get_balance(uid)
    ok, b, total = await billing_service.reconcile(uid)
    return {
        "user_id": uid, "balance": _fnum(bal), "ledger": rows,
        "reconcile_ok": ok, "ledger_sum": _fnum(total),
    }


@admin_router.get("/reconcile", summary="全员对账（返回不一致的用户）")
async def admin_reconcile_all(admin: dict = Depends(get_admin_user)):
    bad = await billing_service.reconcile_all()
    return {
        "ok": len(bad) == 0,
        "mismatches": [
            {"user_id": uid, "balance": _fnum(bal), "ledger_sum": _fnum(total)}
            for uid, bal, total in bad
        ],
    }


class GrantAllIn(BaseModel):
    ym: Optional[str] = None  # 'YYYY-MM'，不传 = 本月


@admin_router.post("/grant-all-monthly", summary="立刻按 plan.monthly_credits 给所有活跃用户送点（cron 同款，幂等）")
async def admin_grant_all_monthly(body: GrantAllIn, admin: dict = Depends(get_admin_user)):
    """与 cron `monthly_grant` 完全等价。task_ref = monthly_grant:{uid}:{ym}，
    同月重复调用不会重复送（前后端踩重也安全）。"""
    result = await billing_service.monthly_grant_all_users(ym=body.ym)
    return {"ok": True, **result}
