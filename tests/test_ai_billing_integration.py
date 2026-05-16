# -*- coding: utf-8 -*-
"""ai_client × billing_service 集成测试。

验证三条关键路径：
  1. AI 调用成功 → 按模型×feature 扣点数
  2. AI 调用失败 → 自动退款（净额 0）
  3. 余额不足 → 抛 InsufficientCredits，且不发 HTTP 请求

用 monkeypatch mock httpx.AsyncClient + _resolve_model，不打真实网络。
"""
import json
import os
import tempfile
from decimal import Decimal

import pytest
import pytest_asyncio


# ── mock httpx ─────────────────────────────────────────────────────────────

class _FakeResp:
    def __init__(self, json_data, status=200):
        self._j = json_data
        self.status_code = status
        self.text = json.dumps(json_data)
        self.headers = {"content-type": "application/json"}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._j


class _FakeClient:
    """可配的假 httpx.AsyncClient。_BEHAVIOR 控制 post 返回什么 / 是否抛 / 是否被调用过。"""
    called = 0
    mode = "ok"  # ok | http_error | raise

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return None

    async def post(self, url, **k):
        _FakeClient.called += 1
        if _FakeClient.mode == "raise":
            raise RuntimeError("network down")
        if _FakeClient.mode == "http_error":
            return _FakeResp({"error": "bad"}, status=500)
        return _FakeResp({
            "choices": [{"message": {"content": "改写后的文案～"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
        })


@pytest_asyncio.fixture()
async def setup(monkeypatch):
    os.environ["PULSE_DB_DRIVER"] = "sqlite"
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    from api.services import monitor_db
    monkeypatch.setattr(monitor_db, "DB_PATH", tmp.name)
    from api.services import billing_service as bs
    from api.services import ai_client as ac
    monkeypatch.setattr(bs, "DB_PATH", tmp.name)
    await monitor_db.init_db()

    # 造一个文本模型 id=1：price_per_call=1，feature_pricing={"text_rewrite": 0.5}
    import aiosqlite
    async with aiosqlite.connect(tmp.name) as db:
        await db.execute("INSERT INTO ai_providers(name, base_url, api_key, enabled) VALUES('p','http://x/v1','k',1)")
        await db.execute(
            "INSERT INTO ai_models(provider_id, model_id, display_name, usage_type, published, "
            "price_per_call, feature_pricing, supports_vision) "
            "VALUES(1,'m1','M1','text',1,1,'{\"text_rewrite\": 0.5}',0)"
        )
        await db.commit()

    # mock _resolve_model：永远返回 id=1 那个模型
    async def _fake_resolve(*, usage_type, model_row_id=None, user_id=None):
        return ac._ResolvedModel(
            model_row_id=1, model_id="m1", display_name="M1", usage_type="text",
            provider_id=1, base_url="http://x/v1", api_key="k", extra_config={},
            max_concurrent=0, supports_vision=0,
        )
    monkeypatch.setattr(ac, "_resolve_model", _fake_resolve)
    # mock httpx
    monkeypatch.setattr(ac.httpx, "AsyncClient", _FakeClient)
    # mock _log_usage（不写 ai_usage_logs，避免噪音）
    async def _noop_log(**k):
        return None
    monkeypatch.setattr(ac, "_log_usage", _noop_log)
    _FakeClient.called = 0
    _FakeClient.mode = "ok"

    yield {"bs": bs, "ac": ac, "db_path": tmp.name}
    os.unlink(tmp.name)


@pytest.mark.asyncio
async def test_success_deducts(setup):
    bs, ac = setup["bs"], setup["ac"]
    await bs.recharge(1, 100, operator="admin")
    out = await ac.call_text("改写这段", user_id=1, feature="text_rewrite")
    assert out == "改写后的文案～"
    # feature_pricing["text_rewrite"]=0.5 → 扣 0.5
    assert await bs.get_balance(1) == Decimal("99.50")
    ok, bal, total = await bs.reconcile(1)
    assert ok and bal == Decimal("99.50")


@pytest.mark.asyncio
async def test_other_feature_uses_price_per_call(setup):
    bs, ac = setup["bs"], setup["ac"]
    await bs.recharge(1, 100, operator="admin")
    await ac.call_text("xxx", user_id=1, feature="some_other")  # 不在 feature_pricing → price_per_call=1
    assert await bs.get_balance(1) == Decimal("99.00")


@pytest.mark.asyncio
async def test_failure_refunds(setup):
    bs, ac = setup["bs"], setup["ac"]
    await bs.recharge(1, 100, operator="admin")
    _FakeClient.mode = "raise"
    with pytest.raises(Exception):
        await ac.call_text("改写", user_id=1, feature="text_rewrite")
    # 扣了 0.5 又退了 0.5 → 净额 0，余额回到 100
    assert await bs.get_balance(1) == Decimal("100.00")
    ok, bal, total = await bs.reconcile(1)
    assert ok and bal == Decimal("100.00")
    # 流水：recharge + deduct + refund = 3 条
    led = await bs.list_ledger(1)
    kinds = sorted(x["kind"] for x in led)
    assert kinds == ["deduct", "recharge", "refund"]


@pytest.mark.asyncio
async def test_http_error_refunds(setup):
    bs, ac = setup["bs"], setup["ac"]
    await bs.recharge(1, 100, operator="admin")
    _FakeClient.mode = "http_error"
    with pytest.raises(Exception):
        await ac.call_text("改写", user_id=1, feature="text_rewrite")
    assert await bs.get_balance(1) == Decimal("100.00")


@pytest.mark.asyncio
async def test_insufficient_blocks_request(setup):
    bs, ac = setup["bs"], setup["ac"]
    await bs.recharge(1, Decimal("0.3"), operator="admin")  # 只有 0.3，不够 0.5
    _FakeClient.called = 0
    with pytest.raises(bs.InsufficientCredits):
        await ac.call_text("改写", user_id=1, feature="text_rewrite")
    # 关键：HTTP 请求根本没发出去
    assert _FakeClient.called == 0
    # 余额没动
    assert await bs.get_balance(1) == Decimal("0.30")


@pytest.mark.asyncio
async def test_system_call_not_billed(setup):
    bs, ac = setup["bs"], setup["ac"]
    # user_id=None（系统后台调用）→ 不扣费，也不需要余额
    out = await ac.call_text("系统改写", user_id=None, feature="text_rewrite")
    assert out == "改写后的文案～"
    # 没有任何流水
    assert await bs.list_ledger(0) == []


@pytest.mark.asyncio
async def test_variants_bills_per_variant(setup):
    """call_text_variants 内部调 n 次 call_text → 扣 n 次。"""
    bs, ac = setup["bs"], setup["ac"]
    await bs.recharge(1, 100, operator="admin")
    outs = await ac.call_text_variants("改写", n=3, user_id=1, feature="text_rewrite")
    assert len(outs) == 3
    # 3 × 0.5 = 1.5
    assert await bs.get_balance(1) == Decimal("98.50")
