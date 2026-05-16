# -*- coding: utf-8 -*-
"""计费系统单元测试 —— 余额、扣费、幂等、并发、对账。

跑：cd redbook-v2 && uv run pytest tests/test_billing_service.py -v
（用临时 sqlite 库，不碰真实数据。）
"""
import asyncio
import os
import tempfile
from decimal import Decimal

import pytest
import pytest_asyncio


@pytest_asyncio.fixture()
async def billing(monkeypatch):
    """把 DB_PATH 指到临时 sqlite，init_db 建表，返回 billing_service 模块。"""
    os.environ["PULSE_DB_DRIVER"] = "sqlite"
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    from api.services import monitor_db
    monkeypatch.setattr(monitor_db, "DB_PATH", tmp.name)
    from api.services import billing_service as bs
    monkeypatch.setattr(bs, "DB_PATH", tmp.name)
    await monitor_db.init_db()
    # 造两个有定价的模型：id=1 price_per_call=1，feature_pricing 配了 ocr=0.3
    #                      id=2 price_per_call=2，无 feature_pricing
    import aiosqlite
    async with aiosqlite.connect(tmp.name) as db:
        await db.execute(
            "INSERT INTO ai_providers(name, base_url, api_key, enabled) VALUES('t','http://x/v1','k',1)"
        )
        await db.execute(
            "INSERT INTO ai_models(provider_id, model_id, display_name, usage_type, published, "
            "price_per_call, feature_pricing) VALUES(1,'m1','M1','text',1,1,'{\"ocr\": 0.3}')"
        )
        await db.execute(
            "INSERT INTO ai_models(provider_id, model_id, display_name, usage_type, published, "
            "price_per_call, feature_pricing) VALUES(1,'m2','M2','image',1,2,'{}')"
        )
        await db.commit()
    yield bs
    os.unlink(tmp.name)


@pytest.mark.asyncio
async def test_initial_balance_zero(billing):
    assert await billing.get_balance(999) == Decimal("0")


@pytest.mark.asyncio
async def test_recharge_then_balance(billing):
    bal = await billing.recharge(1, 100, operator="admin", note="首充")
    assert bal == Decimal("100.00")
    assert await billing.get_balance(1) == Decimal("100.00")
    led = await billing.list_ledger(1)
    assert len(led) == 1 and led[0]["kind"] == "recharge"
    assert Decimal(str(led[0]["amount"])) == Decimal("100")
    assert Decimal(str(led[0]["balance_after"])) == Decimal("100")


@pytest.mark.asyncio
async def test_recharge_rejects_nonpositive(billing):
    with pytest.raises(ValueError):
        await billing.recharge(1, 0, operator="admin")
    with pytest.raises(ValueError):
        await billing.recharge(1, -5, operator="admin")


@pytest.mark.asyncio
async def test_compute_cost(billing):
    # model 1: feature ocr 命中 0.3；其它 feature 用 price_per_call=1
    assert await billing.compute_cost(1, "ocr") == Decimal("0.30")
    assert await billing.compute_cost(1, "image") == Decimal("1.00")
    assert await billing.compute_cost(1, "") == Decimal("1.00")
    # model 2: 无 feature_pricing，全用 price_per_call=2
    assert await billing.compute_cost(2, "ocr") == Decimal("2.00")
    # 系统调用 / 未配模型 → 0
    assert await billing.compute_cost(None, "ocr") == Decimal("0")
    # 不存在的 model → 兜底 feature 默认表（ocr=0.3）
    assert await billing.compute_cost(99999, "ocr") == Decimal("0.30")
    assert await billing.compute_cost(99999, "unknown_feat") == Decimal("1.00")


@pytest.mark.asyncio
async def test_deduct_and_balance(billing):
    await billing.recharge(1, 100, operator="admin")
    bal = await billing.deduct(1, cost=Decimal("30"), model_id=1, feature="ocr", task_ref="t-1")
    assert bal == Decimal("70.00")
    assert await billing.get_balance(1) == Decimal("70.00")


