"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { Checkbox } from "@nextui-org/checkbox";
import { useDisclosure } from "@nextui-org/modal";
import { Tooltip } from "@nextui-org/tooltip";
import { Select, SelectItem } from "@nextui-org/select";
import {
  Plus, RefreshCw, Trash2, BarChart2, Settings, Search, FileText, Inbox,
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, X as XIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { MonitorGroupsButton } from "@/components/MonitorGroupsButton";
import { MonitorPaceButton } from "@/components/MonitorPaceButton";
import { MoveGroupButton } from "@/components/MoveGroupButton";
import {
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem,
} from "@nextui-org/dropdown";
import { FolderInput } from "lucide-react";
import { toastOk, toastErr } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";
import { useAccounts, useGroups, usePosts, useAlerts, useMe, mutatePosts, mutateAlerts } from "@/lib/useApi";

// 添加帖子 Modal —— 首屏不需要，懒加载
const AddPostsModal = dynamic(() => import("./_modals/AddPostsModal"), { ssr: false });

const API = (path: string) => `/api/monitor${path}`;

type Post = {
  note_id: string;
  title: string;
  short_url: string;
  note_url: string;
  account_name: string | null;
  liked_count: number | null;
  collected_count: number | null;
  comment_count: number | null;
  checked_at: string | null;
  post_type: string; // legacy
  group_id: number | null;
  group_name: string | null;
  creator_id?: number | null;
  last_fetch_status?: string;
  last_fetch_at?: string | null;
  fail_count?: number;
  platform?: string; // "xhs" / "douyin" / "mp"，老数据为 "xhs"
  user_id?: number | null;
  owner_username?: string;
};

type Alert = {
  id: number;
  note_id: string;
  title: string;
  alert_type: string;
  message: string;
  created_at: string;
};

// 仅当帖子明确属于 xhs 时显示。老数据 platform 为空也按 xhs 处理（老数据库默认 xhs）。
const isXhs = (p: Post) => !p.platform || p.platform === "xhs";

export default function XhsPostsPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // posts / alerts 走 SWR 共享缓存；accounts / groups 同理
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const { posts: rawPosts, isLoading } = usePosts();
  // 排除博主追新的帖子（有 creator_id），它们在「博主追新」板块单独展示
  const posts = (rawPosts as Post[]).filter((p) => isXhs(p) && p.creator_id == null);
  const { alerts } = useAlerts(30);
  const { accounts } = useAccounts();
  const { groups } = useGroups();
  const [links, setLinks] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [addResults, setAddResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);
  const [search, setSearch] = useState("");

  // 多选状态：key 用 `${user_id || 0}__${note_id}` 区分不同租户的同 id
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const postKey = (p: Post) => `${p.user_id || 0}__${p.note_id}`;
  const toggleKey = (k: string) => setSelectedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const togglePageAll = (rows: Post[]) => setSelectedKeys((prev) => {
    const allKeys = rows.map(postKey);
    const allOn = allKeys.length > 0 && allKeys.every((k) => prev.has(k));
    const next = new Set(prev);
    for (const k of allKeys) {
      if (allOn) next.delete(k); else next.add(k);
    }
    return next;
  });

  const { isOpen, onOpen, onClose } = useDisclosure();

  const handleAdd = async () => {
    const items = links.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!items.length) return;
    setAdding(true);
    setAddResults([]);
    try {
      const res = await fetch(API("/posts"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          links: items,
          account_id: selectedAccount ? parseInt(selectedAccount) : null,
          group_id: selectedGroupId ? parseInt(selectedGroupId) : null,
        }),
      });
      const data = await res.json();
      setAddResults(data.results ?? []);
      setLinks("");
      await mutatePosts();
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (note_id: string, owner_user_id?: number | null) => {
    const qs = owner_user_id ? `?owner_user_id=${owner_user_id}` : "";
    await fetch(API(`/posts/${note_id}${qs}`), { method: "DELETE", headers });
    await mutatePosts();
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.size === 0) return;
    const ok = await confirmDialog({
      title: "批量删除",
      content: `确认删除选中的 ${selectedKeys.size} 条帖子？`,
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    // selectedKeys 形如 "user_id__note_id"，提取 note_id
    const noteIds = Array.from(selectedKeys).map((k) => k.split("__").slice(1).join("__"));
    await fetch(API("/posts/batch-delete"), {
      method: "POST", headers,
      body: JSON.stringify({ note_ids: noteIds }),
    });
    setSelectedKeys(new Set());
    await mutatePosts();
  };

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers });
    setTimeout(() => { mutatePosts(); setChecking(false); }, 3000);
  };

  const handleDeleteAlert = async (id: number) => {
    await fetch(API(`/alerts/${id}`), { method: "DELETE", headers });
    await mutateAlerts();
  };

  const handleClearAlerts = async () => {
    if (!alerts.length) return;
    const ok = await confirmDialog({
      title: "清空告警记录",
      content: `确认清空全部 ${alerts.length} 条告警记录？`,
      confirmText: "清空",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    await fetch(API("/alerts"), { method: "DELETE", headers });
    await mutateAlerts();
  };

  const alertTypeColor = (t: string): "warning" | "primary" | "success" =>
    t === "likes" || t === "collects" ? "warning" : "primary";
  const alertTypeLabel = (t: string) =>
    t === "likes" ? "点赞飙升" : t === "collects" ? "收藏飙升" : "新评论";

  const fetchStatusChip = (p: Post) => {
    const s = p.last_fetch_status;
    const fc = p.fail_count ?? 0;
    if (fc >= 5) {
      return (
        <Tooltip content={`连续 ${fc} 次抓取失败，调度器已停止抓取该帖子。点上方"清理失效"批量删除。`}>
          <Chip size="sm" color="danger" variant="flat">⚠️ 已停抓</Chip>
        </Tooltip>
      );
    }
    if (s === "login_required") {
      return (
        <Tooltip content={`XHS 对该帖子加了登录墙，匿名 ${fc} 次都失败。token 失效，建议删除。`}>
          <Chip size="sm" color="warning" variant="flat">🔒 需登录 {fc > 0 ? `(${fc})` : ""}</Chip>
        </Tooltip>
      );
    }
    if (s === "deleted") {
      return <Chip size="sm" color="danger" variant="flat">已删除</Chip>;
    }
    if (s === "error") {
      return <Chip size="sm" color="danger" variant="flat">抓取异常 {fc > 0 ? `(${fc})` : ""}</Chip>;
    }
    if (s === "ok") {
      return <Chip size="sm" color="success" variant="flat">正常</Chip>;
    }
    return <Chip size="sm" color="default" variant="flat">未检测</Chip>;
  };

  const handleCleanupDead = async () => {
    const dead = posts.filter((p) => (p.fail_count ?? 0) >= 5);
    if (!dead.length) {
      toastErr("没有连续失败超过 5 次的帖子");
      return;
    }
    const ok = await confirmDialog({
      title: "清理失效帖子",
      content: `将停抓 ${dead.length} 条已失效的帖子（不可撤销，但帖子不会真删除，可以重新添加）？`,
      confirmText: "停抓",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    const r = await fetch(API("/posts/cleanup-dead"), { method: "POST", headers });
    const d = await r.json();
    toastOk(`已清理 ${d.cleaned} 条失效帖子`);
    await mutatePosts();
  };

  // ── 筛选 + 排序 + 分页 状态 ────────────────────────────────────────────────
  const [groupFilter, setGroupFilter] = useState<string>("");   // "" 全部 / "_none" 未分组 / "<gid>"
  const [statusFilter, setStatusFilter] = useState<string>(""); // "" / ok / error / deleted / login_required / dead / untested
  const [minLikes, setMinLikes] = useState<string>("");
  const [minCollects, setMinCollects] = useState<string>("");
  const [minComments, setMinComments] = useState<string>("");
  const [sortBy, setSortBy] = useState<"liked" | "collected" | "comment" | "checked" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [alertsOpen, setAlertsOpen] = useState(false);

  const toggleSort = (field: "liked" | "collected" | "comment" | "checked") => {
    if (sortBy === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortBy(field); setSortDir("desc"); }
  };
  const sortIcon = (field: typeof sortBy) =>
    sortBy === field
      ? (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
      : <ChevronsUpDown size={12} className="text-default-300" />;

  const resetFilters = () => {
    setSearch(""); setGroupFilter(""); setStatusFilter("");
    setMinLikes(""); setMinCollects(""); setMinComments("");
    setSortBy(null); setPage(1);
  };

  // 状态判断函数（沿用 fetchStatusChip 的判定逻辑）
  const matchStatus = (p: Post, target: string): boolean => {
    const fc = p.fail_count ?? 0;
    const s = p.last_fetch_status || "";
    if (target === "dead") return fc >= 5;
    if (target === "login_required") return s === "login_required" && fc < 5;
    if (target === "deleted") return s === "deleted";
    if (target === "error") return s === "error";
    if (target === "ok") return s === "ok";
    if (target === "untested") return !s;
    return true;
  };

  // 复合筛选
  const kw = search.trim().toLowerCase();
  const filteredPosts = posts
    .filter((p) => {
      if (kw && !(
        (p.title || "").toLowerCase().includes(kw) ||
        (p.note_id || "").toLowerCase().includes(kw) ||
        (p.account_name || "").toLowerCase().includes(kw)
      )) return false;
      if (groupFilter === "_none") { if (p.group_id) return false; }
      else if (groupFilter) { if (String(p.group_id ?? "") !== groupFilter) return false; }
      if (statusFilter && !matchStatus(p, statusFilter)) return false;
      const minL = parseInt(minLikes || "0", 10);
      if (minL > 0 && (p.liked_count ?? 0) < minL) return false;
      const minC = parseInt(minCollects || "0", 10);
      if (minC > 0 && (p.collected_count ?? 0) < minC) return false;
      const minM = parseInt(minComments || "0", 10);
      if (minM > 0 && (p.comment_count ?? 0) < minM) return false;
      return true;
    });

  // 排序（在筛选后做，避免无意义计算）
  const sortedPosts = sortBy
    ? [...filteredPosts].sort((a, b) => {
        const fld = sortBy === "liked" ? "liked_count"
                  : sortBy === "collected" ? "collected_count"
                  : sortBy === "comment" ? "comment_count"
                  : "checked_at";
        const av = (a as any)[fld] ?? (sortBy === "checked" ? "" : 0);
        const bv = (b as any)[fld] ?? (sortBy === "checked" ? "" : 0);
        const cmp = sortBy === "checked"
          ? String(av).localeCompare(String(bv))
          : (Number(av) - Number(bv));
        return sortDir === "asc" ? cmp : -cmp;
      })
    : filteredPosts;

  // 分页
  const totalCount = sortedPosts.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedPosts = sortedPosts.slice((safePage - 1) * pageSize, safePage * pageSize);

  // 筛选 / 排序 / pageSize 变化时回到第 1 页；page 越界时也夹回
  useEffect(() => { setPage(1); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kw, groupFilter, statusFilter, minLikes, minCollects, minComments, pageSize]);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);

  // 分组名查找（用于 chip 显示）
  const groupNameOf = (gid: number | null): string => {
    if (!gid) return "未分组";
    return (groups as any[]).find((g) => g.id === gid)?.name || `#${gid}`;
  };

  return (
    <div className="p-6 space-y-4">
      <PlatformSubNav platform="xhs" current="posts" />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">监控帖子（共 {filteredPosts.length} 条）</h2>
        <div className="flex gap-2">
          {selectedKeys.size > 0 && (
            <>
              <Dropdown placement="bottom-end">
                <DropdownTrigger>
                  <Button size="sm" color="primary" variant="flat"
                    startContent={<FolderInput size={14} />}>
                    移动到 ({selectedKeys.size})
                  </Button>
                </DropdownTrigger>
                <DropdownMenu
                  aria-label="批量移动到分组"
                  onAction={async (key) => {
                    const v = String(key);
                    const gid = v === "_none" ? null : parseInt(v, 10);
                    const noteIds = Array.from(selectedKeys).map(
                      (k) => k.split("__").slice(1).join("__"),
                    );
                    try {
                      const r = await fetch(API("/posts/batch-move-group"), {
                        method: "POST", headers,
                        body: JSON.stringify({ note_ids: noteIds, group_id: gid }),
                      });
                      const data = await r.json().catch(() => ({}));
                      if (!r.ok) { toastErr(data.detail || `HTTP ${r.status}`); return; }
                      const target = gid == null
                        ? "未分组"
                        : (groups.find((g: any) => g.id === gid)?.name || "新分组");
                      toastOk(`已移动 ${data.moved || 0} 条到「${target}」`);
                      setSelectedKeys(new Set());
                      await mutatePosts();
                    } catch (e: any) { toastErr(`移动失败：${e?.message || e}`); }
                  }}
                >
                  <>
                    <DropdownItem key="_none">未分组</DropdownItem>
                    {(groups || []).map((g: any) => (
                      <DropdownItem key={String(g.id)}>{g.name}</DropdownItem>
                    ))}
                  </>
                </DropdownMenu>
              </Dropdown>
              <Button
                size="sm" color="danger" variant="flat"
                startContent={<Trash2 size={14} />}
                onPress={handleBatchDelete}
              >
                删除选中 ({selectedKeys.size})
              </Button>
            </>
          )}
          <Input
            size="sm" variant="bordered"
            startContent={<Search size={14} />}
            placeholder="搜索标题 / ID / 作者"
            value={search}
            onValueChange={setSearch}
            className="w-64"
          />
          <Button
            size="sm" variant="flat"
            startContent={<RefreshCw size={16} className={checking ? "animate-spin" : ""} />}
            onPress={handleCheck} isLoading={checking}
          >
            立即检测
          </Button>
          {posts.some((p) => (p.fail_count ?? 0) >= 5) && (
            <Tooltip content="连续 5 次以上抓取失败的帖子停止抓取（token 已失效）">
              <Button size="sm" variant="flat" color="warning"
                startContent={<Trash2 size={14} />}
                onPress={handleCleanupDead}>
                清理失效 ({posts.filter((p) => (p.fail_count ?? 0) >= 5).length})
              </Button>
            </Tooltip>
          )}
          <MonitorGroupsButton token={token} />
          <MonitorPaceButton />
          <Button size="sm" color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
            添加小红书帖子
          </Button>
        </div>
      </div>

      {/* Loading / Empty / Tabs */}
      {isLoading ? (
        <Card><CardBody className="p-0"><TableSkeleton rows={6} cols={6} /></CardBody></Card>
      ) : posts.length === 0 && alerts.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={FileText}
              title="还没有监控小红书帖子"
              hint="粘贴小红书笔记链接（xhslink.com / xiaohongshu.com）即可开始监控点赞、收藏、评论变化。"
              action={
                <Button color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
                  添加小红书帖子
                </Button>
              }
            />
          </CardBody>
        </Card>
      ) : (
      <>
        {/* 告警记录（顶部 banner，默认折叠以省空间；点击展开看详情） */}
        {alerts.length > 0 && (
          <Card className="border-warning/40 bg-warning/5">
            <CardHeader
              className="flex justify-between items-center py-2 cursor-pointer select-none"
              onClick={() => setAlertsOpen((v) => !v)}
            >
              <div className="flex items-center gap-2 text-warning-700">
                <span className="text-base">⚠️</span>
                <span className="text-sm font-medium">
                  告警记录（{alerts.length} 条未处理）
                </span>
                <span className="text-xs text-default-500">
                  {alertsOpen ? "点击折叠" : "点击展开"}
                </span>
              </div>
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="flat" color="danger"
                  startContent={<Trash2 size={14} />}
                  onPress={handleClearAlerts}>
                  清空
                </Button>
                <Button size="sm" variant="light" isIconOnly
                  onPress={() => setAlertsOpen((v) => !v)}>
                  {alertsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </Button>
              </div>
            </CardHeader>
            {alertsOpen && (
              <CardBody className="p-0 border-t border-divider">
                <Table aria-label="alerts" removeWrapper>
                  <TableHeader>
                    <TableColumn>类型</TableColumn>
                    <TableColumn>帖子</TableColumn>
                    <TableColumn>消息</TableColumn>
                    <TableColumn>时间</TableColumn>
                    <TableColumn>操作</TableColumn>
                  </TableHeader>
                  <TableBody>
                    {alerts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <Chip size="sm" color={alertTypeColor(a.alert_type)} variant="flat">
                            {alertTypeLabel(a.alert_type)}
                          </Chip>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm truncate max-w-xs block">
                            {a.title || a.note_id}
                          </span>
                        </TableCell>
                        <TableCell><span className="text-sm">{a.message}</span></TableCell>
                        <TableCell>
                          <span className="text-xs text-default-400">{a.created_at?.slice(0, 16)}</span>
                        </TableCell>
                        <TableCell>
                          <Tooltip content="删除" color="danger">
                            <Button isIconOnly size="sm" variant="light" color="danger"
                              onPress={() => handleDeleteAlert(a.id)}>
                              <Trash2 size={15} />
                            </Button>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardBody>
            )}
          </Card>
        )}

        {/* 筛选条 */}
        <Card>
          <CardBody className="py-3 flex flex-row flex-wrap items-end gap-3">
            <div className="min-w-[140px]">
              <p className="text-xs text-default-500 mb-1">分组</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
              >
                <option value="">全部分组</option>
                <option value="_none">未分组</option>
                {(groups as any[]).map((g) => (
                  <option key={g.id} value={String(g.id)}>{g.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[140px]">
              <p className="text-xs text-default-500 mb-1">状态</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">全部状态</option>
                <option value="ok">正常</option>
                <option value="error">抓取异常</option>
                <option value="login_required">需登录</option>
                <option value="deleted">已删除</option>
                <option value="dead">已停抓</option>
                <option value="untested">未检测</option>
              </select>
            </div>
            <Input size="sm" type="number" min={0} className="w-28"
              label="点赞 ≥" labelPlacement="outside-left"
              value={minLikes} onValueChange={setMinLikes} />
            <Input size="sm" type="number" min={0} className="w-28"
              label="收藏 ≥" labelPlacement="outside-left"
              value={minCollects} onValueChange={setMinCollects} />
            <Input size="sm" type="number" min={0} className="w-28"
              label="评论 ≥" labelPlacement="outside-left"
              value={minComments} onValueChange={setMinComments} />
            {(search || groupFilter || statusFilter || minLikes || minCollects || minComments || sortBy) && (
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

        {/* 数据表 */}
        <Card>
          <CardBody className="p-0">
            <Table aria-label="posts-table" removeWrapper>
              <TableHeader>
                <TableColumn className="w-12">
                  <Checkbox
                    isSelected={pagedPosts.length > 0 && pagedPosts.every((p) => selectedKeys.has(postKey(p)))}
                    isIndeterminate={
                      pagedPosts.some((p) => selectedKeys.has(postKey(p))) &&
                      !pagedPosts.every((p) => selectedKeys.has(postKey(p)))
                    }
                    onValueChange={() => togglePageAll(pagedPosts)}
                  />
                </TableColumn>
                <TableColumn>标题 / ID</TableColumn>
                <TableColumn>分组</TableColumn>
                {/* admin 也只看自己的帖子；查别人帖子走 /admin/users/{id}/posts */}
                <TableColumn>状态</TableColumn>
                <TableColumn>
                  <button onClick={() => toggleSort("liked")} className="inline-flex items-center gap-1 hover:text-foreground">
                    点赞 {sortIcon("liked")}
                  </button>
                </TableColumn>
                <TableColumn>
                  <button onClick={() => toggleSort("collected")} className="inline-flex items-center gap-1 hover:text-foreground">
                    收藏 {sortIcon("collected")}
                  </button>
                </TableColumn>
                <TableColumn>
                  <button onClick={() => toggleSort("comment")} className="inline-flex items-center gap-1 hover:text-foreground">
                    评论 {sortIcon("comment")}
                  </button>
                </TableColumn>
                <TableColumn>
                  <button onClick={() => toggleSort("checked")} className="inline-flex items-center gap-1 hover:text-foreground">
                    最后检测 {sortIcon("checked")}
                  </button>
                </TableColumn>
                <TableColumn>操作</TableColumn>
              </TableHeader>
              <TableBody emptyContent={
                <EmptyState
                  icon={Inbox}
                  title={posts.length === 0 ? "还没有监控帖子" : "没有符合筛选条件的帖子"}
                  hint={posts.length === 0 ? "点右上角「添加小红书帖子」开始" : "调整筛选或点「清除筛选」"}
                />
              }>
                {pagedPosts.map((p) => (
                  <TableRow key={postKey(p)}>
                    <TableCell>
                      <Checkbox
                        isSelected={selectedKeys.has(postKey(p))}
                        onValueChange={() => toggleKey(postKey(p))}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <a href={p.note_url} target="_blank" rel="noreferrer"
                          className="text-primary text-sm truncate max-w-xs hover:underline">
                          {p.title || p.note_id}
                        </a>
                        <span className="text-xs text-default-400">{p.note_id}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Chip size="sm" variant="flat"
                        color={p.group_id ? "primary" : "default"}>
                        {groupNameOf(p.group_id ?? null)}
                      </Chip>
                    </TableCell>
                    <TableCell>{fetchStatusChip(p)}</TableCell>
                    <TableCell><span className="font-medium">{p.liked_count ?? "—"}</span></TableCell>
                    <TableCell><span className="font-medium">{p.collected_count ?? "—"}</span></TableCell>
                    <TableCell><span className="font-medium">{p.comment_count ?? "—"}</span></TableCell>
                    <TableCell>
                      <span className="text-xs text-default-400">
                        {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Tooltip content="历史数据">
                          <Button isIconOnly size="sm" variant="light"
                            as={Link} href={`/dashboard/xhs/posts/history?note_id=${p.note_id}`}>
                            <BarChart2 size={15} />
                          </Button>
                        </Tooltip>
                        <MoveGroupButton
                          noteId={p.note_id}
                          currentGroupId={p.group_id ?? null}
                          groups={groups}
                          onMoved={() => mutatePosts()}
                          ownerUserId={p.user_id}
                        />
                        <Tooltip content="删除" color="danger">
                          <Button isIconOnly size="sm" variant="light" color="danger"
                            onPress={() => handleDelete(p.note_id, p.user_id)}>
                            <Trash2 size={15} />
                          </Button>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
          {totalCount > 0 && (
            <CardBody className="border-t border-divider py-2 flex flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-default-500">
                每页
                <select
                  className="border border-divider rounded px-1.5 py-0.5 text-xs bg-background"
                  value={String(pageSize)}
                  onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
                >
                  <option value="30">30</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
                条
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="flat" isIconOnly
                  isDisabled={safePage <= 1}
                  onPress={() => setPage(safePage - 1)}>
                  <ChevronLeft size={14} />
                </Button>
                <span className="text-xs text-default-600 px-2">{safePage} / {pageCount}</span>
                <Button size="sm" variant="flat" isIconOnly
                  isDisabled={safePage >= pageCount}
                  onPress={() => setPage(safePage + 1)}>
                  <ChevronRight size={14} />
                </Button>
              </div>
            </CardBody>
          )}
        </Card>

      </>
      )}

      {/* Add Posts Modal —— 懒加载，仅当用户打开后才加载 chunk */}
      {isOpen && (
        <AddPostsModal
          isOpen={isOpen}
          onClose={onClose}
          groups={groups}
          accounts={accounts}
          links={links}
          setLinks={setLinks}
          selectedGroupId={selectedGroupId}
          setSelectedGroupId={setSelectedGroupId}
          selectedAccount={selectedAccount}
          setSelectedAccount={setSelectedAccount}
          addResults={addResults}
          adding={adding}
          onSubmit={handleAdd}
        />
      )}
    </div>
  );
}
