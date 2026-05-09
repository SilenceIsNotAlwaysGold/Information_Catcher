"""配额检查 + 用量计数。

放在端点最前面调 `check_or_raise(...)`，超限抛 HTTPException(402)。
admin 永远豁免；plan 中 -1 表示无限制。

用量来源：
- monitor_posts：count(monitor_posts where user_id=?)
- accounts：count(monitor_accounts where user_id=?)
- daily_image_gen：daily_usage.image_gen_count where user_id=? and date=today
- daily_remix_sets：daily_usage.remix_sets_count where user_id=? and date=today
"""
from __future__ import annotations

import json
import logging
from datetime import date as _date
from typing import Any, Dict, Optional

import aiosqlite
from fastapi import HTTPException

from . import monitor_db
from . import plans as plans_module

logger = logging.getLogger(__name__)


def _today() -> str:
    return _date.today().isoformat()


def _is_admin(user: Dict[str, Any]) -> bool:
    return (user or {}).get("role") == "admin"


def _user_quota(user: Dict[str, Any], key: str) -> int:
    """优先用 quota_override_json 里的值（admin 单独提的额度），否则按 plan。"""
    raw = (user or {}).get("quota_override_json", "")
    if raw:
        try:
            override = json.loads(raw)
            if key in override:
                return int(override[key])
        except Exception:
            pass
    return plans_module.get_quota(user.get("plan"), key)


# ── 当前用量 ────────────────────────────────────────────────────────────────

async def count_monitor_posts(user_id: int) -> int:
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM monitor_posts WHERE user_id=?", (user_id,),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def count_accounts(user_id: int) -> int:
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM monitor_accounts WHERE user_id=?", (user_id,),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


async def get_daily_usage(user_id: int) -> Dict[str, int]:
    """返回 {image_gen: N, remix_sets: N}（今日累计）。"""
    today = _today()
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        async with db.execute(
            "SELECT image_gen_count, remix_sets_count FROM daily_usage "
            "WHERE user_id=? AND date=?",
            (user_id, today),
        ) as cur:
            row = await cur.fetchone()
            if not row:
                return {"image_gen": 0, "remix_sets": 0}
            return {"image_gen": int(row[0] or 0), "remix_sets": int(row[1] or 0)}


async def get_usage_summary(user: Dict[str, Any]) -> Dict[str, Any]:
    """用户 profile 页 + admin 用户列表显示。返回 used / quota 对照。"""
    user_id = user["id"]
    monitor_posts = await count_monitor_posts(user_id)
    accounts = await count_accounts(user_id)
    daily = await get_daily_usage(user_id)
    return {
        "plan": user.get("plan") or "free",
        "monitor_posts": {
            "used": monitor_posts,
            "quota": _user_quota(user, "monitor_posts"),
        },
        "accounts": {
            "used": accounts,
            "quota": _user_quota(user, "accounts"),
        },
        "daily_image_gen": {
            "used": daily["image_gen"],
            "quota": _user_quota(user, "daily_image_gen"),
        },
        "daily_remix_sets": {
            "used": daily["remix_sets"],
            "quota": _user_quota(user, "daily_remix_sets"),
        },
    }


# ── 检查（写端点前调）─────────────────────────────────────────────────────────

async def check_or_raise(user: Dict[str, Any], key: str, *, delta: int = 1) -> None:
    """超限 → 抛 402。admin 豁免。`delta` 是这次请求要消耗的数量（默认 1）。"""
    if _is_admin(user):
        return
    quota = _user_quota(user, key)
    if plans_module.is_unlimited(quota):
        return

    user_id = user["id"]
    if key == "monitor_posts":
        used = await count_monitor_posts(user_id)
    elif key == "accounts":
        used = await count_accounts(user_id)
    elif key in ("daily_image_gen", "daily_remix_sets"):
        daily = await get_daily_usage(user_id)
        used = daily["image_gen"] if key == "daily_image_gen" else daily["remix_sets"]
    else:
        return

    if used + delta > quota:
        plan_label = plans_module.get_plan(user.get("plan")).get("label", user.get("plan"))
        msg = (
            f"已超出当前套餐「{plan_label}」的配额限制："
            f"{_human(key)} 用量 {used}+{delta}/{quota}。"
            "请联系管理员升级套餐或调整额度。"
        )
        # 同时记一次 audit
        try:
            from . import audit_service
            await audit_service.log(
                actor=user, action="quota.exceeded",
                target_type="quota", target_id=key,
                metadata={"used": used, "delta": delta, "quota": quota, "plan": user.get("plan")},
            )
        except Exception:
            pass
        raise HTTPException(status_code=402, detail=msg)


def _human(key: str) -> str:
    return {
        "monitor_posts": "监控帖子",
        "accounts": "账号池",
        "daily_image_gen": "今日商品图生成",
        "daily_remix_sets": "今日仿写套数",
    }.get(key, key)


# ── 用量计数（image_gen / remix_sets）────────────────────────────────────────

async def record_usage(user_id: Optional[int], key: str, delta: int = 1) -> None:
    """累加当日用量。`key` 为 'image_gen' 或 'remix_sets'。"""
    if not user_id:
        return
    if key not in ("image_gen", "remix_sets"):
        return
    today = _today()
    col = "image_gen_count" if key == "image_gen" else "remix_sets_count"
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        await db.execute(
            f"INSERT INTO daily_usage (user_id, date, {col}) VALUES (?, ?, ?) "
            f"ON CONFLICT(user_id, date) DO UPDATE SET {col} = {col} + excluded.{col}",
            (user_id, today, delta),
        )
        await db.commit()
