"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Spinner } from "@nextui-org/spinner";
import { Chip } from "@nextui-org/chip";
import { Checkbox } from "@nextui-org/checkbox";
import {
  History as HistoryIcon, Send, Trash2, ExternalLink, Copy, Image as ImageIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr, toastOk } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";
import { IMAGE_API, proxyUrl } from "./utils";

type HistoryItem = {
  id: number;
  user_id?: number | null;
  prompt: string;
  size?: string; model?: string;
  set_idx: number; in_set_idx: number;
  qiniu_url: string;
  upload_status?: "pending" | "uploaded" | "failed" | "skipped";
  generated_title?: string;
  generated_body?: string;
  batch_id?: string;
  source_post_url?: string;
  source_post_title?: string;
  used_reference?: number;
  synced_to_bitable?: number;
  created_at: string;
};

type HistoryGroup = {
  key: string;
  batch_id: string;
  set_idx: number;
  title: string;
  body: string;
  items: HistoryItem[];
  created_at: string;
  source_post_title: string;
  used_reference: boolean;
  all_synced: boolean;
};

type BitableTable = { table_id: string; name: string };

type Props = {
  /** 当前用户身份信息（用于显示用户名） */
  isAdmin: boolean;
  /** 点击图片时回调（打开预览） */
  onPreview?: (url: string, title?: string) => void;
};

