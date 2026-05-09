"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr } from "@/lib/toast";
import { DEFAULT_IMAGE_CONFIG, IMAGE_API, ImageConfig } from "./utils";

/** 图像 API 配置 hook：返回 {cfg, loading, reload, headers}。 */
export function useImageConfig() {
  const { token } = useAuth();
  const [cfg, setCfg] = useState<ImageConfig>(DEFAULT_IMAGE_CONFIG);
  const [loading, setLoading] = useState(true);

  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(IMAGE_API("/config"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setCfg({
        base_url: data.base_url || "",
        model: data.model || "",
        size: data.size || "1024x1024",
        has_key: !!data.has_key,
      });
    } catch (e: any) {
      toastErr(`读取配置失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    if (!token) return;
    reload();
  }, [token, reload]);

  return { cfg, loading, reload, headers };
}
