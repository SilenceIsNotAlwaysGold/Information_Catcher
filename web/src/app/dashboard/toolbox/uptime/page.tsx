"use client";

/**
 * 服务监控（uptime-kuma 思路简化版）
 *  - 登记一组 URL → 立即探活 / 看历史；失败时推飞书
 *  - 不耗 AI 点数
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Switch } from "@nextui-org/switch";
import { Activity, Plus, Trash2, Play, RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader, BetaBadge } from "@/components/ui";

const API = (p: string) => `/api/toolbox/uptime${p}`;

type Monitor = {
  id: number; name: string; url: string; method: string;
  expected_status: number; timeout_seconds: number; interval_seconds: number;
  enabled: number; notify_after_fails: number;
  last_check_at: string; last_status: string; last_latency_ms: number; last_error: string;
  consecutive_fail: number;
};
type Check = {
  id: number; status: string; http_status: number; latency_ms: number;
  error: string; checked_at: string;
};

const STATUS_COLOR: Record<string, any> = {
  ok: "success", down: "danger", error: "danger", unknown: "default",
};

export default function UptimePage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [list, setList] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);

  // 新建表单
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("GET");
  const [expectStatus, setExpectStatus] = useState(200);
  const [intervalSec, setIntervalSec] = useState(300);
  const [creating, setCreating] = useState(false);

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/monitors"), { headers });
      if (r.ok) {
        const d = await r.json();
        setList(d.monitors || []);
      }
    } finally { setLoading(false); }
  }, [token, headers]);
  useEffect(() => { loadList(); }, [loadList]);

  const loadChecks = useCallback(async (mid: number) => {
    const r = await fetch(API(`/monitors/${mid}/checks?limit=50`), { headers });
    if (r.ok) {
      const d = await r.json();
      setChecks(d.checks || []);
    }
  }, [headers]);
  useEffect(() => { if (selectedId) loadChecks(selectedId); else setChecks([]); }, [selectedId, loadChecks]);

  const handleCreate = async () => {
    if (!name.trim() || !url.trim()) { toastErr("name + url 必填"); return; }
    setCreating(true);
    try {
      const r = await fetch(API("/monitors"), {
        method: "POST", headers,
        body: JSON.stringify({
          name, url, method, expected_status: expectStatus,
          interval_seconds: intervalSec, timeout_seconds: 15, notify_after_fails: 1,
          enabled: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toastErr(d.detail || "登记失败"); return; }
      setName(""); setUrl("");
      await loadList();
      toastOk("已登记");
    } finally { setCreating(false); }
  };

  const handleDelete = async (mid: number) => {
    if (!confirm("删除这个监控？历史检查记录一起删。")) return;
    const r = await fetch(API(`/monitors/${mid}`), { method: "DELETE", headers });
    if (r.ok) {
      if (selectedId === mid) setSelectedId(null);
      await loadList();
    }
  };

  const handleCheckNow = async (mid: number) => {
    const r = await fetch(API(`/monitors/${mid}/check-now`), { method: "POST", headers });
    const d = await r.json();
    if (r.ok) {
      toastOk(`探活：${d.status}（${d.latency_ms} ms）`);
      await loadList();
      if (selectedId === mid) await loadChecks(mid);
    } else { toastErr(d.detail || "探活失败"); }
  };

  const toggleEnabled = async (m: Monitor, on: boolean) => {
    const r = await fetch(API(`/monitors/${m.id}`), {
      method: "PUT", headers,
      body: JSON.stringify({
        name: m.name, url: m.url, method: m.method,
        expected_status: m.expected_status, timeout_seconds: m.timeout_seconds,
        interval_seconds: m.interval_seconds,
        notify_after_fails: m.notify_after_fails, enabled: on,
      }),
    });
    if (r.ok) await loadList();
  };

  return (
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="toolbox"
        icon={Activity}
        title="服务监控"
        badge={<BetaBadge />}
        hint="登记 URL → 立即探活 / 看历史。连续失败达阈值会推飞书群。不耗 AI 点数。"
      />

      {/* 新建 */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <Plus size={16} /><span className="font-medium">登记新监控</span>
        </CardHeader>
        <CardBody>
          <div className="flex gap-2 flex-wrap items-end">
            <Input label="名称" size="sm" className="w-44"
              value={name} onValueChange={setName} placeholder="如：官网首页" />
            <Input label="URL" size="sm" className="flex-1 min-w-[260px]"
              value={url} onValueChange={setUrl} placeholder="https://example.com" />
            <Select label="方法" size="sm" className="w-24"
              selectedKeys={[method]}
              onSelectionChange={(k) => { const v = Array.from(k)[0]; if (v) setMethod(String(v)); }}>
              <SelectItem key="GET" value="GET">GET</SelectItem>
              <SelectItem key="HEAD" value="HEAD">HEAD</SelectItem>
              <SelectItem key="POST" value="POST">POST</SelectItem>
            </Select>
            <Input label="预期状态码" size="sm" type="number" className="w-28"
              value={String(expectStatus)} onValueChange={(v) => setExpectStatus(Number(v) || 200)} />
            <Input label="间隔（秒）" size="sm" type="number" className="w-28"
              value={String(intervalSec)} onValueChange={(v) => setIntervalSec(Math.max(60, Number(v) || 300))} />
            <Button size="sm" color="primary" startContent={<Plus size={14} />}
              isLoading={creating} onPress={handleCreate}>登记</Button>
          </div>
        </CardBody>
      </Card>

      {/* 列表 */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity size={16} /><span className="font-medium">我的监控</span>
            <Chip size="sm" variant="flat">{list.length}</Chip>
          </div>
          <Button size="sm" variant="light" isIconOnly onPress={loadList}><RefreshCw size={14} /></Button>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载中…</div>
          ) : list.length === 0 ? (
            <p className="text-sm text-default-400">还没监控目标，上方登记第一个。</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-default-500 border-b border-divider">
                  <th className="py-2 pr-2">名称</th>
                  <th className="pr-2">URL</th>
                  <th className="pr-2">状态</th>
                  <th className="pr-2">延时</th>
                  <th className="pr-2">最近探活</th>
                  <th className="pr-2">启用</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id} className={`border-b border-default-100 ${selectedId === m.id ? "bg-default-50" : ""}`}>
                    <td className="py-2 pr-2 cursor-pointer" onClick={() => setSelectedId(m.id)}>
                      <b>{m.name}</b>
                      <p className="text-[10px] text-default-400">{m.method} · 期望 {m.expected_status} · 每 {m.interval_seconds}s</p>
                    </td>
                    <td className="pr-2 max-w-[260px] truncate text-default-500">{m.url}</td>
                    <td className="pr-2">
                      <Chip size="sm" variant="flat" color={STATUS_COLOR[m.last_status] || "default"}>
                        {m.last_status}
                      </Chip>
                      {m.consecutive_fail > 0 && (
                        <span className="text-[10px] text-danger ml-1">×{m.consecutive_fail}</span>
                      )}
                    </td>
                    <td className="pr-2 text-default-500">{m.last_latency_ms || "-"} ms</td>
                    <td className="pr-2 text-default-400 text-xs">{m.last_check_at?.slice(5, 16) || "—"}</td>
                    <td className="pr-2">
                      <Switch size="sm" isSelected={!!m.enabled}
                        onValueChange={(on) => toggleEnabled(m, on)} />
                    </td>
                    <td className="pr-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="flat" color="primary" startContent={<Play size={12} />}
                          onPress={() => handleCheckNow(m.id)}>测一下</Button>
                        <Button size="sm" variant="light" color="danger" isIconOnly
                          onPress={() => handleDelete(m.id)}><Trash2 size={14} /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {/* 历史 */}
      {selectedId && (
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Activity size={16} /><span className="font-medium">最近 50 次探活记录</span>
          </CardHeader>
          <CardBody>
            {checks.length === 0 ? (
              <p className="text-sm text-default-400">还没历史，点上面"测一下"。</p>
            ) : (
              <div className="space-y-1 text-xs">
                {checks.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 py-1 border-b border-default-100">
                    <Chip size="sm" variant="flat" color={STATUS_COLOR[c.status] || "default"}>{c.status}</Chip>
                    <span className="text-default-500">HTTP {c.http_status || "-"}</span>
                    <span className="text-default-500">{c.latency_ms} ms</span>
                    <span className="text-default-400 ml-auto">{c.checked_at?.slice(5, 19)}</span>
                    {c.error && <span className="text-danger truncate max-w-[260px]">{c.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