/** 历史记录网格：按 (batch_id, set_idx) 分组展示，支持多选批量同步飞书。 */
export function HistoryGrid({ isAdmin, onPreview }: Props) {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [qiniuConfigured, setQiniuConfigured] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const groups = useMemo<HistoryGroup[]>(() => {
    const map = new Map<string, HistoryGroup>();
    for (const h of history) {
      const groupKey = h.batch_id ? `${h.batch_id}:${h.set_idx}` : `single:${h.id}`;
      let g = map.get(groupKey);
      if (!g) {
        g = {
          key: groupKey,
          batch_id: h.batch_id || "",
          set_idx: h.set_idx,
          title: h.generated_title || "",
          body: h.generated_body || "",
          items: [],
          created_at: h.created_at,
          source_post_title: h.source_post_title || "",
          used_reference: !!h.used_reference,
          all_synced: true,
        };
        map.set(groupKey, g);
      }
      g.items.push(h);
      if (!g.title && h.generated_title) g.title = h.generated_title;
      if (!g.body && h.generated_body) g.body = h.generated_body;
      if (h.created_at < g.created_at) g.created_at = h.created_at;
      if (!h.synced_to_bitable) g.all_synced = false;
    }
    const result = Array.from(map.values());
    result.forEach((g) => g.items.sort((a, b) => a.in_set_idx - b.in_set_idx));
    result.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return result;
  }, [history]);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(IMAGE_API("/history?limit=80"), { headers });
      const data = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(data?.records)) {
        setHistory(data.records);
        setQiniuConfigured(!!data.qiniu_configured);
      }
    } catch {}
    finally { setLoading(false); }
  }, [token, headers]);

  useEffect(() => { reload(); }, [reload]);

  // 有 pending 上传时每 30 秒自动拉一次
  useEffect(() => {
    const hasPending = history.some((h) => h.upload_status === "pending");
    if (!hasPending) return;
    const id = setInterval(reload, 30000);
    return () => clearInterval(id);
  }, [history, reload]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllGroup = (g: HistoryGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = g.items.every((it) => next.has(it.id));
      g.items.forEach((it) => allIn ? next.delete(it.id) : next.add(it.id));
      return next;
    });
  };

  const remove = async (id: number) => {
    if (!confirm("确认删除这条历史记录？（七牛云上的图不会被删）")) return;
    try {
      const r = await fetch(IMAGE_API(`/history/${id}`), { method: "DELETE", headers });
      const data = await r.json().catch(() => ({}));
      if (data?.ok) {
        toastOk("已删除");
        setHistory((prev) => prev.filter((h) => h.id !== id));
        setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
      } else { toastErr("删除失败"); }
    } catch (e: any) { toastErr(`删除异常：${e?.message || e}`); }
  };

  // 飞书 bitable 表选择
  const [tables, setTables] = useState<BitableTable[]>([]);
  const [appToken, setAppToken] = useState("");
  const [selectedTableId, setSelectedTableId] = useState("");

  const reloadTables = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch("/api/feishu/bitable/tables", { headers });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const ts: BitableTable[] = data?.tables || [];
        setTables(ts);
        setAppToken(data?.app_token || "");
        const def = data?.default_image_table_id || "";
        setSelectedTableId((prev) => prev || def || (ts[0]?.table_id || ""));
      }
    } catch {}
  }, [token, headers]);

  useEffect(() => { reloadTables(); }, [reloadTables]);

  const syncToBitable = async () => {
    const ids = Array.from(selected);
    if (!ids.length) { toastErr("请先选择要同步的图"); return; }
    setSyncing(true);
    try {
      const r = await fetch(IMAGE_API("/history/sync-bitable"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          record_ids: ids,
          target_table_id: selectedTableId || undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data?.error) { toastErr(data.error); return; }
      const results = data?.results || [];
      const ok = results.filter((x: any) => x.ok).length;
      const tableName = tables.find((t) => t.table_id === selectedTableId)?.name || "默认表";
      toastOk(`同步完成（成功 ${ok} / 共 ${results.length}），写入表「${tableName}」`);
      setSelected(new Set());
      await reload();
    } catch (e: any) {
      toastErr(`同步失败：${e?.message || e}`);
    } finally { setSyncing(false); }
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HistoryIcon size={18} className="text-default-500" />
          <span className="font-semibold">历史记录</span>
          <Chip size="sm" variant="flat">{groups.length} 组 / {history.length} 张</Chip>
        </div>
        <div className="flex items-center gap-2">
          {tables.length > 0 && (
            <select
              className="text-xs border border-divider rounded-md px-2 py-1.5 bg-background"
              value={selectedTableId}
              onChange={(e) => setSelectedTableId(e.target.value)}
              title="目标飞书表"
            >
              {tables.map((t) => (
                <option key={t.table_id} value={t.table_id}>{t.name}</option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            color="primary"
            variant="flat"
            startContent={<Send size={14} />}
            isDisabled={!selected.size || syncing || !qiniuConfigured}
            isLoading={syncing}
            onPress={syncToBitable}
          >
            同步到飞书（{selected.size}）
          </Button>
          <Button size="sm" variant="flat" onPress={reload} isLoading={loading}>
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {!qiniuConfigured && (
          <p className="text-xs text-warning-600 mb-3">
            ⚠️ 七牛云未配置或图未上传完成，飞书同步暂不可用（图必须先上传到七牛拿到公网 URL）。
          </p>
        )}
        {groups.length === 0 ? (
          <EmptyState
            icon={ImageIcon}
            title="还没有生成记录"
            hint="去上方生成第一张图吧"
          />
        ) : (
          <div className="space-y-3">
            {groups.map((g) => {
              const allIn = g.items.every((it) => selected.has(it.id));
              const headImg = g.items[0];
              return (
                <div
                  key={g.key}
                  className="border border-divider rounded-lg p-3 hover:bg-default-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      isSelected={allIn}
                      isIndeterminate={!allIn && g.items.some((it) => selected.has(it.id))}
                      onValueChange={() => selectAllGroup(g)}
                      aria-label="选中整组"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {g.batch_id?.startsWith("remix:") ? (
                          <Chip size="sm" color="secondary" variant="flat">仿写</Chip>
                        ) : (
                          <Chip size="sm" variant="flat">商品图</Chip>
                        )}
                        {g.title && (
                          <span className="font-medium text-sm text-default-800 truncate">
                            {g.title}
                          </span>
                        )}
                        {g.all_synced && (
                          <Chip size="sm" color="success" variant="flat">已同步</Chip>
                        )}
                        {/* 实际使用的模型（取本组第一张图的 model 字段） */}
                        {(() => {
                          const m = (g.items[0]?.model || "").trim();
                          if (!m) return null;
                          return (
                            <Chip size="sm" variant="flat" className="font-mono"
                              title={`生成时使用的模型：${m}`}>
                              {m}
                            </Chip>
                          );
                        })()}
                        {/* 尺寸 */}
                        {g.items[0]?.size && (
                          <Chip size="sm" variant="flat" className="font-mono text-default-500">
                            {g.items[0].size}
                          </Chip>
                        )}
                        <span className="text-xs text-default-400">{g.created_at}</span>
                      </div>
                      {g.body && (
                        <p className="text-xs text-default-500 line-clamp-2 mb-2">
                          {g.body.slice(0, 200)}
                        </p>
                      )}
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                        {g.items.map((it) => (
                          <div
                            key={it.id}
                            className="relative aspect-square rounded-md overflow-hidden bg-default-100 border border-divider group"
                          >
                            <Checkbox
                              isSelected={selected.has(it.id)}
                              onValueChange={() => toggle(it.id)}
                              size="sm"
                              className="absolute top-1 left-1 z-10 bg-white/80 rounded"
                              aria-label={`选中 #${it.id}`}
                            />
                            {it.qiniu_url ? (
                              <img
                                src={proxyUrl(it.qiniu_url)}
                                alt={`#${it.id}`}
                                className="w-full h-full object-cover cursor-pointer"
                                onClick={() => onPreview?.(it.qiniu_url, g.title)}
                              />
                            ) : (
                              <div className="flex items-center justify-center h-full text-xs text-default-400">
                                无图
                              </div>
                            )}
                            {it.upload_status === "pending" && (
                              <span className="absolute bottom-1 right-1 text-[10px] bg-warning/90 text-white px-1 rounded">
                                上传中
                              </span>
                            )}
                            {it.upload_status === "failed" && (
                              <span className="absolute bottom-1 right-1 text-[10px] bg-danger/90 text-white px-1 rounded">
                                失败
                              </span>
                            )}
                            <button
                              className="absolute top-1 right-1 z-10 w-6 h-6 rounded bg-black/50 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => remove(it.id)}
                              title="删除"
                            >
                              <Trash2 size={11} className="mx-auto" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
