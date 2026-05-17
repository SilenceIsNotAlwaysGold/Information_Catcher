# -*- coding: utf-8 -*-
"""SaaS 计费：用户点数余额 + 流水账。

不变量：user_credits.balance == SUM(credit_ledger.amount for that user)
  —— ledger.amount 存的就是"对余额的有符号影响"（deduct 为负，其它为正），
     所以对账只需 SUM 一下。

并发安全：每次变动都在一个事务里，先锁住该用户的余额行
  - PG:     SELECT ... FOR UPDATE （行锁）
  - sqlite: BEGIN IMMEDIATE （整库写锁，足够，sqlite 无行锁）
幂等：deduct 带 task_ref（幂等键），同一 task_ref 不重复扣（partial unique index 兜底）。
失败退款：AI 调用失败时 refund(同 task_ref)，记一笔反向流水。
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional, Tuple

from . import db as _db
from . import monitor_db

logger = logging.getLogger(__name__)

DB_PATH = monitor_db.DB_PATH
_Q = Decimal("0.01")  # 量化到 2 位小数（点数最小粒度 0.01）

# 各 feature 的兜底单价（admin 没在 ai_models.feature_pricing 配时用）。
# admin 配的优先；这只是出厂默认，方便上线即可用。
DEFAULT_FEATURE_PRICE: Dict[str, str] = {
    "ocr": "0.3",
    "text_rewrite": "0.5",
    "text_remix_rewrite": "0.5",
    "cross_rewrite": "0.5",
    "trending_rewrite": "0.5",
    "image": "1.0",
    "product_image": "1.0",
    "remix": "1.0",
    "text_remix": "1.0",
    "comic_style": "1.0",       # 漫画风：图生图一张
    "comic_panel": "0.5",       # AI 漫画：一格图
    "comic_story": "0.5",       # AI 漫画：对话推进一轮
    "novel_chapter": "1.0",     # AI 小说：生成一章
    "novel_outline": "0.5",     # AI 小说：生成大纲/分卷
    "travel_plan": "0.5",       # AI 旅游攻略
    "ppt_outline": "1.0",       # AI PPT：一次大纲（含 N 页内容，是个大调用）
}


def _dec(v) -> Decimal:
    """统一转 Decimal 并量化到 0.01。None → 0。"""
    if v is None:
        return Decimal("0")
    try:
        return Decimal(str(v)).quantize(_Q, rounding=ROUND_HALF_UP)
    except Exception:
        return Decimal("0")


def make_task_ref(*parts: Any) -> str:
    """构造计费幂等键。短 id 直接拼，长/多行文本走 md5（进程间稳定，
    不用内置 hash()——它带 PYTHONHASHSEED 盐，重启即变会击穿幂等）。

    例：make_task_ref("novel_chapter", pid, seq) → "novel_chapter:12:5"
        make_task_ref("cross_rewrite", uid, long_text) → "cross_rewrite:3:9af1c2..."
    """
    out: List[str] = []
    for p in parts:
        s = str(p)
        if len(s) <= 40 and "\n" not in s:
            out.append(s)
        else:
            out.append(hashlib.md5(s.encode("utf-8")).hexdigest()[:16])
    return ":".join(out)


class InsufficientCredits(Exception):
    """余额不足。携带当前余额和本次所需，便于前端友好提示。"""

    def __init__(self, balance: Decimal, needed: Decimal):
        self.balance = balance
        self.needed = needed
        super().__init__(f"余额不足：当前 {balance} 点，本次需 {needed} 点")


# ── 定价 ──────────────────────────────────────────────────────────────────

async def compute_cost(model_id: Optional[int], feature: str = "") -> Decimal:
    """算这次 AI 调用要扣多少点。

    优先级：ai_models.feature_pricing[feature] > ai_models.price_per_call
            > DEFAULT_FEATURE_PRICE[feature] > 1.0
    model_id 为 None（系统后台调用 / 未配模型）→ 0（不扣费）。
    """
    if model_id is None:
        # 系统调用没有计费主体；feature 兜底价也只在有 model_id 时才用
        return Decimal("0")
    async with _db.connect(DB_PATH) as conn:
        conn.row_factory = _db.Row
        async with conn.execute(
            "SELECT price_per_call, feature_pricing FROM ai_models WHERE id=?", (int(model_id),)
        ) as cur:
            row = await cur.fetchone()
    if not row:
        # model 被删了仍有调用兜底到 feature 默认 / 1.0
        return _dec(DEFAULT_FEATURE_PRICE.get(feature, "1.0"))
    keys = set(row.keys())
    # 原始值（不过 _dec）：用来区分 NULL/未配 与 显式 0。显式 0 = 免费模型，
    # 必须尊重；以前 `Decimal("0") or 1` 把刻意配的免费模型扣成 1 点（bug）。
    raw_ppc = row["price_per_call"] if "price_per_call" in keys else None
    fp_raw = row["feature_pricing"] if "feature_pricing" in keys else "{}"
    try:
        fp = json.loads(fp_raw or "{}")
    except Exception:
        fp = {}

    def _nonneg(v) -> Decimal:
        # 负数 / 非法值钳到 0（免费），杜绝负单价变相充值白嫖（P1-7）
        d = _dec(v)
        return d if d > 0 else Decimal("0")

    # 1) feature_pricing 显式配了该 feature → 最高优先（含显式 0 = 该 feature 免费）
    if feature and feature in fp:
        return _nonneg(fp[feature])
    # 2) price_per_call 显式配置（含 0）→ 尊重；仅 NULL/空 才落兜底
    if raw_ppc is not None and str(raw_ppc).strip() != "":
        return _nonneg(raw_ppc)
    # 3) 未配单价 → feature 默认表 → 1.0
    if feature in DEFAULT_FEATURE_PRICE:
        return _dec(DEFAULT_FEATURE_PRICE[feature])
    return Decimal("1")


# ── 余额读取 ───────────────────────────────────────────────────────────────

async def get_balance(user_id: int) -> Decimal:
    async with _db.connect(DB_PATH) as conn:
        conn.row_factory = _db.Row
        async with conn.execute(
            "SELECT balance FROM user_credits WHERE user_id=?", (int(user_id),)
        ) as cur:
            row = await cur.fetchone()
    return _dec(row["balance"]) if row else Decimal("0")


# ── 核心：原子变动（行锁 + 幂等）─────────────────────────────────────────────

async def _apply_change(
    user_id: int, *, kind: str, delta: Decimal,
    model_id: Optional[int] = None, feature: str = "", task_ref: str = "",
    operator: str = "", note: str = "", allow_negative: bool = False,
) -> Decimal:
    """在一个事务里：锁余额行 → 幂等检查 → 改余额 → 写流水。返回新余额。

    delta：对余额的有符号影响（deduct 为负，其它为正）。amount 列就存 delta。
    allow_negative=False 且会变负 → raise InsufficientCredits（事务回滚）。
    """
    uid = int(user_id)
    is_pg = _db.is_pg()
    # connect_tx：SQLite 走 autocommit，事务边界由本函数显式控制——这是
    # BEGIN IMMEDIATE 写锁真正生效、ROLLBACK 可靠的前提（见 db.connect_tx 注释）。
    async with _db.connect_tx(DB_PATH) as conn:
        conn.row_factory = _db.Row
        if not is_pg:
            # busy_timeout 不持久化，每条新连接都要设；否则并发写锁竞争即时报
            # 'database is locked' 而非排队等待。
            await conn.execute("PRAGMA busy_timeout=5000")
        await conn.execute("BEGIN IMMEDIATE")  # PG 适配层把它翻成 BEGIN
        try:
            # 锁并取当前余额行；不存在则建一行 0
            if is_pg:
                async with conn.execute(
                    "SELECT balance FROM user_credits WHERE user_id=? FOR UPDATE", (uid,)
                ) as cur:
                    row = await cur.fetchone()
            else:
                async with conn.execute(
                    "SELECT balance FROM user_credits WHERE user_id=?", (uid,)
                ) as cur:
                    row = await cur.fetchone()
            if row is None:
                await conn.execute("INSERT INTO user_credits(user_id, balance) VALUES (?, 0)", (uid,))
                cur_balance = Decimal("0")
            else:
                cur_balance = _dec(row["balance"])

            # 幂等：同一 task_ref 的同类变动已落账 → 直接返回当前余额（不重复扣/退/发）。
            # deduct 防重试/重复提交双扣；refund 防整操作重试累计多退（P0-4）；
            # grant 防月度免费额度并发/重投递双倍发放（事务内 SELECT+INSERT 原子）。
            if kind in ("deduct", "refund", "grant") and task_ref:
                async with conn.execute(
                    "SELECT 1 FROM credit_ledger WHERE task_ref=? AND kind=? LIMIT 1",
                    (task_ref, kind),
                ) as cur:
                    if await cur.fetchone():
                        await conn.execute("ROLLBACK")  # 无改动，释放写锁
                        return cur_balance

            new_balance = (cur_balance + delta).quantize(_Q, rounding=ROUND_HALF_UP)
            if new_balance < 0 and not allow_negative:
                await conn.execute("ROLLBACK")
                raise InsufficientCredits(cur_balance, abs(delta))

            await conn.execute(
                "UPDATE user_credits SET balance=?, updated_at=datetime('now','localtime') WHERE user_id=?",
                (str(new_balance), uid),
            )
            await conn.execute(
                "INSERT INTO credit_ledger"
                "(user_id, kind, amount, balance_after, model_id, feature, task_ref, operator, note) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (uid, kind, str(delta), str(new_balance), model_id, feature, task_ref, operator, note),
            )
            await conn.execute("COMMIT")
            logger.info(
                "[billing] uid=%s kind=%s delta=%s balance=%s feature=%s ref=%s",
                uid, kind, delta, new_balance, feature or "-", task_ref or "-",
            )
            return new_balance
        except InsufficientCredits:
            raise  # ROLLBACK 已在上面显式执行
        except Exception:
            # autocommit 模式不会自动回滚，必须显式 ROLLBACK
            try:
                await conn.execute("ROLLBACK")
            except Exception:
                pass
            raise


# ── 对外 API ───────────────────────────────────────────────────────────────

async def deduct(
    user_id: int, *, cost, model_id: Optional[int] = None,
    feature: str = "", task_ref: str = "",
) -> Decimal:
    """扣费。cost <= 0 → no-op。task_ref 是幂等键，不传则自动生成（但建议调用方传稳定值）。
    余额不足 → raise InsufficientCredits（不会扣，调用方应据此不发起 AI 请求）。"""
    c = _dec(cost)
    if c <= 0:
        return await get_balance(user_id)
    ref = task_ref or f"auto:{uuid.uuid4().hex}"
    return await _apply_change(
        user_id, kind="deduct", delta=-c,
        model_id=model_id, feature=feature, task_ref=ref,
    )


async def refund(
    user_id: int, *, cost, model_id: Optional[int] = None,
    feature: str = "", task_ref: str = "",
) -> Decimal:
    """退款（AI 调用失败后调）。cost <= 0 → no-op。允许把余额加成任意值（不限制）。"""
    c = _dec(cost)
    if c <= 0:
        return await get_balance(user_id)
    return await _apply_change(
        user_id, kind="refund", delta=c,
        model_id=model_id, feature=feature, task_ref=task_ref, allow_negative=True,
    )


async def recharge(user_id: int, amount, *, operator: str, note: str = "") -> Decimal:
    """admin 给用户充值。amount 必须 > 0。"""
    a = _dec(amount)
    if a <= 0:
        raise ValueError("充值金额必须 > 0")
    return await _apply_change(
        user_id, kind="recharge", delta=a, operator=operator, note=note, allow_negative=True,
    )


async def grant(user_id: int, amount, *, note: str = "monthly_free") -> Decimal:
    """系统赠送（每月免费额度等）。amount <= 0 → no-op。"""
    a = _dec(amount)
    if a <= 0:
        return await get_balance(user_id)
    return await _apply_change(
        user_id, kind="grant", delta=a, operator="system", note=note, allow_negative=True,
    )


async def adjust(user_id: int, delta, *, operator: str, note: str) -> Decimal:
    """admin 手动纠错。delta 可正可负。note 必填（说明原因，进流水审计）。"""
    if not note:
        raise ValueError("adjust 必须填 note 说明原因")
    d = _dec(delta)
    if d == 0:
        return await get_balance(user_id)
    return await _apply_change(
        user_id, kind="adjust", delta=d, operator=operator, note=note, allow_negative=True,
    )


# ── 查询 / 对账 ─────────────────────────────────────────────────────────────

async def list_ledger(user_id: int, *, limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    async with _db.connect(DB_PATH) as conn:
        conn.row_factory = _db.Row
        async with conn.execute(
            "SELECT id, kind, amount, balance_after, model_id, feature, task_ref, operator, note, created_at "
            "FROM credit_ledger WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
            (int(user_id), int(limit), int(offset)),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def reconcile(user_id: int) -> Tuple[bool, Decimal, Decimal]:
    """对账：返回 (是否一致, 余额表里的值, 流水累计值)。
    一致 == True 才说明账没乱。线上可以定时跑这个对所有用户做巡检。"""
    uid = int(user_id)
    bal = await get_balance(uid)
    async with _db.connect(DB_PATH) as conn:
        conn.row_factory = _db.Row
        async with conn.execute(
            "SELECT amount FROM credit_ledger WHERE user_id=?", (uid,)
        ) as cur:
            rows = await cur.fetchall()
    total = sum((_dec(r["amount"]) for r in rows), Decimal("0")).quantize(_Q)
    return (total == bal, bal, total)


async def monthly_grant_all_users(*, ym: Optional[str] = None) -> Dict[str, Any]:
    """每月 1 号给所有活跃用户按 plan.monthly_credits 送点。

    幂等：task_ref = f"monthly_grant:{user_id}:{YYYY-MM}"，同月只送一次。
    返回 {month, total, granted, skipped_dup, skipped_zero, errors}。
    """
    from datetime import datetime
    from . import plans as _plans
    from . import auth_service as _auth

    month = ym or datetime.now().strftime("%Y-%m")
    # 拉所有用户 + 套餐（users.db 在 auth_service）
    try:
        users = _auth.list_users()  # admin 视图：[{id, username, plan, ...}]
    except Exception as exc:  # pragma: no cover
        logger.exception("monthly_grant_all_users: list_users failed: %s", exc)
        return {"month": month, "total": 0, "granted": 0, "errors": [str(exc)]}

    granted = skipped_dup = skipped_zero = 0
    errors: List[str] = []

    for u in users:
        uid = int(u.get("id") or 0)
        if uid <= 0:
            continue
        # 跳过封禁/未激活用户
        if not u.get("is_active") or (u.get("status") or "active") != "active":
            continue
        plan_key = (u.get("plan") or "free").strip().lower()
        amount = _plans.get_plan(plan_key).get("monthly_credits", 0) or 0
        if amount <= 0:
            skipped_zero += 1
            continue
        ref = f"monthly_grant:{uid}:{month}"
        # 用 ledger 查重（grant 不走 deduct 的幂等支路，自己查）
        try:
            async with _db.connect(DB_PATH) as conn:
                conn.row_factory = _db.Row
                async with conn.execute(
                    "SELECT 1 FROM credit_ledger WHERE task_ref=? AND kind='grant' LIMIT 1",
                    (ref,),
                ) as cur:
                    if await cur.fetchone():
                        skipped_dup += 1
                        continue
            await _apply_change(
                uid, kind="grant", delta=_dec(amount),
                operator="system", task_ref=ref,
                note=f"plan={plan_key} monthly free credits {month}",
                allow_negative=True,
            )
            granted += 1
        except Exception as exc:  # pragma: no cover
            logger.exception("monthly grant failed for user %s: %s", uid, exc)
            errors.append(f"uid={uid}: {exc}")

    logger.info(
        "monthly_grant_all_users %s: total=%d granted=%d skipped_dup=%d skipped_zero=%d errors=%d",
        month, len(users), granted, skipped_dup, skipped_zero, len(errors),
    )
    return {
        "month": month,
        "total": len(users),
        "granted": granted,
        "skipped_dup": skipped_dup,
        "skipped_zero": skipped_zero,
        "errors": errors,
    }


async def reconcile_all() -> List[Tuple[int, Decimal, Decimal]]:
    """巡检所有有流水的用户，返回 [(user_id, balance, ledger_sum), ...]（只返回不一致的）。"""
    async with _db.connect(DB_PATH) as conn:
        conn.row_factory = _db.Row
        async with conn.execute("SELECT DISTINCT user_id FROM credit_ledger") as cur:
            uids = [r["user_id"] for r in await cur.fetchall()]
    bad = []
    for uid in uids:
        ok, bal, total = await reconcile(uid)
        if not ok:
            bad.append((uid, bal, total))
    return bad
