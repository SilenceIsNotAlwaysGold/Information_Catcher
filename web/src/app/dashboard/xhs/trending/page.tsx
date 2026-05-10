"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Select, SelectItem } from "@nextui-org/select";
import { Input } from "@nextui-org/input";
import { Checkbox } from "@nextui-org/checkbox";
import { Pagination } from "@nextui-org/pagination";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import {
  RefreshCw, ExternalLink, Sparkles, Send, TrendingUp, Trash2,
  ArrowUp, ArrowDown, X as XIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { TrendingSettingsButton } from "@/components/TrendingSettingsButton";
import { proxyUrl } from "@/components/product-image/utils";
import { PromptTemplatesButton } from "@/components/PromptTemplatesButton";
import { toastOk, toastErr } from "@/lib/toast";

const API = (path: string) => `/api/monitor${path}`;

type TrendingPost = {
  id: number;
  note_id: string;
  title: string;
  desc_text: string;
  note_url: string;
  liked_count: number;
  collected_count: number;
  comment_count: number;
  keyword: string;
  author: string;
  rewritten_text: string;
  rewrite_status: string;
  found_at: string;
  synced_to_bitable: number;
  cover_url?: string;
  images?: string;       // JSON 字符串
  video_url?: string;
  note_type?: string;    // normal | video
};

const parseImages = (raw?: string): string[] => {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

type Prompt = { id: number; name: string; content: string; is_default: number };

export default function XhsTrendingPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<TrendingPost[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const detail = useDisclosure();
  const [active, setActive] = useState<TrendingPost | null>(null);
  const [activePromptId, setActivePromptId] = useState<string>("");
  const [rewriting, setRewriting] = useState(false);
  const [rewritePreview, setRewritePreview] = useState<string>("");
  const [rewriteVariants, setRewriteVariants] = useState<string[]>([]);
  const [variantsCount, setVariantsCount] = useState<number>(1);
  const [lockingIdx, setLockingIdx] = useState<number | null>(null);
  const [fetchingContent, setFetchingContent] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  // 筛选 / 排序 / 分页
  const [keywordFilter, setKeywordFilter] = useState<string>("");
  const [rewriteFilter, setRewriteFilter] = useState<string>("");   // ""/done/pending
  const [syncFilter, setSyncFilter] = useState<string>("");          // ""/yes/no
  const [typeFilter, setTypeFilter] = useState<string>("");          // ""/normal/video
  const [minLikes, setMinLikes] = useState<string>("");
  const [minCollects, setMinCollects] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [sortBy, setSortBy] = useState<"liked" | "collected" | "comment" | "found_at" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  const toggleSort = (field: NonNullable<typeof sortBy>) => {
    if (sortBy === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortBy(field); setSortDir("desc"); }
  };
  const sortIcon = (field: typeof sortBy) =>
    sortBy === field
      ? (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)
      : null;
  const resetFilters = () => {
    setKeywordFilter(""); setRewriteFilter(""); setSyncFilter("");
    setTypeFilter(""); setMinLikes(""); setMinCollects("");
    setSearch(""); setSortBy(null); setSortDir("desc");
  };

  // 抓取统计（上次尝试 / 上次成功 / 24h 摘要）
  const [stats, setStats] = useState<any>(null);

  // 静默刷新：不触发 loading state（避免轮询期间刷新按钮一直转圈），
  // 返回最新 posts.length 给调用方做"任务是否还在新增数据"判断
  const loadQuiet = useCallback(async () => {
    const [pRes, prRes, sRes] = await Promise.all([
      fetch(API("/trending?limit=200&platform=xhs"), { headers }).then((r) => r.json()),
      fetch(API("/prompts"),               { headers }).then((r) => r.json()),
      fetch(API("/trending/stats?platform=xhs"), { headers }).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    const newPosts = pRes.posts ?? [];
    setPosts(newPosts);
    setPrompts(prRes.prompts ?? []);
    setStats(sRes);
    const def = (prRes.prompts ?? []).find((p: Prompt) => p.is_default) ?? (prRes.prompts ?? [])[0];
    if (def) setActivePromptId(String(def.id));
    return newPosts.length;
  }, [token]);

  const fmtAgo = (ts?: string) => {
    if (!ts) return "—";
    const t = new Date(ts.replace(" ", "T")).getTime();
    if (!t) return ts;
    const diff = Math.max(0, Date.now() - t);
    const m = Math.floor(diff / 60000);
    if (m < 1) return "刚刚";
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { await loadQuiet(); } finally { setLoading(false); }
  }, [loadQuiet]);

  useEffect(() => { load(); }, [load]);

  const backfillMedia = async () => {
    setBackfilling(true);
    try {
      const r = await fetch(API("/trending/backfill-media?only_missing=true"), {
        method: "POST", headers,
      });
      const d = await r.json();
      if (!r.ok) {
        toastErr(d.detail || "触发失败"); return;
      }
      // 后台异步执行；轮询刷新（静默，不让"刷新"按钮跟着转）
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 8000));
        await loadQuiet();
      }
    } finally {
      setBackfilling(false);
    }
  };

  const triggerCheck = async () => {
    setTriggering(true);
    const before = posts.length;
    try {
      // 必须带 platform=xhs，否则 scheduler 会同时跑 xhs+douyin
      await fetch(API("/trending/check?platform=xhs"), { method: "POST", headers });
      // 静默轮询：连续 2 次（10s）数据量稳定就提前退出，最多 60s
      let last = before;
      let stable = 0;
      let final = before;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const cur = await loadQuiet();
        final = cur;
        if (cur === last) {
          stable += 1;
          if (stable >= 2) break;
        } else {
          stable = 0;
          last = cur;
        }
      }
      const delta = final - before;
      if (delta > 0) toastOk(`抓取完成，新增 ${delta} 条`);
      else toastOk("抓取完成（无新增）");
    } finally {
      setTriggering(false);
    }
  };

  const clearAll = async () => {
    if (posts.length === 0) return;
    const ok = window.confirm(
      `确认清空当前所有 ${posts.length} 条小红书热门内容？\n\n此操作不可恢复，但下次抓取仍会重新写入新数据。`,
    );
    if (!ok) return;
    setClearing(true);
    try {
      const r = await fetch(API("/trending?platform=xhs"), { method: "DELETE", headers });
      const d = await r.json();
      if (!r.ok) {
        toastErr(d.detail || "清空失败");
        return;
      }
      toastOk(`已清空 ${d.deleted} 条热门内容`);
      setSelected(new Set());
      await load();
    } catch (e: any) {
      toastErr(e?.message || "清空失败");
    } finally {
      setClearing(false);
    }
  };

  // 关键词候选：去重排序
  const keywordOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of posts) if (p.keyword) s.add(p.keyword);
    return Array.from(s).sort();
  }, [posts]);

  const filteredPosts = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const minL = parseInt(minLikes || "0", 10);
    const minC = parseInt(minCollects || "0", 10);
    return posts.filter((p) => {
      if (keywordFilter && p.keyword !== keywordFilter) return false;
      if (rewriteFilter === "done" && !p.rewritten_text) return false;
      if (rewriteFilter === "pending" && p.rewritten_text) return false;
      if (syncFilter === "yes" && !p.synced_to_bitable) return false;
      if (syncFilter === "no" && p.synced_to_bitable) return false;
      if (typeFilter === "video" && p.note_type !== "video") return false;
      if (typeFilter === "normal" && p.note_type === "video") return false;
      if (minL > 0 && (p.liked_count || 0) < minL) return false;
      if (minC > 0 && (p.collected_count || 0) < minC) return false;
      if (kw) {
        const hay = `${p.title || ""} ${p.author || ""}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [posts, keywordFilter, rewriteFilter, syncFilter, typeFilter, minLikes, minCollects, search]);

  const sortedPosts = useMemo(() => {
    if (!sortBy) return filteredPosts;
    const fld = sortBy === "liked" ? "liked_count"
              : sortBy === "collected" ? "collected_count"
              : sortBy === "comment" ? "comment_count"
              : "found_at";
    return [...filteredPosts].sort((a, b) => {
      const av = (a as any)[fld] ?? (sortBy === "found_at" ? "" : 0);
      const bv = (b as any)[fld] ?? (sortBy === "found_at" ? "" : 0);
      const cmp = sortBy === "found_at"
        ? String(av).localeCompare(String(bv))
        : Number(av) - Number(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredPosts, sortBy, sortDir]);

  const totalCount = sortedPosts.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedPosts = sortedPosts.slice((safePage - 1) * pageSize, safePage * pageSize);

  // 筛选 / 排序 / pageSize 变化时回到第 1 页
  useEffect(() => { setPage(1); },
    [keywordFilter, rewriteFilter, syncFilter, typeFilter, minLikes, minCollects, search, pageSize]);

  const fmt = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);

  const openDetail = (p: TrendingPost) => {
    setActive(p);
    setRewritePreview(p.rewritten_text || "");
    detail.onOpen();
  };

  const fetchFullContent = async () => {
    if (!active) return;
    setFetchingContent(true);
    try {
      const r = await fetch(API(`/trending/posts/${active.note_id}/fetch-content`), {
        method: "POST", headers,
      });
      const d = await r.json();
      if (!r.ok) {
        toastErr(d.detail || "抓取正文失败");
        return;
      }
      // 立刻把弹窗里的 active.* 更新，避免必须刷新
      setActive({
        ...active,
        desc_text: d.desc_text,
        title: d.title || active.title,
        cover_url: d.cover_url || active.cover_url,
        images: d.images && d.images.length ? JSON.stringify(d.images) : active.images,
        video_url: d.video_url || active.video_url,
        note_type: d.note_type || active.note_type,
      });
      await load();
    } finally {
      setFetchingContent(false);
    }
  };

  const runRewrite = async () => {
    if (!active) return;
    setRewriting(true);
    try {
      const r = await fetch(
        API(`/trending/posts/${active.note_id}/rewrite?variants=${variantsCount}`),
        {
          method: "POST", headers,
          body: JSON.stringify({ prompt_id: activePromptId ? parseInt(activePromptId) : null }),
        },
      );
      const d = await r.json();
      if (!r.ok) {
        toastErr(d.detail || "改写失败");
        return;
      }
      setRewritePreview(d.rewritten);
      setRewriteVariants(d.variants || [d.rewritten]);
      await load();
    } finally {
      setRewriting(false);
    }
  };

  const lockVariant = async (idx: number) => {
    if (!active || !rewriteVariants[idx]) return;
    setLockingIdx(idx);
    try {
      const r = await fetch(API(`/trending/posts/${active.note_id}/rewrite/lock`), {
        method: "POST", headers,
        body: JSON.stringify({ variant: rewriteVariants[idx] }),
      });
      if (!r.ok) {
        let msg = "锁定失败";
        try { const j = await r.json(); msg = j.detail || msg; } catch {}
        toastErr(msg);
        return;
      }
      setRewritePreview(rewriteVariants[idx]);
      await load();
    } finally {
      setLockingIdx(null);
    }
  };

  const toggleSelect = (note_id: string) => {
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(note_id)) s.delete(note_id); else s.add(note_id);
      return s;
    });
  };

  const syncSelected = async () => {
    if (selected.size === 0) return;
    setSyncing(true);
    try {
      const r = await fetch(API("/trending/sync-bitable"), {
        method: "POST", headers,
        body: JSON.stringify({ note_ids: Array.from(selected) }),
      });
      const d = await r.json();
      if (!r.ok) {
        toastErr(d.detail || "同步失败");
        return;
      }
      const okCount = (d.results || []).filter((x: any) => x.ok).length;
      const failCount = (d.results || []).filter((x: any) => !x.ok).length;
      if (failCount > 0) {
        toastErr(`同步完成：成功 ${okCount} 条，失败 ${failCount} 条`);
      } else {
        toastOk(`同步完成：成功 ${okCount} 条`);
      }
      setSelected(new Set());
      await load();
    } finally {
      setSyncing(false);
    }
  };

  // 轻量 markdown 渲染：处理 **加粗**、## 标题、- 列表、行内 emoji，保留换行。
  const renderMarkdown = (text: string) => {
    const lines = text.split("\n");
    return lines.map((raw, i) => {
      const line = raw.trimEnd();
      if (!line.trim()) return <br key={i} />;
      // 标题
      const h3 = line.match(/^###\s+(.+)$/);
      if (h3) return <h4 key={i} className="font-bold text-base mt-2">{h3[1]}</h4>;
      const h2 = line.match(/^##\s+(.+)$/);
      if (h2) return <h3 key={i} className="font-bold text-lg mt-2">{h2[1]}</h3>;
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) return <h2 key={i} className="font-bold text-xl mt-2">{h1[1]}</h2>;
      // 列表
      const li = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
      const content = li ? li[1] : line;
      // 加粗 **xxx**
      const parts: React.ReactNode[] = [];
      const re = /\*\*([^*]+)\*\*/g;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        if (m.index > last) parts.push(content.slice(last, m.index));
        parts.push(<strong key={`b${i}-${m.index}`} className="font-semibold">{m[1]}</strong>);
        last = m.index + m[0].length;
      }
      if (last < content.length) parts.push(content.slice(last));
      const rendered = parts.length ? parts : content;
      if (li) return <div key={i} className="ml-4 list-disc list-inside">• {rendered}</div>;
      return <p key={i} className="my-1">{rendered}</p>;
    });
  };

  const statusChip = (p: TrendingPost) => {
    if (p.synced_to_bitable) return <Chip size="sm" color="success" variant="flat">已同步</Chip>;
    if (p.rewrite_status === "done") return <Chip size="sm" color="primary" variant="flat">已改写</Chip>;
    if (p.rewrite_status === "failed") return <Chip size="sm" color="danger" variant="flat">改写失败</Chip>;
    return <Chip size="sm" color="default" variant="flat">待改写</Chip>;
  };

  // 文本长度提示：搜索 API 只返回标题，正文需点进详情页才能拿到。
  // 这里展示「正文/标题」长度，颜色提示有无正文。
  const lengthBadge = (p: TrendingPost) => {
    const titleLen = (p.title || "").length;
    const descLen = (p.desc_text || "").length;
    if (descLen > 0) {
      return (
        <span className="text-xs">
          <span className="text-success-600 font-medium">正文 {descLen}</span>
          <span className="text-default-300 mx-1">/</span>
          <span className="text-default-500">标题 {titleLen}</span>
        </span>
      );
    }
    return (
      <span className="text-xs">
        <span className="text-warning-600">仅标题 {titleLen}</span>
        <span className="text-default-300 ml-1">字</span>
      </span>
    );
  };

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <PlatformSubNav platform="xhs" current="trending" />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">热门内容</h2>
          <p className="text-sm text-default-400 mt-1">
            选中帖子→改写→同步飞书。改写和同步不再自动跑。
          </p>
          {stats && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-default-500">
              <span>上次尝试 <b className={stats.last_attempt?.status === "ok" ? "text-success-600" : "text-warning-600"}>
                {fmtAgo(stats.last_attempt?.ts)}
              </b>{stats.last_attempt && (
                <Chip size="sm" variant="flat" className="ml-1"
                  color={stats.last_attempt.status === "ok" ? "success" : "warning"}>
                  {stats.last_attempt.status === "ok" ? "成功" : "失败"}
                </Chip>
              )}</span>
              <span>上次成功 <b className="text-success-600">{fmtAgo(stats.last_success?.ts)}</b>
                {stats.last_success && <span className="text-default-400">（捕获 {stats.last_success.captured} 条）</span>}
              </span>
              <span>24h 内 {stats.recent_24h.success}/{stats.recent_24h.attempts} 次成功，累计捕获 <b>{stats.recent_24h.captured_total}</b> 条</span>
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <TrendingSettingsButton platform="xhs" />
          <PromptTemplatesButton token={token} />
          <Button variant="flat" startContent={<RefreshCw size={15} />}
            onPress={load} isLoading={loading} size="sm">刷新</Button>
          <Button variant="flat" color="secondary" size="sm"
            isLoading={backfilling}
            onPress={backfillMedia}>
            补全图片/视频
          </Button>
          <Button color="primary" startContent={<Sparkles size={15} />}
            onPress={triggerCheck} isLoading={triggering} size="sm">立即抓取</Button>
          <Button color="danger" variant="flat" startContent={<Trash2 size={15} />}
            onPress={clearAll} isLoading={clearing}
            isDisabled={posts.length === 0} size="sm">
            清空
          </Button>
        </div>
      </div>

      {/* 筛选条 */}
      {posts.length > 0 && (
        <Card>
          <CardBody className="py-3 flex flex-row flex-wrap items-end gap-3">
            <div className="min-w-[160px]">
              <p className="text-xs text-default-500 mb-1">关键词</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={keywordFilter}
                onChange={(e) => setKeywordFilter(e.target.value)}
              >
                <option value="">全部关键词</option>
                {keywordOptions.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[120px]">
              <p className="text-xs text-default-500 mb-1">改写状态</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={rewriteFilter}
                onChange={(e) => setRewriteFilter(e.target.value)}
              >
                <option value="">全部</option>
                <option value="done">已改写</option>
                <option value="pending">待改写</option>
              </select>
            </div>
            <div className="min-w-[120px]">
              <p className="text-xs text-default-500 mb-1">飞书同步</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={syncFilter}
                onChange={(e) => setSyncFilter(e.target.value)}
              >
                <option value="">全部</option>
                <option value="yes">已同步</option>
                <option value="no">未同步</option>
              </select>
            </div>
            <div className="min-w-[110px]">
              <p className="text-xs text-default-500 mb-1">类型</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="">全部</option>
                <option value="normal">图文</option>
                <option value="video">视频</option>
              </select>
            </div>
            <Input size="sm" type="number" min={0} className="w-28"
              label="点赞 ≥" labelPlacement="outside-left"
              value={minLikes} onValueChange={setMinLikes} />
            <Input size="sm" type="number" min={0} className="w-28"
              label="收藏 ≥" labelPlacement="outside-left"
              value={minCollects} onValueChange={setMinCollects} />
            <Input size="sm" className="w-44"
              label="搜索" labelPlacement="outside-left"
              placeholder="标题 / 作者"
              value={search} onValueChange={setSearch} />
            {(keywordFilter || rewriteFilter || syncFilter || typeFilter
              || minLikes || minCollects || search || sortBy) && (
              <Button size="sm" variant="light" startContent={<XIcon size={13} />}
                onPress={resetFilters}>
                清除筛选
              </Button>
            )}
            <span className="ml-auto text-xs text-default-500">
              共 <b>{totalCount}</b> 条 · 第 {safePage} / {pageCount} 页
            </span>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex justify-between items-center">
          <span className="text-sm">
            筛选后 <b>{totalCount}</b> 条 / 全部 {posts.length} 条，已选 <strong>{selected.size}</strong> 条
          </span>
          <Button color="success" size="sm" variant="flat"
            startContent={<Send size={14} />}
            isLoading={syncing}
            isDisabled={selected.size === 0}
            onPress={syncSelected}>
            同步选中到飞书 ({selected.size})
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <TableSkeleton rows={6} cols={8} />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={TrendingUp}
              title="还没有热门数据"
              hint="管理员在「监控设置 → 热门内容监控」开启关键词搜索后，定时抓取的帖子会自动出现。也可以点上方「立即抓取」手动触发一次。"
              action={
                <Button color="primary" startContent={<Sparkles size={14} />}
                  onPress={triggerCheck} isLoading={triggering}>
                  立即抓取
                </Button>
              }
            />
          ) : (
          <Table aria-label="trending posts" removeWrapper isHeaderSticky>
            <TableHeader>
              <TableColumn className="w-10">
                <Checkbox
                  isSelected={pagedPosts.length > 0 && pagedPosts.every((p) => selected.has(p.note_id))}
                  isIndeterminate={
                    pagedPosts.some((p) => selected.has(p.note_id)) &&
                    !pagedPosts.every((p) => selected.has(p.note_id))
                  }
                  onValueChange={(v) => {
                    const next = new Set(selected);
                    if (v) pagedPosts.forEach((p) => next.add(p.note_id));
                    else pagedPosts.forEach((p) => next.delete(p.note_id));
                    setSelected(next);
                  }}
                />
              </TableColumn>
              <TableColumn>关键词</TableColumn>
              <TableColumn>封面</TableColumn>
              <TableColumn>标题</TableColumn>
              <TableColumn>内容</TableColumn>
              <TableColumn>作者</TableColumn>
              <TableColumn>
                <button type="button" className="inline-flex items-center gap-1 text-xs"
                  onClick={() => toggleSort("liked")}>
                  点赞 {sortIcon("liked")}
                </button>
              </TableColumn>
              <TableColumn>
                <button type="button" className="inline-flex items-center gap-1 text-xs"
                  onClick={() => toggleSort("collected")}>
                  收藏 {sortIcon("collected")}
                </button>
              </TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>改写预览</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {pagedPosts.map((p) => (
                <TableRow key={p.note_id}>
                  <TableCell>
                    <Checkbox
                      isSelected={selected.has(p.note_id)}
                      onValueChange={() => toggleSelect(p.note_id)}
                    />
                  </TableCell>
                  <TableCell>
                    <Chip size="sm" variant="flat" color="secondary">{p.keyword || "—"}</Chip>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const cover = p.cover_url || parseImages(p.images)[0] || "";
                      if (!cover) {
                        return <span className="text-xs text-default-300">—</span>;
                      }
                      return (
                        <button
                          type="button"
                          className="relative block w-12 h-12 rounded overflow-hidden bg-default-100"
                          onClick={() => openDetail(p)}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={proxyUrl(cover)} alt="cover"
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover" />
                          {p.note_type === "video" && (
                            <span className="absolute right-0 bottom-0 bg-black/60 text-white text-[10px] px-1 rounded-tl">
                              ▶
                            </span>
                          )}
                        </button>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left text-sm text-primary line-clamp-2 max-w-[260px] hover:underline"
                      onClick={() => openDetail(p)}
                    >
                      {p.title || p.note_id}
                    </button>
                  </TableCell>
                  <TableCell>{lengthBadge(p)}</TableCell>
                  <TableCell>
                    <span className="text-xs text-default-500">{p.author || "—"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm font-medium text-rose-500">{fmt(p.liked_count)}</span>
                  </TableCell>
                  <TableCell><span className="text-sm">{fmt(p.collected_count)}</span></TableCell>
                  <TableCell>{statusChip(p)}</TableCell>
                  <TableCell>
                    {p.rewritten_text ? (
                      <button
                        type="button"
                        onClick={() => openDetail(p)}
                        className="text-xs text-primary hover:underline text-left max-w-[160px] truncate block"
                        title="点击查看完整改写"
                      >
                        {p.rewritten_text.slice(0, 18)}
                        {p.rewritten_text.length > 18 ? "…" : ""}
                      </button>
                    ) : (
                      <span className="text-xs text-default-300">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button isIconOnly size="sm" variant="light"
                        onPress={() => openDetail(p)}>
                        <Sparkles size={14} />
                      </Button>
                      <Button isIconOnly size="sm" variant="light"
                        as="a" href={p.note_url} target="_blank">
                        <ExternalLink size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </CardBody>
        {!loading && posts.length > 0 && (
          <div className="flex items-center justify-between p-3 border-t border-divider">
            <div className="flex items-center gap-2 text-xs text-default-500">
              每页
              <select
                className="border border-divider rounded-md px-2 h-7 text-xs bg-background"
                value={pageSize}
                onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
              >
                <option value={30}>30</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
            <Pagination
              showControls size="sm" color="primary"
              page={safePage} total={pageCount}
              onChange={setPage}
            />
          </div>
        )}
      </Card>

      {/* Detail / Rewrite Modal */}
      <Modal isOpen={detail.isOpen} onClose={detail.onClose} size="3xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>
            <span className="line-clamp-2">{active?.title || active?.note_id}</span>
          </ModalHeader>
          <ModalBody className="space-y-4">
            <div className="flex gap-3 text-sm flex-wrap">
              <Chip size="sm" variant="flat" color="secondary">{active?.keyword}</Chip>
              <span>👍 <strong className="text-rose-500">{fmt(active?.liked_count ?? 0)}</strong></span>
              <span>⭐ <strong>{fmt(active?.collected_count ?? 0)}</strong></span>
              <span>💬 <strong>{active?.comment_count ?? 0}</strong></span>
              {active?.author && <span>作者 <strong>{active.author}</strong></span>}
            </div>

            {/* 图集 + 视频 */}
            {active && (() => {
              const imgs = parseImages(active.images);
              const hasVideo = active.note_type === "video" && active.video_url;
              return (imgs.length > 0 || hasVideo || active.cover_url) ? (
                <div>
                  <p className="text-xs font-medium text-default-400 mb-2">
                    {hasVideo ? "视频" : `图集（${imgs.length || 1} 张）`}
                  </p>
                  {hasVideo ? (
                    <video
                      src={active.video_url}
                      controls
                      preload="metadata"
                      poster={active.cover_url}
                      className="w-full max-h-96 rounded-lg bg-black"
                    />
                  ) : imgs.length > 0 ? (
                    <div className="grid grid-cols-3 gap-2">
                      {imgs.map((rawUrl, i) => {
                        const url = proxyUrl(rawUrl);
                        return (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={i} src={url} alt={`img-${i}`}
                            referrerPolicy="no-referrer"
                            className="w-full h-32 object-cover rounded cursor-pointer hover:opacity-80"
                            onClick={() => window.open(url, "_blank")} />
                        );
                      })}
                    </div>
                  ) : active.cover_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={proxyUrl(active.cover_url)} alt="cover"
                      referrerPolicy="no-referrer"
                      className="w-full max-h-64 object-contain rounded" />
                  ) : null}
                </div>
              ) : null;
            })()}

            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-default-400">
                  原文（{(active?.desc_text || "").length > 0
                    ? `正文 ${(active?.desc_text || "").length} 字`
                    : `仅标题 ${(active?.title || "").length} 字`}）
                </p>
                {!active?.desc_text && active && (
                  <Button size="sm" variant="flat" color="secondary"
                    isLoading={fetchingContent}
                    onPress={fetchFullContent}>
                    抓取完整正文
                  </Button>
                )}
              </div>
              <div className="bg-default-50 rounded-lg p-3 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                {active?.desc_text || active?.title || "（无正文，点击右上「抓取完整正文」）"}
              </div>
            </div>

            <div className="space-y-2">
              <Select
                label="使用 Prompt 模板"
                labelPlacement="outside"
                placeholder="选择模板"
                selectedKeys={activePromptId ? [activePromptId] : []}
                onSelectionChange={(keys) =>
                  setActivePromptId(Array.from(keys)[0] as string ?? "")
                }
                disallowEmptySelection
                items={prompts}
                renderValue={(items) =>
                  items.map((it) => {
                    const p = it.data as Prompt | undefined;
                    return (
                      <span key={it.key}>
                        {p?.name}{p?.is_default ? "（默认）" : ""}
                      </span>
                    );
                  })
                }
              >
                {(p) => (
                  <SelectItem key={String(p.id)} textValue={p.name}>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {p.name}{p.is_default ? "（默认）" : ""}
                      </span>
                      <span className="text-xs text-default-400 line-clamp-1">
                        {p.content}
                      </span>
                    </div>
                  </SelectItem>
                )}
              </Select>
              {/* 选中 prompt 的内容预览（默认折叠，方便用户确认）*/}
              {activePromptId && (() => {
                const cur = prompts.find((p) => String(p.id) === activePromptId);
                return cur ? (
                  <details className="text-xs text-default-500 bg-default-50 rounded-md p-2">
                    <summary className="cursor-pointer">
                      当前 Prompt：<strong>{cur.name}</strong>（点击查看内容）
                    </summary>
                    <pre className="whitespace-pre-wrap mt-2 text-default-600">{cur.content}</pre>
                  </details>
                ) : null;
              })()}
              <div className="flex items-center gap-2">
                <Button color="primary" variant="flat"
                  startContent={<Sparkles size={15} />}
                  isLoading={rewriting}
                  isDisabled={!activePromptId}
                  onPress={runRewrite}>
                  {rewritePreview ? "重新改写" : "改写"}
                </Button>
                <span className="text-xs text-default-500">变体数量：</span>
                {[1, 3, 5].map((n) => (
                  <Button key={n} size="sm"
                    variant={variantsCount === n ? "solid" : "flat"}
                    color={variantsCount === n ? "primary" : "default"}
                    onPress={() => setVariantsCount(n)}>
                    {n}
                  </Button>
                ))}
              </div>
            </div>

            {rewriteVariants.length > 1 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-default-400">
                  生成了 {rewriteVariants.length} 个变体（温度梯度），选一个锁定为最终版（写入飞书）：
                </p>
                {rewriteVariants.map((v, i) => (
                  <div key={i} className={`rounded-lg p-3 border ${
                    rewritePreview === v ? "bg-primary-50 border-primary"
                                         : "bg-default-50 border-default-200"
                  }`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-default-500">
                        变体 #{i + 1}{rewritePreview === v && " · 已锁定"}
                      </span>
                      {rewritePreview !== v && (
                        <Button size="sm" variant="flat" color="primary"
                          isLoading={lockingIdx === i}
                          onPress={() => lockVariant(i)}>
                          使用这个版本
                        </Button>
                      )}
                    </div>
                    <div className="text-sm">{renderMarkdown(v)}</div>
                  </div>
                ))}
              </div>
            )}

            {rewriteVariants.length <= 1 && rewritePreview && (
              <div>
                <p className="text-xs font-medium text-default-400 mb-1">改写结果</p>
                <div className="bg-primary-50 rounded-lg p-3 text-sm border border-primary-100">
                  {renderMarkdown(rewritePreview)}
                </div>
              </div>
            )}

            <Button as="a" href={active?.note_url} target="_blank"
              variant="flat" startContent={<ExternalLink size={14} />} size="sm">
              查看原帖
            </Button>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={detail.onClose}>关闭</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
