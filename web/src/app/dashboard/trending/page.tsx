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

  const runRewrite = async () => {
    if (!active) return;
    setRewriting(true);
    try {
      const r = await fetch(API(`/trending/posts/${active.note_id}/rewrite`), {
        method: "POST", headers,
        body: JSON.stringify({ prompt_id: activePromptId ? parseInt(activePromptId) : null }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.detail || "改写失败");
        return;
      }
      setRewritePreview(d.rewritten);
      // reload to update list status
      await load();
    } finally {
      setRewriting(false);
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

  const statusChip = (p: TrendingPost) => {
    if (p.synced_to_bitable) return <Chip size="sm" color="success" variant="flat">已同步</Chip>;
    if (p.rewrite_status === "done") return <Chip size="sm" color="primary" variant="flat">已改写</Chip>;
    if (p.rewrite_status === "failed") return <Chip size="sm" color="danger" variant="flat">改写失败</Chip>;
    return <Chip size="sm" color="default" variant="flat">待改写</Chip>;
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
              <TableColumn>标题</TableColumn>
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
                    <button
                      type="button"
                      className="text-left text-sm text-primary line-clamp-2 max-w-[260px] hover:underline"
                      onClick={() => openDetail(p)}
                    >
                      {p.title || p.note_id}
                    </button>
                  </TableCell>
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
                      <span className="text-xs text-default-500 line-clamp-2 max-w-[260px] block">
                        {p.rewritten_text}
                      </span>
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

            <div>
              <p className="text-xs font-medium text-default-400 mb-1">原文</p>
              <div className="bg-default-50 rounded-lg p-3 text-sm whitespace-pre-wrap">
                {active?.desc_text || active?.title || "（搜索接口未返回正文，仅含标题）"}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-default-400">使用 Prompt 模板</p>
              <Select
                aria-label="prompt"
                selectedKeys={activePromptId ? new Set([activePromptId]) : new Set()}
                onSelectionChange={(keys) =>
                  setActivePromptId(Array.from(keys)[0] as string ?? "")
                }
                placeholder="选择模板"
              >
                {prompts.map((p) => (
                  <SelectItem key={String(p.id)}>
                    {p.name}{p.is_default ? "（默认）" : ""}
                  </SelectItem>
                ))}
              </Select>
              <Button color="primary" variant="flat"
                startContent={<Sparkles size={15} />}
                isLoading={rewriting}
                isDisabled={!activePromptId}
                onPress={runRewrite}>
                {rewritePreview ? "用此 Prompt 重新改写" : "改写"}
              </Button>
            </div>

            {rewritePreview && (
              <div>
                <p className="text-xs font-medium text-default-400 mb-1">改写结果</p>
                <div className="bg-primary-50 rounded-lg p-3 text-sm whitespace-pre-wrap border border-primary-100">
                  {rewritePreview}
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
