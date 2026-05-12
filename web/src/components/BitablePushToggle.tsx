"use client";

/**
 * 商品图 / 仿写 / 文案换背景 三个工具同步飞书后是否推群通知 — 单一开关。
 *
 * 后端开关字段：users.bitable_push_enabled（per-user）
 * 推送目标群：users.bitable_chat_id（首次开启 + 首次同步时 lazy 建群
 *   "TrendPulse 消息同步 - {username}"）
 *
 * 关闭：表格还是会写，但不发群消息（默认）。
 * 打开：写完表后推一张飞书卡片到该用户的「消息同步」群。
 */
import { useEffect, useMemo, useState } from "react";
import { Switch } from "@nextui-org/switch";
import { Spinner } from "@nextui-org/spinner";
import { Bell, BellOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/monitor${p}`;

export function BitablePushToggle() {
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
      setEnabled(d.bitable_push_enabled === "1" || d.bitable_push_enabled === true);
      setChatId(d.bitable_chat_id || "");
    } catch (e: any) {
      toastErr(`加载推送开关失败：${e?.message || e}`);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setEnabled(next);  // 乐观更新
    try {
      const r = await fetch(API("/settings"), {
        method: "PUT", headers,
        body: JSON.stringify({ bitable_push_enabled: next }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
      toastOk(next
        ? "已开启同步通知（首次同步时会自动建『消息同步』群并拉你 + admin 进群）"
        : "已关闭同步通知");
    } catch (e: any) {
      setEnabled(!next);  // 回滚
      toastErr(`保存失败：${e?.message || e}`);
    } finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-default-400">
        <Spinner size="sm" /> 加载推送设置…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-default-600 px-2 py-1.5 rounded-md bg-default-50 border border-default-200">
      {enabled ? <Bell size={14} className="text-primary" /> : <BellOff size={14} className="text-default-400" />}
      <span className="shrink-0">同步后推群通知</span>
      <Switch
        size="sm"
        isSelected={enabled}
        isDisabled={saving}
        onValueChange={toggle}
      />
      <span className="text-[11px] text-default-400 truncate">
        {enabled
          ? (chatId ? `已建群（chat_id 末 6: …${chatId.slice(-6)}）` : "首次同步时建群")
          : "（关：仅写表，不发消息）"}
      </span>
    </div>
  );
}
