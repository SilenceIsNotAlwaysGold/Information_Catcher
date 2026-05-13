"use client";

/**
 * admin AI 点数管理面板（放在 admin/users 页顶部）。
 *  - 给用户充值 / 赠送 / 手动调整
 *  - 查某用户流水 + 对账状态
 *  - 全员对账巡检
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Coins, RefreshCw, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

type U = { id: number; username: string; email?: string; role?: string };
type LedgerRow = {
  id: number; kind: string; amount: number; balance_after: number;
  feature: string; operator: string; note: string; created_at: string;
};

const KIND_LABEL: Record<string, string> = {
  recharge: "充值", deduct: "消费", refund: "退款", grant: "赠送", adjust: "调整",
};
const KIND_COLOR: Record<string, any> = {
  recharge: "success", grant: "success", refund: "primary", deduct: "default", adjust: "warning",
};

export function AdminBillingPanel() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [users, setUsers] = useState<U[]>([]);
  const [uid, setUid] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [delta, setDelta] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [ledgerInfo, setLedgerInfo] = useState<{ balance: number; ok: boolean; sum: number } | null>(null);
  const [reconcile, setReconcile] = useState<{ ok: boolean; mismatches: any[] } | null>(null);

  const loadUsers = async () => {
    if (!token) return;
    try {
      const r = await fetch("/api/auth/admin/users?include_deleted=false", { headers });
      if (r.ok) {
        const d = await r.json();
        const list: U[] = (d.users || d || []).map((x: any) => ({
          id: x.id, username: x.username, email: x.email, role: x.role,
        }));
        setUsers(list);
        if (list.length && !uid) setUid(String(list[0].id));
      }
    } catch { /* ignore */ }
  };
  useEffect(() => { loadUsers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const post = async (path: string, body: any) => {
    const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    return d;
  };

  const doRecharge = async () => {
    const a = parseFloat(amount);
    if (!uid || isNaN(a) || a <= 0) { toastErr("选用户 + 填正数金额"); return; }
    setBusy(true);
    try {
      const d = await post("/api/admin/billing/recharge", { user_id: Number(uid), amount: a, note });
      toastOk(`充值成功，余额 ${d.balance} 点`);
      setAmount(""); setNote("");
      await viewLedger();
    } catch (e: any) { toastErr(`充值失败：${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const doGrant = async () => {
    const a = parseFloat(amount);
    if (!uid || isNaN(a) || a <= 0) { toastErr("选用户 + 填正数金额"); return; }
    setBusy(true);
    try {
      const d = await post("/api/admin/billing/grant", { user_id: Number(uid), amount: a, note: note || "admin_grant" });
      toastOk(`赠送成功，余额 ${d.balance} 点`);
      setAmount(""); setNote("");
      await viewLedger();
    } catch (e: any) { toastErr(`赠送失败：${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const doAdjust = async () => {
    const dlt = parseFloat(delta);
    if (!uid || isNaN(dlt) || dlt === 0) { toastErr("选用户 + 填 delta（可正可负，非 0）"); return; }
    if (!note.trim()) { toastErr("调整必须填备注说明原因"); return; }
    setBusy(true);
    try {
      const d = await post("/api/admin/billing/adjust", { user_id: Number(uid), delta: dlt, note: note.trim() });
      toastOk(`调整成功，余额 ${d.balance} 点`);
      setDelta(""); setNote("");
      await viewLedger();
    } catch (e: any) { toastErr(`调整失败：${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const viewLedger = async () => {
    if (!uid) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/billing/users/${uid}/ledger?limit=100`, { headers });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      setLedger(d.ledger || []);
      setLedgerInfo({ balance: d.balance, ok: d.reconcile_ok, sum: d.ledger_sum });
    } catch (e: any) { toastErr(`查流水失败：${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const doReconcileAll = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/billing/reconcile", { headers });
      const d = await r.json();
      setReconcile(d);
      if (d.ok) toastOk("全员对账通过，账没乱");
      else toastErr(`发现 ${d.mismatches.length} 个用户账不一致！`);
    } catch (e: any) { toastErr(`对账失败：${e?.message || e}`); }
    finally { setBusy(false); }
  };

  const selectedUser = users.find((u) => String(u.id) === uid);

  return (
    <Card className="mb-4">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Coins size={18} className="text-warning" />
          <span className="font-semibold">AI 点数管理</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="flat" startContent={<ShieldCheck size={14} />}
            isLoading={busy} onPress={doReconcileAll}>全员对账</Button>
          <Button size="sm" variant="light" isIconOnly onPress={loadUsers}><RefreshCw size={14} /></Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-2 items-end">
          <Select label="用户" size="sm" className="min-w-[200px]"
            selectedKeys={uid ? [uid] : []}
            onSelectionChange={(k) => { const v = Array.from(k)[0]; if (v) setUid(String(v)); }}>
            {users.map((u) => (
              <SelectItem key={String(u.id)} value={String(u.id)}>
                #{u.id} {u.username}{u.role === "admin" ? " (admin)" : ""}
              </SelectItem>
            ))}
          </Select>
          <Input label="金额（充值/赠送）" size="sm" type="number" className="w-36"
            value={amount} onValueChange={setAmount} placeholder="如 100" />
          <Input label="delta（调整，可负）" size="sm" type="number" className="w-40"
            value={delta} onValueChange={setDelta} placeholder="如 -5 / 10" />
          <Input label="备注（调整必填）" size="sm" className="flex-1 min-w-[160px]"
            value={note} onValueChange={setNote} placeholder="充值说明 / 纠错原因" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" color="primary" isLoading={busy} onPress={doRecharge}>充值</Button>
          <Button size="sm" color="success" variant="flat" isLoading={busy} onPress={doGrant}>赠送（免费额度）</Button>
          <Button size="sm" color="warning" variant="flat" isLoading={busy} onPress={doAdjust}>手动调整</Button>
          <Button size="sm" variant="flat" isLoading={busy} onPress={viewLedger}>查该用户流水</Button>
        </div>

        {/* 流水展示 */}
        {ledgerInfo && (
          <div className="text-xs space-y-1 pt-2 border-t border-default-200">
            <div className="flex items-center gap-3">
              <span>用户 <b>{selectedUser?.username || uid}</b> 余额：<b className="text-warning">{ledgerInfo.balance.toFixed(2)}</b> 点</span>
              <Chip size="sm" color={ledgerInfo.ok ? "success" : "danger"} variant="flat">
                {ledgerInfo.ok ? "对账一致" : `账不一致！流水累计=${ledgerInfo.sum.toFixed(2)}`}
              </Chip>
            </div>
            {(ledger || []).length === 0 ? (
              <p className="text-default-400">暂无流水</p>
            ) : (ledger || []).slice(0, 30).map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 py-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Chip size="sm" variant="flat" color={KIND_COLOR[r.kind] || "default"}>{KIND_LABEL[r.kind] || r.kind}</Chip>
                  <span className="text-default-500 truncate">{r.feature || r.note || "—"}</span>
                  {r.operator ? <span className="text-default-300">by {r.operator}</span> : null}
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

        {/* 全员对账结果 */}
        {reconcile && !reconcile.ok && (
          <div className="text-xs text-danger pt-2 border-t border-danger/20">
            <p className="font-medium">⚠️ 账不一致的用户：</p>
            {reconcile.mismatches.map((m: any) => (
              <p key={m.user_id}>user #{m.user_id}: 余额 {m.balance} ≠ 流水累计 {m.ledger_sum}</p>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
