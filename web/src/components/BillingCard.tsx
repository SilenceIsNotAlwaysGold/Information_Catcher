"use client";

/**
 * AI 点数余额卡片 —— 个人中心展示当前余额 + 最近流水 + 各模型单价。
 *
 * v2 起，所有 AI 功能（OCR / 改写 / 生图 / 漫画 / 小说 …）按"点数"计费，
 * 走平台统一渠道。余额不足时 AI 调用会被拦截（402），需联系管理员充值。
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import { Button } from "@nextui-org/button";
import { Spinner } from "@nextui-org/spinner";
import { Coins, Receipt, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr } from "@/lib/toast";

type LedgerRow = {
  id: number;
  kind: string;        // recharge | deduct | refund | grant | adjust
  amount: number;      // signed（deduct 为负）
  balance_after: number;
  model_id: number | null;
  feature: string;
  operator: string;
  note: string;
  created_at: string;
};

type MeResp = { balance: number; recent_ledger: LedgerRow[] };
type PriceModel = {
  id: number; model_id: string; display_name: string; usage_type: string;
  supports_vision: number; price_per_call: number;
  feature_pricing: Record<string, number>; provider_name: string;
};

const KIND_LABEL: Record<string, string> = {
  recharge: "充值", deduct: "消费", refund: "退款", grant: "赠送", adjust: "调整",
};
const KIND_COLOR: Record<string, any> = {
  recharge: "success", grant: "success", refund: "primary", deduct: "default", adjust: "warning",
};

export function BillingCard() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const [me, setMe] = useState<MeResp | null>(null);
  const [prices, setPrices] = useState<PriceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLedger, setShowLedger] = useState(false);
  const [showPrices, setShowPrices] = useState(false);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        fetch("/api/billing/me", { headers }),
        fetch("/api/billing/model-prices", { headers }),
      ]);
      if (r1.ok) setMe(await r1.json());
      if (r2.ok) {
        const d = await r2.json();
        setPrices(d.models || []);
      }
    } catch (e: any) {
      toastErr(`读取余额失败：${e?.message || e}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const bal = me?.balance ?? 0;
  const lowBalance = bal < 5;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Coins size={18} className="text-warning" />
          <span className="font-semibold">AI 点数余额</span>
          {!loading && (
            <Chip size="sm" color={lowBalance ? "danger" : "warning"} variant="flat">
              {bal.toFixed(2)} 点
            </Chip>
          )}
        </div>
        <Button size="sm" variant="light" isIconOnly onPress={load} isLoading={loading}>
          <RefreshCw size={14} />
        </Button>
      </CardHeader>
      <CardBody className="space-y-3">
        {loading || !me ? (
          <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载中…</div>
        ) : (
          <>
            <p className="text-sm text-default-600">
              当前余额 <b className="text-warning text-base">{bal.toFixed(2)}</b> 点。
              {lowBalance && <span className="text-danger ml-1">余额偏低，AI 功能可能很快不可用，请联系管理员充值。</span>}
            </p>
            <p className="text-xs text-default-400">
              AI 功能（OCR / 文案改写 / 生图 / 漫画 / 小说 …）按模型 × 功能扣点；调用失败自动退点。
            </p>

            {/* 最近流水 */}
            <div>
              <button type="button" onClick={() => setShowLedger((v) => !v)}
                className="flex items-center gap-1.5 text-sm text-default-700 hover:opacity-80">
                {showLedger ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Receipt size={14} /> 最近流水（{me.recent_ledger.length} 条）
              </button>
              {showLedger && (
                <div className="mt-2 space-y-1 text-xs">
                  {me.recent_ledger.length === 0 ? (
                    <p className="text-default-400">暂无流水</p>
                  ) : me.recent_ledger.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 py-1 border-b border-default-100">
                      <div className="flex items-center gap-2 min-w-0">
                        <Chip size="sm" variant="flat" color={KIND_COLOR[r.kind] || "default"}>
                          {KIND_LABEL[r.kind] || r.kind}
                        </Chip>
                        <span className="text-default-500 truncate">
                          {r.feature ? r.feature : (r.note || "—")}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={r.amount >= 0 ? "text-success-600" : "text-default-700"}>
                          {r.amount >= 0 ? "+" : ""}{Number(r.amount).toFixed(2)}
                        </span>
                        <span className="text-default-400">余 {Number(r.balance_after).toFixed(2)}</span>
                        <span className="text-default-300">{(r.created_at || "").slice(5, 16)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 模型单价表 */}
            <div>
              <button type="button" onClick={() => setShowPrices((v) => !v)}
                className="flex items-center gap-1.5 text-sm text-default-700 hover:opacity-80">
                {showPrices ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                各模型单价
              </button>
              {showPrices && (
                <div className="mt-2 space-y-1 text-xs">
                  {prices.length === 0 ? (
                    <p className="text-default-400">管理员还没上架任何模型</p>
                  ) : prices.map((m) => (
                    <div key={m.id} className="py-1 border-b border-default-100">
                      <div className="flex items-center gap-2">
                        <Chip size="sm" variant="flat">{m.usage_type === "image" ? "图像" : "文本"}</Chip>
                        <span className="font-medium">{m.display_name}</span>
                        {m.supports_vision ? <Chip size="sm" variant="flat" color="primary">视觉</Chip> : null}
                        <span className="text-default-500 ml-auto">基础 {Number(m.price_per_call).toFixed(2)} 点/次</span>
                      </div>
                      {Object.keys(m.feature_pricing || {}).length > 0 && (
                        <div className="text-default-400 mt-0.5 pl-1">
                          {Object.entries(m.feature_pricing).map(([k, v]) => `${k}: ${Number(v).toFixed(2)}点`).join(" · ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
