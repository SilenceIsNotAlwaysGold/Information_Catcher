"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Tooltip } from "@nextui-org/tooltip";
import { Select, SelectItem } from "@nextui-org/select";
import { Plus, RefreshCw, Trash2, Sparkles, ChevronDown, Search, Wand2, Copy, Key } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";

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
  const [results, setResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [summarizingId, setSummarizingId] = useState<string | null>(null);
  const [expandedSummary, setExpandedSummary] = useState<Set<string>>(new Set());
  const [searchQ, setSearchQ] = useState("");
  const [activeAuthor, setActiveAuthor] = useState<string | null>(null);

  // 客户端凭证（手动模式）
  const authModal = useDisclosure();
  const [authForm, setAuthForm] = useState({ uin: "", key: "", pass_ticket: "", appmsg_token: "" });
  const [authSaving, setAuthSaving] = useState(false);
  const [authStatus, setAuthStatus] = useState<{ has_auth: boolean; mp_auth_at: string | null }>({ has_auth: false, mp_auth_at: null });

  const loadAuthStatus = async () => {
    const r = await fetch(`/api/auth/me`, { headers });
    if (r.ok) {
      const u = await r.json();
      setAuthStatus({
        has_auth: !!(u.mp_auth_uin && u.mp_auth_key),
        mp_auth_at: u.mp_auth_at || null,
      });
    }
  };
  useEffect(() => { if (token) loadAuthStatus(); }, [token]);

  const submitAuth = async () => {
    setAuthSaving(true);
    try {
      await fetch(`/api/auth/me/mp-auth`, {
        method: "PUT", headers,
        body: JSON.stringify(authForm),
      });
      authModal.onClose();
      setAuthForm({ uin: "", key: "", pass_ticket: "", appmsg_token: "" });
      await loadAuthStatus();
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
  type CrossMode = "xhs" | "douyin" | "mp" | "saved" | "custom";
  const [crossMode, setCrossMode] = useState<CrossMode>("xhs");
  const [crossPromptId, setCrossPromptId] = useState<string>("");  // saved 模式选中的 prompt id
  const [crossPromptText, setCrossPromptText] = useState<string>("");  // custom 模式
  const [crossVariantCount, setCrossVariantCount] = useState<number>(3);

  // 用户保存的 prompt 列表
  type SavedPrompt = { id: number; name: string; content: string; is_default?: number };
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);

  const loadPrompts = useCallback(async () => {
    setPromptsLoading(true);
    try {
      const r = await fetch(API("/prompts"), { headers });
      if (r.ok) {
        const d = await r.json();
        setSavedPrompts(d.prompts || []);
      }
    } finally {
      setPromptsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openCrossRewrite = (note_id: string) => {
    setCrossNoteId(note_id);
    setCrossVariants([]);
    setCrossError("");
    setCrossLoading(false);
    setCrossMode("xhs");
    setCrossPromptText("");
    crossModal.onOpen();
    loadPrompts();
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
          <Table aria-label="mp-posts" removeWrapper>
            <TableHeader>
              <TableColumn>文章</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>最后抓取</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody emptyContent={searchQ ? "没有匹配的文章" : "还没有添加任何公众号文章"}>
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

      {/* 阅读数凭证录入 Modal */}
      <Modal isOpen={authModal.isOpen} onClose={authModal.onClose} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <Key size={18} className="text-warning" />
            录入公众号客户端凭证
            <Chip size="sm" variant="flat">v1 手动模式</Chip>
          </ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-sm text-default-600 space-y-2 bg-default-50 rounded-lg p-3">
              <p className="font-medium">为什么要录入凭证？</p>
              <p className="text-xs text-default-500">
                公众号阅读数 / 在看数只能通过模拟客户端抓取，需要 <code>uin / key / pass_ticket / appmsg_token</code> 4 个字段，
                key 大约 30 分钟过期，过期后需要重新录入。
              </p>
              <p className="font-medium pt-1">如何获取？</p>
              <ol className="text-xs text-default-500 ml-4 space-y-0.5 list-decimal">
                <li>用 Charles / Fiddler / mitmproxy 抓微信包（手机和电脑同一 wifi 配代理）</li>
                <li>在微信里打开任意公众号文章</li>
                <li>找到 <code>/mp/getappmsgext</code> 请求，从 URL 参数复制 uin / key / pass_ticket / appmsg_token</li>
                <li>粘贴到下面输入框保存</li>
              </ol>
              <p className="text-xs text-warning">
                ⚠️ key 过期后调用会失败、显示阅读数 0；管理员可考虑接 NewRank SaaS（issue #23）避免维护
              </p>
            </div>
            <Input label="uin" placeholder="MzXxxxxxx 或纯数字"
              value={authForm.uin}
              onValueChange={(v) => setAuthForm((f) => ({ ...f, uin: v }))} />
            <Input label="key" placeholder="abc..." type="password"
              value={authForm.key}
              onValueChange={(v) => setAuthForm((f) => ({ ...f, key: v }))} />
            <Input label="pass_ticket（可选）" placeholder="abc..."
              value={authForm.pass_ticket}
              onValueChange={(v) => setAuthForm((f) => ({ ...f, pass_ticket: v }))} />
            <Input label="appmsg_token（可选）" placeholder="abc..."
              value={authForm.appmsg_token}
              onValueChange={(v) => setAuthForm((f) => ({ ...f, appmsg_token: v }))} />
            <p className="text-xs text-default-400">
              {authStatus.has_auth
                ? `当前凭证更新于 ${authStatus.mp_auth_at?.slice(0, 16)}（提交新值会覆盖）`
                : "尚未录入凭证。无凭证时阅读数显示为 0，但文章正文/标题/摘要等仍然可抓。"}
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={authModal.onClose}>取消</Button>
            <Button color="primary" onPress={submitAuth} isLoading={authSaving}
              isDisabled={!authForm.uin || !authForm.key}>
              保存凭证
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* AI 改写 modal */}
      <Modal isOpen={crossModal.isOpen} onClose={crossModal.onClose} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <Wand2 size={18} className="text-primary" />
            AI 改写
            <Chip size="sm" variant="flat">{crossVariantCount} 个变体</Chip>
          </ModalHeader>
          <ModalBody className="space-y-3">
            {/* 目标平台 / 模式选择 */}
            <div>
              <p className="text-xs text-default-500 mb-2">目标平台 / 改写风格</p>
              <div className="flex flex-wrap gap-2">
                {([
                  { key: "xhs",    label: "小红书" },
                  { key: "douyin", label: "抖音" },
                  { key: "mp",     label: "公众号" },
                  { key: "saved",  label: "我的 Prompt" },
                  { key: "custom", label: "自定义" },
                ] as { key: CrossMode; label: string }[]).map((opt) => (
                  <Chip key={opt.key}
                    size="sm"
                    variant={crossMode === opt.key ? "solid" : "flat"}
                    color={crossMode === opt.key ? "primary" : "default"}
                    className="cursor-pointer"
                    onClick={() => setCrossMode(opt.key)}
                  >
                    {opt.label}
                  </Chip>
                ))}
              </div>
            </div>

            {/* saved 模式：选择已保存 prompt */}
            {crossMode === "saved" && (
              <div>
                <Select
                  size="sm"
                  label="选择保存的 Prompt"
                  placeholder={promptsLoading ? "加载中…" : "—"}
                  selectedKeys={crossPromptId ? [crossPromptId] : []}
                  onSelectionChange={(keys) => {
                    const v = Array.from(keys)[0];
                    setCrossPromptId(v ? String(v) : "");
                  }}
                >
                  {savedPrompts.map((p) => (
                    <SelectItem key={String(p.id)} textValue={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </Select>
                {savedPrompts.length === 0 && !promptsLoading && (
                  <p className="text-xs text-default-400 mt-1">
                    还没有保存的 prompt，可以去「Prompt 管理」创建，或选「自定义」直接写。
                  </p>
                )}
              </div>
            )}

            {/* custom 模式：直接输 prompt */}
            {crossMode === "custom" && (
              <div>
                <Textarea
                  size="sm"
                  label="自定义 Prompt"
                  placeholder={"请把以下原文改写为...\n\n要求：...\n\n原文：\n{content}"}
                  description="必须包含 {content} 占位符——它会被原文正文替换。"
                  minRows={6}
                  value={crossPromptText}
                  onValueChange={setCrossPromptText}
                />
              </div>
            )}

            {/* 变体数量 */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-default-500">变体数量：</span>
              {[1, 3, 5].map((n) => (
                <Chip key={n} size="sm"
                  variant={crossVariantCount === n ? "solid" : "flat"}
                  color={crossVariantCount === n ? "primary" : "default"}
                  className="cursor-pointer"
                  onClick={() => setCrossVariantCount(n)}>
                  {n}
                </Chip>
              ))}
            </div>

            {/* 错误提示 */}
            {crossError && (
              <p className="text-sm text-danger">{crossError}</p>
            )}

            {/* 改写中 */}
            {crossLoading && (
              <div className="text-center py-8 text-default-500">
                AI 改写中…（公众号长文，请稍候 10-30s）
              </div>
            )}

            {/* 结果 */}
            {!crossLoading && crossVariants.length > 0 && (
              <>
                <p className="text-xs text-default-500">
                  生成了 {crossVariants.length} 个不同温度的变体，挑一个复制使用：
                </p>
                {crossVariants.map((v, i) => (
                  <div key={i} className="rounded-lg p-3 border bg-default-50 border-default-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-default-500">变体 #{i + 1}</span>
                      <Tooltip content="复制到剪贴板">
                        <Button isIconOnly size="sm" variant="flat"
                          onPress={async () => {
                            await navigator.clipboard.writeText(v);
                          }}>
                          <Copy size={14} />
                        </Button>
                      </Tooltip>
                    </div>
                    <pre className="whitespace-pre-wrap text-sm text-default-700 font-sans">{v}</pre>
                  </div>
                ))}
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={crossModal.onClose}>关闭</Button>
            <Button color="primary"
              startContent={<Wand2 size={14} />}
              onPress={runCrossRewrite}
              isLoading={crossLoading}
              isDisabled={crossLoading}>
              开始改写
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
