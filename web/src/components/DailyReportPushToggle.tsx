"use client";

/**
 * 每日日报推送开关 — 控制 users.daily_push_enabled。
 *
 * 开：每天定时的监控数据日报（今日增量 + 涨幅排行 + 汇总）推送到专属群
 *     「TrendPulse 每日日报 - {username}」（首次推送时 lazy 建群，拉用户 + admin）。
 * 关：仍按老逻辑（group webhook / 老 feishu_chat_id）推；没配就不发。
 */
import { useEffect, useMemo, useState } from "react";
import { Switch } from "@nextui-org/switch";
import { Spinner } from "@nextui-org/spinner";
import { CalendarClock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/monitor${p}`;

export function DailyReportPushToggle() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState("");

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/settings"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setEnabled(d.daily_push_enabled === "1" || d.daily_push_enabled === true);
      setChatId(d.daily_chat_id || "");
    } catch (e: any) {
      toastErr(`加载日报推送设置失败：${e?.message || e}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setEnabled(next);
    try {
      const r = await fetch(API("/settings"), {
        method: "PUT", headers,
        body: JSON.stringify({ daily_push_enabled: next }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
      toastOk(next
        ? "已开启每日日报推送（首次推送时自动建『每日日报』专属群，拉你 + admin）"
        : "已关闭每日日报推送");
    } catch (e: any) {
      setEnabled(!next);
      toastErr(`保存失败：${e?.message || e}`);
    } finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-default-400">
        <Spinner size="sm" /> 加载日报设置…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-default-600 px-2 py-1.5 rounded-md bg-default-50 border border-default-200">
      <CalendarClock size={14} className={enabled ? "text-primary" : "text-default-400"} />
      <span className="shrink-0">每日日报推送到专属群</span>
      <Switch size="sm" isSelected={enabled} isDisabled={saving} onValueChange={toggle} />
      <span className="text-[11px] text-default-400 truncate">
        {enabled
          ? (chatId ? `已建群（chat_id 末 6: …${chatId.slice(-6)}）` : "首次日报时建群")
          : "（关：按老逻辑推 / 不发）"}
      </span>
    </div>
  );
}
