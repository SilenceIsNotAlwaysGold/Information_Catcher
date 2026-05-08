"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Select, SelectItem } from "@nextui-org/select";
import { Checkbox } from "@nextui-org/checkbox";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { RefreshCw, ExternalLink, Sparkles, Send, Download, TrendingUp } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { TrendingSettingsButton } from "@/components/TrendingSettingsButton";
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
  images?: string;       // JSON 字符串（抖音通常为空）
  video_url?: string;
  note_type?: string;    // douyin = "video"
  platform?: string;
};

type Prompt = { id: number; name: string; content: string; is_default: number };

export default function DouyinTrendingPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<TrendingPost[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, prRes] = await Promise.all([
        fetch(API("/trending?limit=200&platform=douyin"), { headers }).then((r) => r.json()),
        fetch(API("/prompts"),                              { headers }).then((r) => r.json()),
      ]);
      setPosts(pRes.posts ?? []);
      setPrompts(prRes.prompts ?? []);
      const def = (prRes.prompts ?? []).find((p: Prompt) => p.is_default) ?? (prRes.prompts ?? [])[0];
      if (def) setActivePromptId(String(def.id));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const triggerCheck = async () => {
    setTriggering(true);
    await fetch(API("/trending/check?platform=douyin"), { method: "POST", headers });
    setTimeout(() => { setTriggering(false); load(); }, 4000);
  };

  const fmt = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);

  const openDetail = (p: TrendingPost) => {
    setActive(p);
    setRewritePreview(p.rewritten_text || "");
    setRewriteVariants([]);
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
      setActive({
        ...active,
        desc_text: d.desc_text,
        title: d.title || active.title,
        cover_url: d.cover_url || active.cover_url,
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

  // 抖音视频去水印下载：后端 /posts/{note_id}/video?clean=true 返回 302 → mp4 直链
  const videoDownloadUrl = (note_id: string) =>
    API(`/posts/${note_id}/video?clean=true`);

  // 轻量 markdown 渲染
  const renderMarkdown = (text: string) => {
    const lines = text.split("\n");
    return lines.map((raw, i) => {
      const line = raw.trimEnd();
      if (!line.trim()) return <br key={i} />;
      const h3 = line.match(/^###\s+(.+)$/);
      if (h3) return <h4 key={i} className="font-bold text-base mt-2">{h3[1]}</h4>;
      const h2 = line.match(/^##\s+(.+)$/);
      if (h2) return <h3 key={i} className="font-bold text-lg mt-2">{h2[1]}</h3>;
      const h1 = line.match(/^#\s+(.+)$/);
      if (h1) return <h2 key={i} className="font-bold text-xl mt-2">{h1[1]}</h2>;
      const li = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
      const content = li ? li[1] : line;
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

  const lengthBadge = (p: TrendingPost) => {
    const titleLen = (p.title || "").length;
    const descLen = (p.desc_text || "").length;
    if (descLen > 0) {
      return (
        <span className="text-xs">
          <span className="text-success-600 font-medium">文案 {descLen}</span>
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
      <PlatformSubNav platform="douyin" current="trending" />

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">抖音热门视频</h2>
          <p className="text-sm text-default-400 mt-1">
            选中视频 → 改写 → 同步飞书。每行支持「视频去水印下载」。
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <TrendingSettingsButton />
          <PromptTemplatesButton token={token} />
          <Button variant="flat" startContent={<RefreshCw size={15} />}
            onPress={load} isLoading={loading} size="sm">刷新</Button>
          <Button color="primary" startContent={<Sparkles size={15} />}
            onPress={triggerCheck} isLoading={triggering} size="sm">立即抓取</Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex justify-between items-center">
          <span className="text-sm">
            共 {posts.length} 条，已选 <strong>{selected.size}</strong> 条
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
              title="还没有抖音热门视频"
              hint="请先在管理员页配置抖音账号 cookie 并设置 trending 关键词，然后点「立即抓取」拉取一次。"
              action={
                <Button color="primary" startContent={<Sparkles size={14} />}
                  onPress={triggerCheck} isLoading={triggering}>
                  立即抓取
                </Button>
              }
            />
          ) : (
          <Table aria-label="douyin trending posts" removeWrapper isHeaderSticky>
            <TableHeader>
              <TableColumn className="w-10">
                <Checkbox
                  isSelected={posts.length > 0 && selected.size === posts.length}
                  isIndeterminate={selected.size > 0 && selected.size < posts.length}
                  onValueChange={(v) =>
                    setSelected(v ? new Set(posts.map((p) => p.note_id)) : new Set())
                  }
                />
              </TableColumn>
              <TableColumn>关键词</TableColumn>
              <TableColumn>封面</TableColumn>
              <TableColumn>标题</TableColumn>
              <TableColumn>文案</TableColumn>
              <TableColumn>作者</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>评论</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>改写预览</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {posts.map((p) => (
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
                    {p.cover_url ? (
                      <button
                        type="button"
                        className="relative block w-12 h-12 rounded overflow-hidden bg-default-100"
                        onClick={() => openDetail(p)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.cover_url} alt="cover"
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover" />
                        <span className="absolute right-0 bottom-0 bg-black/60 text-white text-[10px] px-1 rounded-tl">
                          ▶
                        </span>
                      </button>
                    ) : (
                      <span className="text-xs text-default-300">—</span>
                    )}
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
                  <TableCell><span className="text-sm">{fmt(p.comment_count)}</span></TableCell>
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
                        title="去水印下载（mp4）"
                        as="a" href={videoDownloadUrl(p.note_id)}
                        target="_blank" rel="noreferrer">
                        <Download size={14} />
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

            {/* 抖音是视频，直接放 video 标签；后端 video_url 可能带水印，
                播放时无所谓，下载用 /posts/{id}/video?clean=true 走去水印接口 */}
            {active && (active.video_url || active.cover_url) && (
              <div>
                <p className="text-xs font-medium text-default-400 mb-2">视频预览</p>
                {active.video_url ? (
                  <video
                    src={active.video_url}
                    controls
                    preload="metadata"
                    poster={active.cover_url}
                    className="w-full max-h-96 rounded-lg bg-black"
                  />
                ) : active.cover_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={active.cover_url} alt="cover"
                    referrerPolicy="no-referrer"
                    className="w-full max-h-64 object-contain rounded" />
                ) : null}
                <div className="flex gap-2 mt-2">
                  <Button as="a" size="sm" variant="flat" color="secondary"
                    startContent={<Download size={14} />}
                    href={videoDownloadUrl(active.note_id)}
                    target="_blank" rel="noreferrer">
                    去水印下载（mp4）
                  </Button>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-default-400">
                  原文案（{(active?.desc_text || "").length > 0
                    ? `文案 ${(active?.desc_text || "").length} 字`
                    : `仅标题 ${(active?.title || "").length} 字`}）
                </p>
                {!active?.desc_text && active && (
                  <Button size="sm" variant="flat" color="secondary"
                    isLoading={fetchingContent}
                    onPress={fetchFullContent}>
                    抓取完整文案
                  </Button>
                )}
              </div>
              <div className="bg-default-50 rounded-lg p-3 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                {active?.desc_text || active?.title || "（无文案，点击右上「抓取完整文案」）"}
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
              查看原视频
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
