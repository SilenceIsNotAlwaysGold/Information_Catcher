"use client";

/**
 * AI 旅游攻略 —— 输入目的地+天数+偏好，AI 生成完整行程（按天分上午/下午/晚上）。
 * 走平台模型，扣 travel_plan 点。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Map, Plus, Trash2, Sparkles, RefreshCw, FileText } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ModelSelector } from "@/components/ModelSelector";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader, BetaBadge } from "@/components/ui";

const API = (p: string) => `/api/studio/travel${p}`;

type PlanListItem = {
  id: number; title: string; dest_city: string; days: number;
  budget: string; travel_style: string; created_at: string;
};
type DayPlan = {
  day: number; morning?: string; afternoon?: string; evening?: string;
  food?: string; transport?: string; cost?: string;
};
type PlanDetail = {
  id: number; title: string; dest_city: string; days: number;
  budget: string; travel_style: string; extra_prefs: string;
  created_at: string;
  plan: { title?: string; days?: DayPlan[]; tips?: string[]; budget_estimate?: string };
};

export default function TravelStudioPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);

  // 表单
  const [dest, setDest] = useState("");
  const [days, setDays] = useState(3);
  const [budget, setBudget] = useState("");
  const [style, setStyle] = useState("");
  const [extra, setExtra] = useState("");
  const [textModelId, setTextModelId] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoadingList(true);
    try {
      const r = await fetch(API("/plans"), { headers });
      if (r.ok) {
        const d = await r.json();
        setPlans(d.plans || []);
      }
    } finally { setLoadingList(false); }
  }, [token, headers]);
  useEffect(() => { loadList(); }, [loadList]);

  const loadDetail = useCallback(async (id: number) => {
    setDetail(null);
    const r = await fetch(API(`/plans/${id}`), { headers });
    if (r.ok) setDetail(await r.json());
  }, [headers]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else setDetail(null); }, [selectedId, loadDetail]);

  const handleGenerate = async () => {
    if (!dest.trim()) { toastErr("请输入目的地"); return; }
    setGenerating(true);
    try {
      const r = await fetch(API("/plans"), {
        method: "POST", headers,
        body: JSON.stringify({
          dest_city: dest.trim(), days, budget, travel_style: style,
          extra_prefs: extra, text_model_id: textModelId,
        }),
      });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!r.ok) { toastErr(d.detail || "生成失败"); return; }
      toastOk(`已生成《${d.title}》`);
      setDest(""); setBudget(""); setStyle(""); setExtra("");
      await loadList();
      setSelectedId(d.id);
    } finally { setGenerating(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("删除这份攻略？")) return;
    const r = await fetch(API(`/plans/${id}`), { method: "DELETE", headers });
    if (r.ok) {
      if (selectedId === id) setSelectedId(null);
      await loadList();
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="studio"
        icon={Map}
        title="AI 旅游攻略"
        badge={<BetaBadge />}
        hint="输入目的地 + 天数 + 偏好，AI 一次性给出完整行程（每天上/下/晚 + 餐饮 + 交通 + 预算 + tips）。扣 travel_plan 点。"
      />

      {/* 生成表单 */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <Sparkles size={16} />
          <span className="font-medium">规划新攻略</span>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex gap-2 flex-wrap items-end">
            <Input label="目的地" size="sm" className="w-44"
              value={dest} onValueChange={setDest} placeholder="如：东京 / 西安 / 大理" />
            <Input label="天数" size="sm" type="number" className="w-24"
              value={String(days)} onValueChange={(v) => setDays(Math.max(1, Math.min(14, Number(v) || 3)))} />
            <Input label="预算（可选）" size="sm" className="w-40"
              value={budget} onValueChange={setBudget} placeholder="如：3000-5000" />
            <Input label="风格（可选）" size="sm" className="w-44"
              value={style} onValueChange={setStyle} placeholder="亲子 / 文艺 / 美食 / 户外" />
            <ModelSelector usage="text" value={textModelId} onChange={setTextModelId}
              label="文本模型（可选）" className="min-w-[220px]" />
          </div>
          <Textarea minRows={2} maxRows={4} size="sm"
            label="其它要求（可选，1000 字内）" labelPlacement="outside"
            value={extra} onValueChange={setExtra}
            placeholder="如：不爬山 / 带小孩 / 喜欢小众咖啡馆 / 避开打卡景点 / 必去某个特定地点 …" />
          <Button color="primary" startContent={<Sparkles size={16} />}
            isLoading={generating} isDisabled={!dest.trim()}
            onPress={handleGenerate}>
            生成攻略（扣 travel_plan 点）
          </Button>
        </CardBody>
      </Card>

      {/* 列表 */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText size={16} />
            <span className="font-medium">我的攻略</span>
            <Chip size="sm" variant="flat">{plans.length}</Chip>
          </div>
          <Button size="sm" variant="light" isIconOnly onPress={loadList}><RefreshCw size={14} /></Button>
        </CardHeader>
        <CardBody>
          {loadingList ? (
            <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载中…</div>
          ) : plans.length === 0 ? (
            <p className="text-sm text-default-400">还没有攻略，上方填表生成第一份。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {plans.map((p) => {
                const on = p.id === selectedId;
                return (
                  <div key={p.id}
                    className={`p-3 rounded-md border-2 cursor-pointer transition ${on ? "border-success bg-success/5" : "border-default-200 hover:border-default-400"}`}
                    onClick={() => setSelectedId(p.id)}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium truncate">{p.title}</span>
                      <Chip size="sm" variant="flat" color="success">{p.days} 天</Chip>
                    </div>
                    <p className="text-xs text-default-500">{p.dest_city}{p.travel_style ? ` · ${p.travel_style}` : ""}{p.budget ? ` · ¥${p.budget}` : ""}</p>
                    <p className="text-[10px] text-default-400 mt-0.5">{p.created_at?.slice(5, 16)}</p>
                    <button type="button" className="text-[11px] text-danger mt-1 hover:underline"
                      onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}>删除</button>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 详情 */}
      {selectedId && !detail && (
        <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载攻略…</div>
      )}
      {detail && (
        <Card>
          <CardHeader>
            <div>
              <p className="font-bold text-lg">{detail.title}</p>
              <p className="text-xs text-default-500">
                {detail.dest_city} · {detail.days} 天{detail.budget ? ` · 预算 ¥${detail.budget}` : ""}{detail.travel_style ? ` · ${detail.travel_style}` : ""}
              </p>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            {(detail.plan.days || []).map((d) => (
              <div key={d.day} className="rounded border border-default-200 p-3 space-y-1">
                <p className="font-medium">Day {d.day}</p>
                {d.morning && <p className="text-sm"><b className="text-warning">上午</b>：{d.morning}</p>}
                {d.afternoon && <p className="text-sm"><b className="text-primary">下午</b>：{d.afternoon}</p>}
                {d.evening && <p className="text-sm"><b className="text-secondary">晚上</b>：{d.evening}</p>}
                {d.food && <p className="text-xs text-default-600">🍜 {d.food}</p>}
                {d.transport && <p className="text-xs text-default-600">🚆 {d.transport}</p>}
                {d.cost && <p className="text-xs text-default-600">💰 {d.cost}</p>}
              </div>
            ))}
            {(detail.plan.tips || []).length > 0 && (
              <div className="rounded border border-warning/30 bg-warning/5 p-3">
                <p className="font-medium text-sm text-warning-700 mb-1">实用 Tips</p>
                <ul className="list-disc ml-5 text-xs space-y-0.5 text-default-700">
                  {detail.plan.tips!.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {detail.plan.budget_estimate && (
              <p className="text-sm text-default-700"><b>总预算估算</b>：{detail.plan.budget_estimate}</p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