@pytest.mark.asyncio
async def test_deduct_idempotent(billing):
    await billing.recharge(1, 100, operator="admin")
    b1 = await billing.deduct(1, cost=10, model_id=1, feature="ocr", task_ref="same-ref")
    b2 = await billing.deduct(1, cost=10, model_id=1, feature="ocr", task_ref="same-ref")  # 同 ref
    b3 = await billing.deduct(1, cost=10, model_id=1, feature="ocr", task_ref="same-ref")  # 再来
    assert b1 == b2 == b3 == Decimal("90.00")
    assert await billing.get_balance(1) == Decimal("90.00")
    # 只应该有 1 笔 deduct
    led = await billing.list_ledger(1)
    deducts = [x for x in led if x["kind"] == "deduct"]
    assert len(deducts) == 1


@pytest.mark.asyncio
async def test_deduct_insufficient_raises_and_no_change(billing):
    await billing.recharge(1, 50, operator="admin")
    with pytest.raises(billing.InsufficientCredits) as ei:
        await billing.deduct(1, cost=100, model_id=1, feature="ocr", task_ref="t-x")
    assert ei.value.balance == Decimal("50.00")
    assert ei.value.needed == Decimal("100.00")
    # 余额没动，也没留 deduct 流水
    assert await billing.get_balance(1) == Decimal("50.00")
    led = await billing.list_ledger(1)
    assert all(x["kind"] != "deduct" for x in led)


@pytest.mark.asyncio
async def test_refund(billing):
    await billing.recharge(1, 100, operator="admin")
    await billing.deduct(1, cost=30, model_id=1, feature="ocr", task_ref="t-refund")
    assert await billing.get_balance(1) == Decimal("70.00")
    bal = await billing.refund(1, cost=30, model_id=1, feature="ocr", task_ref="t-refund")
    assert bal == Decimal("100.00")
    assert await billing.get_balance(1) == Decimal("100.00")


@pytest.mark.asyncio
async def test_grant_and_adjust(billing):
    await billing.grant(1, 50, note="welcome")
    assert await billing.get_balance(1) == Decimal("50.00")
    await billing.adjust(1, -20, operator="admin", note="客诉退点修正")
    assert await billing.get_balance(1) == Decimal("30.00")
    await billing.adjust(1, 5, operator="admin", note="补偿")
    assert await billing.get_balance(1) == Decimal("35.00")
    # adjust 必须填 note
    with pytest.raises(ValueError):
        await billing.adjust(1, 1, operator="admin", note="")


@pytest.mark.asyncio
async def test_reconcile(billing):
    await billing.recharge(7, 100, operator="admin")
    await billing.deduct(7, cost=15, model_id=1, feature="ocr", task_ref="r1")
    await billing.refund(7, cost=15, model_id=1, feature="ocr", task_ref="r1")
    await billing.deduct(7, cost=40, model_id=2, feature="image", task_ref="r2")
    await billing.grant(7, 10)
    await billing.adjust(7, -3, operator="admin", note="x")
    # 100 - 15 + 15 - 40 + 10 - 3 = 67
    assert await billing.get_balance(7) == Decimal("67.00")
    ok, bal, total = await billing.reconcile(7)
    assert ok is True
    assert bal == total == Decimal("67.00")
    assert await billing.reconcile_all() == []  # 没有不一致


@pytest.mark.asyncio
async def test_concurrent_deduct_no_double_spend(billing):
    """20 个并发 deduct（各扣 5，不同 task_ref）从 100 余额扣 → 应该刚好剩 0，不会扣过头。"""
    await billing.recharge(1, 100, operator="admin")
    tasks = [
        billing.deduct(1, cost=5, model_id=1, feature="ocr", task_ref=f"c-{i}")
        for i in range(20)
    ]
    await asyncio.gather(*tasks)
    assert await billing.get_balance(1) == Decimal("0.00")
    ok, bal, total = await billing.reconcile(1)
    assert ok and bal == Decimal("0.00")
    # 21 笔流水：1 recharge + 20 deduct
    led = await billing.list_ledger(1, limit=100)
    assert len([x for x in led if x["kind"] == "deduct"]) == 20


