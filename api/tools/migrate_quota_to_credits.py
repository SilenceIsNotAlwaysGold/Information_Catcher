# -*- coding: utf-8 -*-
"""旧配额（daily_usage / plan）→ v2 点数（user_credits）迁移工具。

一次性命令。把所有活跃用户按 plan.monthly_credits × multiplier 一次性
赠送到 user_credits.balance，task_ref = `migration_v2:{uid}` 幂等。

  # 预演（不写库）
  uv run python -m api.tools.migrate_quota_to_credits --dry-run

  # 默认 1×（送一个月免费额度）
  uv run python -m api.tools.migrate_quota_to_credits

  # 给老用户加倍福利（送 3 个月）
  uv run python -m api.tools.migrate_quota_to_credits --multiplier 3

  # 只迁移某几个 uid（调试用）
  uv run python -m api.tools.migrate_quota_to_credits --uid 1 --uid 7

注意：
- enterprise plan 的 monthly_credits=0 → 跳过（按需 admin 手工 recharge）
- 已经领过 migration_v2 grant 的用户不会重复领（看 credit_ledger.task_ref）
- 不读 daily_usage 历史用量；那只是用来确认"活跃"的辅助指标。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from decimal import Decimal
from typing import List, Optional

from ..services import auth_service, billing_service, plans
from ..services import db as _db
from ..services import monitor_db

logger = logging.getLogger(__name__)


async def _already_migrated(uid: int) -> bool:
    """看 credit_ledger 里这个用户有没有 `migration_v2:{uid}` 的 grant。"""
    ref = f"migration_v2:{uid}"
    async with _db.connect(billing_service.DB_PATH) as conn:
        async with conn.execute(
            "SELECT 1 FROM credit_ledger WHERE task_ref=? AND kind='grant' LIMIT 1",
            (ref,),
        ) as cur:
            return (await cur.fetchone()) is not None


async def _daily_usage_summary(uid: int) -> str:
    """打印用：返回该用户旧账期的活跃度（用过几天 AI / 累计图数）。"""
    try:
        async with _db.connect(monitor_db.DB_PATH) as conn:
            async with conn.execute(
                "SELECT COUNT(DISTINCT date), "
                "       COALESCE(SUM(image_gen_count),0), "
                "       COALESCE(SUM(text_gen_count),0) "
                "  FROM daily_usage WHERE user_id=?",
                (uid,),
            ) as cur:
                row = await cur.fetchone()
        if not row:
            return "(无 daily_usage)"
        days, imgs, texts = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)
        if days == 0:
            return "(无历史 AI 用量)"
        return f"活跃 {days} 天 · 累计图 {imgs} · 文 {texts}"
    except Exception as exc:
        return f"(daily_usage 查询失败: {exc})"


async def run(*, dry_run: bool, multiplier: float, only_uids: Optional[List[int]] = None) -> int:
    users = auth_service.list_users()
    if only_uids:
        users = [u for u in users if int(u.get("id") or 0) in set(only_uids)]
    if not users:
        print("没有用户可迁移。")
        return 0

    print(f"\n{'='*72}")
    print(f"v2 迁移：plan.monthly_credits × {multiplier} → user_credits.balance")
    print(f"  模式：{'DRY-RUN（不写库）' if dry_run else '正式执行'}")
    print(f"  范围：{len(users)} 个用户")
    print(f"{'='*72}\n")

    granted = skipped_dup = skipped_zero = skipped_inactive = 0
    total_credits = Decimal("0")
    errors: List[str] = []

    for u in users:
        uid = int(u.get("id") or 0)
        uname = u.get("username") or f"user_{uid}"
        plan_key = (u.get("plan") or "free").strip().lower()
        is_active = u.get("is_active") and (u.get("status") or "active") == "active"
        base = plans.get_plan(plan_key).get("monthly_credits") or 0
        amount = Decimal(str(base)) * Decimal(str(multiplier))

        if not is_active:
            skipped_inactive += 1
            print(f"  ⏭  uid={uid:<4} {uname:<24} [{plan_key:<10}] 跳过（账号未激活）")
            continue
        if amount <= 0:
            skipped_zero += 1
            print(f"  ⏭  uid={uid:<4} {uname:<24} [{plan_key:<10}] 跳过（plan 无月度免费额度）")
            continue
        if await _already_migrated(uid):
            skipped_dup += 1
            print(f"  ✓  uid={uid:<4} {uname:<24} [{plan_key:<10}] 已迁移过，跳过")
            continue

        usage = await _daily_usage_summary(uid)
        bal = await billing_service.get_balance(uid)
        action = "[DRY] 将赠送" if dry_run else "已赠送"
        print(f"  →  uid={uid:<4} {uname:<24} [{plan_key:<10}] "
              f"余额 {bal} → +{amount} 点（{usage}）")
        if not dry_run:
            try:
                await billing_service._apply_change(
                    uid, kind="grant", delta=Decimal(str(amount)),
                    operator="migration_v2",
                    task_ref=f"migration_v2:{uid}",
                    note=f"v2 迁移：plan={plan_key} × {multiplier}",
                    allow_negative=True,
                )
                granted += 1
            except Exception as exc:
                errors.append(f"uid={uid}: {exc}")
                print(f"     ⚠ 失败: {exc}")
                continue
        else:
            granted += 1
        total_credits += amount

    print(f"\n{'='*72}")
    print(f"汇总：")
    print(f"  将赠送：     {granted} 人，累计 {total_credits} 点" if dry_run
          else f"  已赠送：     {granted} 人，累计 {total_credits} 点")
    print(f"  已迁移过：   {skipped_dup}")
    print(f"  plan 0 额：  {skipped_zero}")
    print(f"  未激活：     {skipped_inactive}")
    if errors:
        print(f"  失败：       {len(errors)}")
        for e in errors:
            print(f"    - {e}")
    print(f"{'='*72}\n")
    if dry_run:
        print("提示：去掉 --dry-run 再跑一次即可正式提交。")
    return 0 if not errors else 1


def main() -> None:
    ap = argparse.ArgumentParser(description="旧配额 → v2 点数迁移")
    ap.add_argument("--dry-run", action="store_true", help="预演，不写库")
    ap.add_argument("--multiplier", type=float, default=1.0,
                    help="对 plan.monthly_credits 的倍数（默认 1）")
    ap.add_argument("--uid", action="append", type=int, default=None,
                    help="只迁移指定 uid，可多次传")
    args = ap.parse_args()

    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(name)s: %(message)s")
    rc = asyncio.run(run(
        dry_run=bool(args.dry_run),
        multiplier=float(args.multiplier),
        only_uids=args.uid,
    ))
    sys.exit(rc)


if __name__ == "__main__":
    main()
