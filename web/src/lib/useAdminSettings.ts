"use client";

/**
 * admin 子页共用的 settings hook
 *
 * 提供 fetch + save + 字段读写的统一入口；每个 admin 子页（/admin/ai、
 * /admin/feishu、/admin/system）只关心自己的字段子集。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr, toastOk } from "@/lib/toast";

export type SettingsMap = Record<string, any>;

const API = (path: string) => `/api/monitor${path}`;

export function useAdminSettings() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const [settings, setSettings] = useState<SettingsMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/settings"), { headers });
      if (!r.ok) throw new Error(await r.text());
      setSettings(await r.json());
    } catch (e: any) {
      toastErr(`读取设置失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => { reload(); }, [reload]);

  const set = (key: string, value: any) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  /**
   * 保存指定字段子集到后端。`payload` 已经做好类型转换（string/number/bool）。
   * 返回是否成功。
   */
  const saveSubset = async (payload: SettingsMap, successMsg = "已保存"): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await fetch(API("/settings"), {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || `保存失败 (HTTP ${r.status})`);
        return false;
      }
      toastOk(successMsg);
      await reload();
      return true;
    } catch (e: any) {
      toastErr(`保存失败：${e?.message || e}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { settings, set, loading, saving, reload, saveSubset };
}
