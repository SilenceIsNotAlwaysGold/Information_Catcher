"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, CardBody, CardHeader, Button, Textarea, Chip,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure, Tooltip,
} from "@nextui-org/react";
import { Plus, RefreshCw, Trash2, Newspaper, Sparkles, ChevronDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const API = (path: string) => `/api/monitor${path}`;

type Post = {
  note_id: string;
  title: string;
  note_url: string;
  account_name?: string | null;
  liked_count: number | null;
  collected_count: number | null;
  comment_count: number | null;
  checked_at: string | null;
  last_fetch_status?: string;
  fail_count?: number;
  platform: string;
  summary?: string | null;
  summary_at?: string | null;
  // 公众号专属：copyright_stat 11=原创 / 100=转载（其他视为普通）
  copyright_stat?: string | null;
  source_url?: string | null;
};

function CopyrightChip({ stat }: { stat?: string | null }) {
  const s = (stat || "").trim();
  if (s === "11") return <Chip size="sm" color="success" variant="flat">原创</Chip>;
  if (s === "100" || s === "101") return <Chip size="sm" color="warning" variant="flat">转载</Chip>;
  return null;
}

export default function MpPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<Post[]>([]);
  const [links, setLinks] = useState("");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [summarizingId, setSummarizingId] = useState<string | null>(null);
  const [expandedSummary, setExpandedSummary] = useState<Set<string>>(new Set());

  const handleSummarize = async (note_id: string) => {
    setSummarizingId(note_id);
    try {
      const r = await fetch(API(`/posts/${note_id}/summarize`), { method: "POST", headers });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); msg = j.detail || msg; } catch {}
        alert(`摘要失败：${msg}`);
        return;
      }
      await load();
      setExpandedSummary((prev) => {
        const next = new Set(prev);
        next.add(note_id);
        return next;
      });
    } finally {
      setSummarizingId(null);
    }
  };

  const toggleSummary = (note_id: string) => {
    setExpandedSummary((prev) => {
      const next = new Set(prev);
      if (next.has(note_id)) next.delete(note_id); else next.add(note_id);
      return next;
    });
  };

  const load = useCallback(async () => {
    const r = await fetch(API("/posts?platform=mp"), { headers });
    const d = await r.json();
    setPosts(d.posts ?? []);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const items = links.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    setAdding(true);
    setResults([]);
    try {
      const r = await fetch(API("/posts"), {
        method: "POST", headers, body: JSON.stringify({ links: items }),
      });
      const d = await r.json();
      setResults(d.results ?? []);
      setLinks("");
      await load();
    } finally {
      setAdding(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers });
    setTimeout(async () => { await load(); setChecking(false); }, 4000);
  };

  const handleDelete = async (note_id: string) => {
    if (!confirm("确认删除这条监控？")) return;
    await fetch(API(`/posts/${note_id}`), { method: "DELETE", headers });
    await load();
  };

  const statusChip = (p: Post) => {
    const fc = p.fail_count ?? 0;
    if (fc >= 5) return <Chip size="sm" color="danger" variant="flat">⚠️ 已停抓</Chip>;
    if (p.last_fetch_status === "ok") return <Chip size="sm" color="success" variant="flat">已抓取</Chip>;
    if (p.last_fetch_status === "deleted")
      return <Chip size="sm" color="danger" variant="flat">已删除/违规</Chip>;
    if (p.last_fetch_status === "error") return <Chip size="sm" color="danger" variant="flat">异常</Chip>;
    return <Chip size="sm" variant="flat">未抓取</Chip>;
  };

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Newspaper size={22} className="text-success" />
          <h1 className="text-2xl font-bold">公众号文章</h1>
          <Chip size="sm" color="primary" variant="flat">v1 - 详情抓取</Chip>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="flat"
            startContent={<RefreshCw size={15} className={checking ? "animate-spin" : ""} />}
            onPress={handleCheck} isLoading={checking}>
            立即抓取
          </Button>
          <Button size="sm" color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
            添加文章
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="text-sm text-default-500 flex-col items-start gap-1">
          <span>v1 能力（完全匿名可达）：</span>
          <ul className="text-xs space-y-0.5 ml-3">
            <li>· 标题 / 作者 / 公众号名 / 发布时间</li>
            <li>· 正文摘要 + 配图 URL</li>
            <li>· 原创/转载标识 + 转载来源</li>
          </ul>
          <span className="text-xs text-warning mt-1">
            ⚠️ 阅读数 / 在看数 需要客户端凭证（开发中，issue #22）
          </span>
        </CardHeader>
        <CardBody className="p-0">
          <Table aria-label="mp-posts" removeWrapper>
            <TableHeader>
              <TableColumn>文章</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>最后抓取</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody emptyContent="还没有添加任何公众号文章">
              {posts.flatMap((p) => {
                const hasSummary = !!(p.summary && p.summary.length > 0);
                const expanded = expandedSummary.has(p.note_id);
                const rows = [
                  <TableRow key={p.note_id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <CopyrightChip stat={p.copyright_stat} />
                          <a href={p.note_url} target="_blank" rel="noreferrer"
                            className="text-primary text-sm truncate max-w-md hover:underline">
                            {p.title || p.note_id}
                          </a>
                          {hasSummary && (
                            <Tooltip content={expanded ? "收起摘要" : "展开摘要"}>
                              <Button isIconOnly size="sm" variant="light"
                                onPress={() => toggleSummary(p.note_id)}>
                                <ChevronDown size={14}
                                  className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                              </Button>
                            </Tooltip>
                          )}
                        </div>
                        {p.source_url && (
                          <a href={p.source_url} target="_blank" rel="noreferrer"
                            className="text-xs text-default-400 truncate max-w-md hover:underline">
                            转自：{p.source_url.slice(0, 60)}
                          </a>
                        )}
                        {!p.source_url && (
                          <span className="text-xs text-default-400 truncate max-w-md">
                            {p.note_id}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{statusChip(p)}</TableCell>
                    <TableCell>
                      <span className="text-xs text-default-400">
                        {p.checked_at ? p.checked_at.slice(0, 16) : "待抓取"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Tooltip content={hasSummary ? "重新生成摘要" : "AI 生成摘要"}>
                          <Button isIconOnly size="sm" variant="light"
                            isLoading={summarizingId === p.note_id}
                            onPress={() => handleSummarize(p.note_id)}>
                            <Sparkles size={15} className={hasSummary ? "text-primary" : ""} />
                          </Button>
                        </Tooltip>
                        <Tooltip content="删除" color="danger">
                          <Button isIconOnly size="sm" variant="light" color="danger"
                            onPress={() => handleDelete(p.note_id)}>
                            <Trash2 size={15} />
                          </Button>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>,
                ];
                if (hasSummary && expanded) {
                  rows.push(
                    <TableRow key={`${p.note_id}-summary`}>
                      <TableCell colSpan={4} className="bg-default-50">
                        <div className="flex items-start gap-2 py-2">
                          <Sparkles size={14} className="text-primary mt-1 shrink-0" />
                          <div className="flex-1">
                            <p className="text-xs text-default-400 mb-1">
                              AI 摘要 · {p.summary_at?.slice(0, 16) || ""}
                            </p>
                            <p className="text-sm text-default-700 whitespace-pre-wrap">
                              {p.summary}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                return rows;
              })}
            </TableBody>
          </Table>
        </CardBody>
      </Card>

      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalContent>
          <ModalHeader>添加公众号文章</ModalHeader>
          <ModalBody>
            <Textarea
              label="文章链接（每行一个）"
              placeholder={"https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...\n或 https://mp.weixin.qq.com/s/HASH"}
              value={links} onValueChange={setLinks} minRows={4}
            />
            {results.length > 0 && (
              <div className="text-xs space-y-1">
                {results.map((r, i) => (
                  <div key={i} className={r.ok ? "text-success" : "text-danger"}>
                    {r.ok ? "✓" : "✗"} {r.link.slice(0, 60)}{r.reason ? ` — ${r.reason}` : ""}
                  </div>
                ))}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>取消</Button>
            <Button color="primary" onPress={handleAdd} isLoading={adding}>添加</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
