"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { ScrollShadow } from "@nextui-org/scroll-shadow";
import { History, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr } from "@/lib/toast";

type AuditLog = {
  id: number;
  actor_id: number | null;
  actor_username: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: string;
  ip: string;
  user_agent: string;
  created_at: string;
};

const ACTION_PRESETS = [
  "", "login", "register", "logout", "user.create", "user.update",
  "user.delete", "user.password_reset", "user.revoke_tokens",
  "quota.exceeded", "invite.create", "invite.delete", "plan.trial_expired",
];

export default function AdminAuditPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [items, setItems] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ actor_id: "", action: "", target_type: "" });
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 50;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (filter.actor_id.trim()) params.set("actor_id", filter.actor_id.trim());
      if (filter.action.trim()) params.set("action", filter.action.trim());
      if (filter.target_type.trim()) params.set("target_type", filter.target_type.trim());
      const r = await fetch(`/api/auth/admin/audit?${params}`, { headers });
      const data = await r.json();
      if (Array.isArray(data?.items)) {
        setItems(data.items);
        setTotal(data.total || 0);
      }
    } catch (e: any) { toastErr(`加载失败：${e?.message || e}`); }
    finally { setLoading(false); }
  }, [token, headers, offset, filter]);

  useEffect(() => { reload(); }, [reload]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const actionColor = (a: string): "default" | "success" | "warning" | "danger" | "primary" => {
    if (a.startsWith("login.failed") || a.startsWith("quota.exceeded")) return "warning";
    if (a.startsWith("user.delete") || a.startsWith("invite.delete")) return "danger";
    if (a.startsWith("login") || a.startsWith("register")) return "success";
    if (a.startsWith("user.")) return "primary";
    return "default";
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-default-100 text-default-600 p-3">
          <History size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">审计日志</h1>
          <p className="text-sm text-default-500 mt-1">
            登录、注册、用户操作、配额超限、邀请码增删都会被记录。
          </p>
        </div>
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <Input size="sm" label="操作者 ID"
              value={filter.actor_id}
              onValueChange={(v) => { setFilter({ ...filter, actor_id: v }); setOffset(0); }} />
            <div>
              <label className="text-sm text-default-700">动作（前缀匹配）</label>
              <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                value={filter.action}
                onChange={(e) => { setFilter({ ...filter, action: e.target.value }); setOffset(0); }}>
                {ACTION_PRESETS.map((a) => (
                  <option key={a} value={a}>{a || "全部"}</option>
                ))}
              </select>
            </div>
            <Input size="sm" label="目标类型（user / invite / quota）"
              value={filter.target_type}
              onValueChange={(v) => { setFilter({ ...filter, target_type: v }); setOffset(0); }} />
            <div className="flex items-end justify-end gap-2">
              <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />}
                onPress={reload} isLoading={loading}>刷新</Button>
            </div>
          </div>

          {loading && items.length === 0 ? (
            <div className="py-12 flex justify-center"><Spinner /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-default-500 border-b border-divider">
                    <th className="py-2 pr-2">时间</th>
                    <th className="py-2 pr-2">操作者</th>
                    <th className="py-2 pr-2">动作</th>
                    <th className="py-2 pr-2">目标</th>
                    <th className="py-2 pr-2">IP</th>
                    <th className="py-2 pr-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((l) => (
                    <>
                      <tr key={l.id} className="border-b border-divider/50 hover:bg-default-50">
                        <td className="py-2 pr-2 text-xs text-default-500 whitespace-nowrap">
                          {l.created_at}
                        </td>
                        <td className="py-2 pr-2">
                          {l.actor_username || "-"}
                          {l.actor_id && <span className="text-xs text-default-400 ml-1">#{l.actor_id}</span>}
                        </td>
                        <td className="py-2 pr-2">
                          <Chip size="sm" color={actionColor(l.action)} variant="flat">{l.action}</Chip>
                        </td>
                        <td className="py-2 pr-2 text-xs">
                          {l.target_type ? `${l.target_type}:${l.target_id}` : "-"}
                        </td>
                        <td className="py-2 pr-2 text-xs text-default-500">{l.ip || "-"}</td>
                        <td className="py-2 pr-2">
                          {l.metadata && (
                            <Button size="sm" variant="light" isIconOnly
                              onPress={() => toggleExpand(l.id)}>
                              {expanded.has(l.id) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </Button>
                          )}
                        </td>
                      </tr>
                      {expanded.has(l.id) && (
                        <tr key={`${l.id}-meta`} className="border-b border-divider/50 bg-default-50">
                          <td colSpan={6} className="py-2 px-3">
                            <ScrollShadow className="max-h-64">
                              <pre className="text-xs whitespace-pre-wrap break-all text-default-600">
                                {(() => {
                                  try { return JSON.stringify(JSON.parse(l.metadata), null, 2); }
                                  catch { return l.metadata; }
                                })()}
                              </pre>
                            </ScrollShadow>
                            {l.user_agent && (
                              <p className="text-xs text-default-400 mt-2 truncate">UA: {l.user_agent}</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                  {items.length === 0 && !loading && (
                    <tr><td colSpan={6} className="py-12 text-center text-default-400">无记录</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between text-sm text-default-500">
            <span>共 {total} 条；当前 {offset + 1} – {Math.min(offset + items.length, total)}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="flat"
                isDisabled={offset === 0}
                onPress={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                上一页
              </Button>
              <Button size="sm" variant="flat"
                isDisabled={offset + PAGE_SIZE >= total}
                onPress={() => setOffset(offset + PAGE_SIZE)}>
                下一页
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