@pytest.mark.asyncio
async def test_concurrent_deduct_some_fail_when_insufficient(billing):
    """余额 30，30 个并发各扣 5 → 只有 6 笔成功，剩 24 笔余额不足；最终余额 0，不会变负。"""
    await billing.recharge(1, 30, operator="admin")
    async def _try(i):
        try:
            await billing.deduct(1, cost=5, model_id=1, feature="ocr", task_ref=f"f-{i}")
            return True
        except billing.InsufficientCredits:
            return False
    results = await asyncio.gather(*[_try(i) for i in range(30)])
    assert sum(results) == 6           # 恰好 6 笔成功（30 / 5）
    assert await billing.get_balance(1) == Decimal("0.00")
    ok, bal, _ = await billing.reconcile(1)
    assert ok and bal == Decimal("0.00")


@pytest.mark.asyncio
async def test_refund_idempotent(billing):
    """P0-4：同一 (task_ref,kind=refund) 重复退款只生效一次，整操作重试不累计多退。"""
    await billing.recharge(1, 100, operator="admin")
    await billing.deduct(1, cost=30, model_id=1, feature="image", task_ref="r1")
    assert await billing.get_balance(1) == Decimal("70.00")
    b1 = await billing.refund(1, cost=30, model_id=1, feature="image", task_ref="r1")
    b2 = await billing.refund(1, cost=30, model_id=1, feature="image", task_ref="r1")  # 重试
    assert b1 == Decimal("100.00") and b2 == Decimal("100.00")
    assert await billing.get_balance(1) == Decimal("100.00")  # 没被退两次到 130
    led = await billing.list_ledger(1, limit=100)
    assert len([x for x in led if x["kind"] == "refund"]) == 1
    ok, bal, total = await billing.reconcile(1)
    assert ok and bal == Decimal("100.00")


@pytest.mark.asyncio
async def test_insufficient_leaves_no_partial_ledger(billing):
    """P0-1：余额不足时事务整体回滚——余额表不动、流水里没有半条 deduct。"""
    await billing.recharge(1, 10, operator="admin")
    with pytest.raises(billing.InsufficientCredits):
        await billing.deduct(1, cost=999, model_id=1, feature="ocr", task_ref="big")
    assert await billing.get_balance(1) == Decimal("10.00")
    led = await billing.list_ledger(1, limit=100)
    assert [x["kind"] for x in led] == ["recharge"]  # 只有充值，没有 deduct 残留
    ok, bal, total = await billing.reconcile(1)
    assert ok and bal == total == Decimal("10.00")


@pytest.mark.asyncio
async def test_grant_idempotent(billing):
    """P1-2：同一 (task_ref,kind=grant) 月度赠送并发/重投递不双发。"""
    b1 = await billing.grant(1, 50, note="m")
    from api.services import billing_service as bs
    # 直接走 _apply_change 模拟 monthly_grant 的带 ref 赠送，重复两次
    await bs._apply_change(1, kind="grant", delta=Decimal("50"),
                           task_ref="monthly_grant:1:2026-05", note="x", allow_negative=True)
    await bs._apply_change(1, kind="grant", delta=Decimal("50"),
                           task_ref="monthly_grant:1:2026-05", note="x", allow_negative=True)
    assert await billing.get_balance(1) == Decimal("100.00")  # 50(b1) + 50(一次) ，不是 150
    led = await billing.list_ledger(1, limit=100)
    assert len([x for x in led if x["kind"] == "grant"]) == 2


def test_make_task_ref_stable():
    """P0-2：make_task_ref 进程间稳定（短 id 直拼，长文本 md5），不用内置 hash。"""
    from api.services import billing_service as bs
    assert bs.make_task_ref("novel_chapter", 12, 5) == "novel_chapter:12:5"
    long = "x" * 100 + "\n换行"
    r1 = bs.make_task_ref("k", 1, long)
    r2 = bs.make_task_ref("k", 1, long)
    assert r1 == r2 and r1.startswith("k:1:") and len(r1.split(":")[-1]) == 16
