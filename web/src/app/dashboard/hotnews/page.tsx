"use client";

/**
 * 热点雷达 — 各渠道热点聚合，按分类展示。
 * v2 骨架：先接 Hacker News + GitHub Trending 两个源（都是 code 分类）。
 * 后续可加 36kr / 知乎热榜 / 微博热搜 / V2EX ... 接入到 hotnews_fetcher 即可。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Tabs, Tab } from "@nextui-org/tabs";
import { Newspaper, RefreshCw, ExternalLink, Flame } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader } from "@/components/ui";

const API = (p: string) => `/api/hotnews${p}`;

type Source = { key: string; label: string; category: string };
type Item = {
  id: number; source: string; source_label: string; category: string;
  title: string; url: string; summary: string;
  score: number; score_label: string; fetched_at: string;
};

const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "code", label: "Code / 开源" },
  { key: "tech", label: "科技" },
  { key: "policy", label: "政策" },
  { key: "entertainment", label: "娱乐" },
  { key: "finance", label: "金融" },
];

export default function HotNewsPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const [sources, setSources] = useState<Source[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("all");
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    const r = await fetch(API("/sources"), { headers });
    if (r.ok) {
      const d = await r.json();
      setSources(d.sources || []);
    }
  }, [headers]);
  useEffect(() => { loadSources(); }, [loadSources]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const q = category === "all" ? "" : `?category=${category}`;
      const r = await fetch(API(`/items${q}`), { headers });
      if (r.ok) {
        const d = await r.json();
        setItems(d.items || []);
      }
    } finally { setLoading(false); }
  }, [category, headers]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const refreshSource = async (key: string) => {
    setRefreshing(key);
    try {
      const r = await fetch(API(`/refresh?source=${key}`), { method: "POST", headers });
      const d = await r.json();
      if (!r.ok || !d.ok) { toastErr(d.error || d.detail || "刷新失败"); return; }
      toastOk(`${key}：新增 ${d.added}，更新 ${d.updated}`);
      await loadItems();
    } finally { setRefreshing(null); }
  };

  // 按 source 分组
  const itemsBySource = useMemo(() => {
    const map: Record<string, Item[]> = {};
    items.forEach((it) => {
      (map[it.source] ||= []).push(it);
    });
    return map;
  }, [items]);

  return (
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="hotnews"
        icon={Flame}
        title="热点雷达"
        hint="聚合 9 个源：HN / GitHub Trending / V2EX / 微博 / B 站 / 知乎 / Solidot / 百度 / 少数派 / IT 之家。不耗 AI 点数。"
      />


      <Tabs selectedKey={category}
        onSelectionChange={(k) => setCategory(String(k))}
        aria-label="category">
        {CATEGORIES.map((c) => <Tab key={c.key} title={c.label} />)}
      </Tabs>

      {/* 各源刷新按钮 */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Newspaper size={16} />
            <span className="font-medium">来源</span>
            <Chip size="sm" variant="flat">{sources.length}</Chip>
          </div>
          <Button size="sm" variant="light" startContent={<RefreshCw size={14} />}
            onPress={loadItems} isLoading={loading}>刷新列表</Button>
        </CardHeader>
        <CardBody className="flex gap-2 flex-wrap">
          {sources
            .filter((s) => category === "all" || s.category === category)
            .map((s) => (
              <Button key={s.key} size="sm" variant="flat"
                isLoading={refreshing === s.key}
                onPress={() => refreshSource(s.key)}
                startContent={<RefreshCw size={12} />}>
                抓 {s.label}
              </Button>
            ))}
        </CardBody>
      </Card>

      {/* 列表（按 source 分组展示） */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载中…</div>
      ) : items.length === 0 ? (
        <Card><CardBody>
          <p className="text-sm text-default-400">还没有数据。点上方"抓 XX"按钮刷新一下。</p>
        </CardBody></Card>
      ) : (
        Object.entries(itemsBySource).map(([src, list]) => {
          const label = list[0]?.source_label || src;
          return (
            <Card key={src}>
              <CardHeader className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Newspaper size={16} />
                  <span className="font-medium">{label}</span>
                  <Chip size="sm" variant="flat" color="primary">{list.length}</Chip>
                </div>
                <Button size="sm" variant="light" startContent={<RefreshCw size={12} />}
                  isLoading={refreshing === src}
                  onPress={() => refreshSource(src)}>刷新</Button>
              </CardHeader>
              <CardBody className="space-y-1">
                {list.slice(0, 30).map((it, idx) => (
                  <a key={it.id} href={it.url} target="_blank" rel="noreferrer"
                    className="flex items-start gap-2 p-2 rounded hover:bg-default-50 text-sm">
                    <span className="text-default-300 w-6 shrink-0 text-right">{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{it.title}</p>
                      {it.summary && (
                        <p className="text-xs text-default-500 truncate">{it.summary}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      {it.score_label && (
                        <Chip size="sm" variant="flat" color="warning">{it.score_label}</Chip>
                      )}
                      <ExternalLink size={12} className="text-default-300" />
                    </div>
                  </a>
                ))}
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}
