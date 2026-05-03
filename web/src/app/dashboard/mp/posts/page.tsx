"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { useDisclosure } from "@nextui-org/modal";
import { Tooltip } from "@nextui-org/tooltip";
import { Plus, RefreshCw, Trash2, Sparkles, ChevronDown, Search, Wand2, Key, Newspaper } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import { useMe, mutateMe, usePrompts } from "@/lib/useApi";
import { toastErr } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";

// Modal —— 首屏不需要，懒加载
const AddMpPostsModal = dynamic(() => import("./_modals/AddMpPostsModal"), { ssr: false });
const MpAuthModal = dynamic(() => import("./_modals/MpAuthModal"), { ssr: false });
const CrossRewriteModal = dynamic(() => import("./_modals/CrossRewriteModal"), { ssr: false });

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
  author?: string | null;  // 公众号名 / 抖音博主名
};

function CopyrightChip({ stat }: { stat?: string | null }) {
  const s = (stat || "").trim();
  if (s === "11") return <Chip size="sm" color="success" variant="flat">原创</Chip>;
  if (s === "100" || s === "101") return <Chip size="sm" color="warning" variant="flat">转载</Chip>;
  return null;
}

export default function MpPostsPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<Post[]>([]);
  const [links, setLinks] = useState("");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [summarizingId, setSummarizingId] = useState<string | null>(null);
  const [expandedSummary, setExpandedSummary] = useState<Set<string>>(new Set());
  const [searchQ, setSearchQ] = useState("");
  const [activeAuthor, setActiveAuthor] = useState<string | null>(null);

  // 客户端凭证（手动模式）—— /api/auth/me 走 SWR 缓存
  const authModal = useDisclosure();
  const [authForm, setAuthForm] = useState({ uin: "", key: "", pass_ticket: "", appmsg_token: "" });
  const [authSaving, setAuthSaving] = useState(false);
  const { data: me } = useMe();
  const authStatus = {
    has_auth: !!(me?.mp_auth_uin && me?.mp_auth_key),
    mp_auth_at: me?.mp_auth_at || null,
  };

  const submitAuth = async () => {
    setAuthSaving(true);
    try {
      await fetch(`/api/auth/me/mp-auth`, {
        method: "PUT", headers,
        body: JSON.stringify(authForm),
      });
      authModal.onClose();
      setAuthForm({ uin: "", key: "", pass_ticket: "", appmsg_token: "" });
      await mutateMe();
    } finally {
      setAuthSaving(false);
    }
  };

  // AI 改写（原"跨平台改写"，现支持自选 prompt / 平台模板）
  const crossModal = useDisclosure();
  const [crossNoteId, setCrossNoteId] = useState<string | null>(null);
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossVariants, setCrossVariants] = useState<string[]>([]);
  const [crossError, setCrossError] = useState("");

  // 改写配置
  type CrossMode = "xhs" | "douyin" | "mp" | "saved" | "custom"; // 与 _modals/CrossRewriteModal.tsx 中的同名类型保持一致
  const [crossMode, setCrossMode] = useState<CrossMode>("xhs");
  const [crossPromptId, setCrossPromptId] = useState<string>("");  // saved 模式选中的 prompt id
  const [crossPromptText, setCrossPromptText] = useState<string>("");  // custom 模式
  const [crossVariantCount, setCrossVariantCount] = useState<number>(3);

  // 用户保存的 prompt 列表 —— 走 SWR 缓存
  const { prompts: savedPrompts, isLoading: promptsLoading } = usePrompts();

  const openCrossRewrite = (note_id: string) => {
    setCrossNoteId(note_id);
    setCrossVariants([]);
    setCrossError("");
    setCrossLoading(false);
    setCrossMode("xhs");
    setCrossPromptText("");
    crossModal.onOpen();
  };

  const runCrossRewrite = async () => {
    if (!crossNoteId) return;
    setCrossError("");
    setCrossVariants([]);

    // 组装 body
    const body: Record<string, unknown> = { variants: crossVariantCount };
    if (crossMode === "custom") {
      const txt = crossPromptText.trim();
      if (!txt) { setCrossError("请填写自定义 prompt"); return; }
      if (!txt.includes("{content}")) {
        setCrossError("自定义 prompt 必须包含 {content} 占位符（用来替换原文）");
        return;
      }
      body.prompt_text = txt;
    } else if (crossMode === "saved") {
      if (!crossPromptId) { setCrossError("请选择一个已保存的 prompt"); return; }
      body.prompt_id = Number(crossPromptId);
    } else {
      body.target = crossMode;  // xhs / douyin / mp 内置模板
    }

    setCrossLoading(true);
    try {
      const r = await fetch(
        API(`/posts/${crossNoteId}/rewrite-cross-platform`),
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      if (!r.ok) {
        let msg = "改写失败";
        try { const j = await r.json(); msg = j.detail || msg; } catch {}
        setCrossError(msg);
        return;
      }
      const d = await r.json();
      setCrossVariants(d.variants || []);
    } finally {
      setCrossLoading(false);
    }
  };

  // 列出所有 author（按出现次数倒序）
  const authorCounts = (() => {
    const m: Record<string, number> = {};
    for (const p of posts) {
      const a = (p.author || "").trim();
      if (!a) continue;
      m[a] = (m[a] || 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  })();

  // 客户端过滤：搜索 + author chip
  const filteredPosts = (() => {
    let arr = posts;
    if (activeAuthor) arr = arr.filter((p) => (p.author || "") === activeAuthor);
    const q = searchQ.trim().toLowerCase();
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean);
      arr = arr.filter((p) => {
        const hay = `${p.title || ""} ${p.summary || ""} ${p.note_id} ${p.author || ""}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }
    return arr;
  })();

  const handleSummarize = async (note_id: string) => {
    setSummarizingId(note_id);
    try {
      const r = await fetch(API(`/posts/${note_id}/summarize`), { method: "POST", headers });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); msg = j.detail || msg; } catch {}
        toastErr(`摘要失败：${msg}`);
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
    setLoading(true);
    try {
      const r = await fetch(API("/posts?platform=mp"), { headers });
      const d = await r.json();
      setPosts(d.posts ?? []);
    } finally {
      setLoading(false);
    }
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
    const ok = await confirmDialog({
      title: "删除监控",
      content: "确认删除这条监控？",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
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
      <PlatformSubNav platform="mp" current="posts" />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">文章列表</h2>
          <Chip size="sm" color="primary" variant="flat">v1 - 详情抓取</Chip>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="flat"
            startContent={<Key size={15} />}
            color={authStatus.has_auth ? "success" : "warning"}
            onPress={authModal.onOpen}>
            {authStatus.has_auth ? "凭证已录入" : "录入阅读数凭证"}
          </Button>
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
        <CardHeader className="flex-col items-start gap-2">
          <Input
            size="sm"
            placeholder="搜索标题/摘要/作者（多关键词空格分隔）"
            startContent={<Search size={14} className="text-default-400" />}
            value={searchQ}
            onValueChange={setSearchQ}
            className="max-w-md"
            isClearable
          />
          {authorCounts.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-xs text-default-400 mr-1">公众号：</span>
              <Chip
                size="sm"
                variant={activeAuthor === null ? "solid" : "flat"}
                color={activeAuthor === null ? "primary" : "default"}
                className="cursor-pointer"
                onClick={() => setActiveAuthor(null)}
              >
                全部 ({posts.length})
              </Chip>
              {authorCounts.map(([name, n]) => (
                <Chip key={name}
                  size="sm"
                  variant={activeAuthor === name ? "solid" : "flat"}
                  color={activeAuthor === name ? "primary" : "default"}
                  className="cursor-pointer"
                  onClick={() => setActiveAuthor(activeAuthor === name ? null : name)}
                >
                  {name} ({n})
                </Chip>
              ))}
            </div>
          )}
          <div className="text-xs text-default-400 flex items-center gap-2">
            <span>共 {posts.length} 篇{(searchQ || activeAuthor) ? `（匹配 ${filteredPosts.length}）` : ""}</span>
            <span>·</span>
            <span>原创/转载标识 · AI 摘要 · 阅读数（开发中 #22）</span>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={4} />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={Newspaper}
              title="还没有添加任何公众号文章"
              hint="粘贴 mp.weixin.qq.com 文章链接（biz/mid/idx 完整链接 或 /s/HASH 短链）开始抓取标题、原文、阅读数。"
              action={
                <Button color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
                  添加文章
                </Button>
              }
            />
          ) : filteredPosts.length === 0 ? (
            <EmptyState
              icon={Search}
              title="没有匹配的文章"
              hint="尝试清空搜索关键词或切换公众号筛选。"
            />
          ) : (
          <Table aria-label="mp-posts" removeWrapper>
            <TableHeader>
              <TableColumn>文章</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>最后抓取</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {filteredPosts.flatMap((p) => {
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
                        <div className="flex items-center gap-2 text-xs text-default-400">
                          {p.author && (
                            <span className="text-success">📢 {p.author}</span>
                          )}
                          {p.source_url ? (
                            <a href={p.source_url} target="_blank" rel="noreferrer"
                              className="truncate max-w-sm hover:underline">
                              转自：{p.source_url.slice(0, 50)}
                            </a>
                          ) : (
                            <span className="truncate max-w-sm">{p.note_id.slice(0, 24)}</span>
                          )}
                        </div>
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
                        <Tooltip content="AI 改写（可选目标平台 / 自定义 prompt）">
                          <Button isIconOnly size="sm" variant="light"
                            onPress={() => openCrossRewrite(p.note_id)}>
                            <Wand2 size={15} />
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
          )}
        </CardBody>
      </Card>

      {/* Modal —— 懒加载，仅当用户打开后才加载 chunk */}
      {isOpen && (
        <AddMpPostsModal
          isOpen={isOpen}
          onClose={onClose}
          links={links}
          setLinks={setLinks}
          results={results}
          adding={adding}
          onSubmit={handleAdd}
        />
      )}
      {authModal.isOpen && (
        <MpAuthModal
          isOpen={authModal.isOpen}
          onClose={authModal.onClose}
          authForm={authForm}
          setAuthForm={setAuthForm}
          authStatus={authStatus}
          authSaving={authSaving}
          onSubmit={submitAuth}
        />
      )}
      {crossModal.isOpen && (
        <CrossRewriteModal
          isOpen={crossModal.isOpen}
          onClose={crossModal.onClose}
          crossMode={crossMode}
          setCrossMode={setCrossMode}
          crossPromptId={crossPromptId}
          setCrossPromptId={setCrossPromptId}
          crossPromptText={crossPromptText}
          setCrossPromptText={setCrossPromptText}
          crossVariantCount={crossVariantCount}
          setCrossVariantCount={setCrossVariantCount}
          savedPrompts={savedPrompts}
          promptsLoading={promptsLoading}
          crossError={crossError}
          crossLoading={crossLoading}
          crossVariants={crossVariants}
          onRun={runCrossRewrite}
        />
      )}
    </div>
  );
}
