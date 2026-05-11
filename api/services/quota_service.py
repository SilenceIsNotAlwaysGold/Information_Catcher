"""配额检查 + 用量计数。

放在端点最前面调 `check_or_raise(...)`，超限抛 HTTPException(402)。
admin 永远豁免；plan 中 -1 表示无限制。

用量来源：
- monitor_posts：count(monitor_posts where user_id=?)
- accounts：count(monitor_accounts where user_id=?)
- daily_image_gen：daily_usage.image_gen_count where user_id=? and date=today
- daily_remix_sets：daily_usage.remix_sets_count where user_id=? and date=today
  ⚠ 字段名是 sets 但 2026-05 起含义改为"实际生成图数"
  （= count × len(ref_image_idxs)）。原因：选多张参考图时，1 套实际生 K 张，
  老逻辑按 sets 扣会让配额低估 K 倍。
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
    """返回 {image_gen, text_gen, remix_sets}（今日累计）。

    remix_sets 是历史列名（deprecated），现在所有图都走 image_gen，
    所有文案都走 text_gen。
    """
    today = _today()
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        async with db.execute(
            "SELECT image_gen_count, "
            "       COALESCE(text_gen_count, 0), "
            "       remix_sets_count "
            "  FROM daily_usage WHERE user_id=? AND date=?",
            (user_id, today),
        ) as cur:
            row = await cur.fetchone()
            if not row:
                return {"image_gen": 0, "text_gen": 0, "remix_sets": 0}
            return {
                "image_gen":  int(row[0] or 0),
                "text_gen":   int(row[1] or 0),
                "remix_sets": int(row[2] or 0),
            }


async def get_total_image_used(user_id: int) -> int:
    """图配额改成"账户总累计"：SUM(daily_usage.image_gen_count)。

    DB 不动，每天一行，单用户一年才 365 行 SUM 起来微秒级。
    比起加 users.total_image_gen_count 列做一致性维护，这种实现更稳。
    """
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        async with db.execute(
            "SELECT COALESCE(SUM(image_gen_count), 0) "
            "  FROM daily_usage WHERE user_id=?",
            (user_id,),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0] or 0) if row else 0


async def get_usage_summary(user: Dict[str, Any]) -> Dict[str, Any]:
    """用户 profile 页 + admin 用户列表显示。返回 used / quota 对照。

    图配额：累计（账户总历史），不重置。
    文配额：每日 0 点重置。
    """
    user_id = user["id"]
    monitor_posts = await count_monitor_posts(user_id)
    accounts = await count_accounts(user_id)
    daily = await get_daily_usage(user_id)
    total_image = await get_total_image_used(user_id)
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
        # 图配额：账户累计
        "total_image_gen": {
            "used": total_image,
            "quota": _user_quota(user, "total_image_gen"),
        },
        # 文配额：每日重置
        "daily_text_gen": {
            "used": daily["text_gen"],
            "quota": _user_quota(user, "daily_text_gen"),
        },
        # deprecated（保留兼容老前端，旧 PlanUsageCard 还在读这两个 key）
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
    elif key == "total_image_gen":
        # 图配额：账户累计（账户存活期内总和）
        used = await get_total_image_used(user_id)
    elif key == "daily_image_gen":
        # deprecated：旧端点仍可能传这个 key，兼容回退到 total
        used = await get_total_image_used(user_id)
    elif key == "daily_text_gen":
        daily = await get_daily_usage(user_id)
        used = daily["text_gen"]
    elif key == "daily_remix_sets":
        # deprecated：仿写图配额已并入 total_image_gen
        return
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
        "accounts": "已绑平台账号",
        "total_image_gen": "AI 累计生图",
        "daily_image_gen": "AI 累计生图",  # 老 key 别名（语义已改为累计）
        "daily_text_gen":  "今日 AI 写文",
        "daily_remix_sets": "今日仿写（已废弃）",
    }.get(key, key)


# ── 用量计数（image_gen / text_gen）─────────────────────────────────────────

_USAGE_KEY_TO_COL = {
    "image_gen":  "image_gen_count",
    "text_gen":   "text_gen_count",
    "remix_sets": "remix_sets_count",  # deprecated：不再写入
}


async def record_usage(user_id: Optional[int], key: str, delta: int = 1) -> None:
    """累加当日用量。key 取值：image_gen | text_gen。

    旧代码可能仍传 remix_sets，本函数会静默忽略（避免重复计数）。
    """
    if not user_id:
        return
    if key == "remix_sets":
        # deprecated：仿写图数已并入 image_gen，旧调用不再写库
        return
    col = _USAGE_KEY_TO_COL.get(key)
    if not col:
        return
    today = _today()
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        await db.execute(
            f"INSERT INTO daily_usage (user_id, date, {col}) VALUES (?, ?, ?) "
            f"ON CONFLICT(user_id, date) DO UPDATE SET {col} = {col} + excluded.{col}",
            (user_id, today, delta),
        )
        await db.commit()
