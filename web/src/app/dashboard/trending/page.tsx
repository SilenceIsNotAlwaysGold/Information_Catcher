"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, CardBody, CardHeader,
  Button, Chip, Input, Select, SelectItem, Checkbox,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/react";
import { RefreshCw, ExternalLink, Sparkles, Send } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

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

export default function TrendingPage() {
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
  const [backfilling, setBackfilling] = useState(false);

  const backfillMedia = async () => {
    setBackfilling(true);
    try {
      const r = await fetch(API("/trending/backfill-media?only_missing=true"), {
        method: "POST", headers,
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.detail || "触发失败"); return;
      }
      // 后台异步执行；轮询刷新
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 8000));
        await load();
      }
    } finally {
      setBackfilling(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, prRes] = await Promise.all([
        fetch(API("/trending?limit=200"), { headers }).then((r) => r.json()),
        fetch(API("/prompts"),               { headers }).then((r) => r.json()),
      ]);
      setPosts(pRes.posts ?? []);
      setPrompts(prRes.prompts ?? []);
      // pick default prompt
      const def = (prRes.prompts ?? []).find((p: Prompt) => p.is_default) ?? (prRes.prompts ?? [])[0];
      if (def) setActivePromptId(String(def.id));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const triggerCheck = async () => {
    setTriggering(true);
    await fetch(API("/trending/check"), { method: "POST", headers });
    setTimeout(() => { setTriggering(false); load(); }, 4000);
  };

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
        alert(d.detail || "抓取正文失败");
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
        alert(d.detail || "改写失败");
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
        alert(msg);
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
        alert(d.detail || "同步失败");
        return;
      }
      const okCount = (d.results || []).filter((x: any) => x.ok).length;
      const failCount = (d.results || []).filter((x: any) => !x.ok).length;
      alert(`同步完成：成功 ${okCount} 条${failCount ? `，失败 ${failCount} 条` : ""}`);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">热门内容</h1>
          <p className="text-sm text-default-400 mt-1">
            选中帖子→改写→同步飞书。改写和同步不再自动跑。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" startContent={<RefreshCw size={15} />}
            onPress={load} isLoading={loading} size="sm">刷新</Button>
          <Button variant="flat" color="secondary" size="sm"
            isLoading={backfilling}
            onPress={backfillMedia}>
            补全图片/视频
          </Button>
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
          <Table aria-label="trending posts" removeWrapper isHeaderSticky>
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
              <TableColumn>内容</TableColumn>
              <TableColumn>作者</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>收藏</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>改写预览</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody emptyContent="暂无热门内容">
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
                          <img src={cover} alt="cover"
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
                      {imgs.map((url, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={i} src={url} alt={`img-${i}`}
                          referrerPolicy="no-referrer"
                          className="w-full h-32 object-cover rounded cursor-pointer hover:opacity-80"
                          onClick={() => window.open(url, "_blank")} />
                      ))}
                    </div>
                  ) : active.cover_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={active.cover_url} alt="cover"
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
