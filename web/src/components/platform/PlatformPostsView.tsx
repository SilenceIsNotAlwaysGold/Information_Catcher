"use client";

/**
 * 共用「监控帖子」表格组件 — xhs / douyin 共享这套筛选 + 排序 + 分页 + 失效检测。
 *
 * Props:
 *   platform: "xhs" | "douyin"
 *   metricColumns: 数字列定义（xhs = 点赞/收藏/评论，douyin = 点赞/评论/分享）
 *   renderTitleCell: 标题列渲染（用于显示 tags / author 等 platform 特有 metadata）
 *   renderRowActions: 行右侧额外按钮（如抖音下载无水印）
 *   addLabel / emptyTitle / emptyHint: 文案
 *   AddModal: 添加帖子 Modal 组件
 */
import {
  ReactNode, useEffect, useState, type ComponentType,
} from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { Checkbox } from "@nextui-org/checkbox";
import { Tooltip } from "@nextui-org/tooltip";
import { useDisclosure } from "@nextui-org/modal";
import {
  Plus, RefreshCw, Trash2, BarChart2, Search, FileText, Inbox,
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, X as XIcon,
  FolderInput,
} from "lucide-react";
import {
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem,
} from "@nextui-org/dropdown";
import { useAuth } from "@/contexts/AuthContext";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { MonitorGroupsButton } from "@/components/MonitorGroupsButton";
import { MonitorPaceButton } from "@/components/MonitorPaceButton";
import { toastOk, toastErr } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";
import {
  useGroups, usePosts, useMe, mutatePosts,
} from "@/lib/useApi";
import PlatformAlertsCard from "./PlatformAlertsCard";

const API = (p: string) => `/api/monitor${p}`;

export type PostRow = {
  note_id: string;
  title: string;
  note_url: string;
  account_name?: string | null;
  liked_count: number | null;
  collected_count: number | null;
  comment_count: number | null;
  share_count?: number | null;
  checked_at: string | null;
  group_id: number | null;
  group_name?: string | null;
  last_fetch_status?: string;
  last_fetch_at?: string | null;
  fail_count?: number;
  platform?: string;
  user_id?: number | null;
  owner_username?: string;
  tags?: string;
  author?: string;
};

export type MetricColumn = {
  key: keyof PostRow;
  label: string;
  sortKey: "liked" | "collected" | "comment";  // sortBy 使用的内部 key
};

export type PlatformPostsViewProps = {
  platform: "xhs" | "douyin";
  addLabel: string;            // "添加小红书帖子" / "添加抖音视频"
  emptyTitle: string;          // "还没有监控小红书帖子"
  emptyHint: string;
  metricColumns: MetricColumn[];
  AddModal: ComponentType<any>;
  addModalProps?: Record<string, any>;  // 透传给 AddModal 的额外 props（platform-specific）
  renderTitleExtras?: (p: PostRow) => ReactNode;  // 标题下面附加（tags / author）
  renderRowActions?: (p: PostRow) => ReactNode;   // 行右侧额外操作按钮
};

export function PlatformPostsView({
  platform, addLabel, emptyTitle, emptyHint,
  metricColumns, AddModal, addModalProps = {},
  renderTitleExtras, renderRowActions,
}: PlatformPostsViewProps) {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const { posts: rawPosts, isLoading } = usePosts();
  const posts = (rawPosts as PostRow[]).filter((p) => {
    // 排除博主追新的帖子（有 creator_id），它们在「博主追新」板块单独展示
    if ((p as any).creator_id != null) return false;
    if (!p.platform) return platform === "xhs";  // 老数据无 platform 默认 xhs
    return p.platform === platform;
  });
  const { groups } = useGroups(platform);

  // 选中 state（key 用 user_id__note_id 区分多租户）
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const postKey = (p: PostRow) => `${p.user_id || 0}__${p.note_id}`;
  const toggleKey = (k: string) => setSelectedKeys((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const togglePageAll = (rows: PostRow[]) => setSelectedKeys((prev) => {
    const allKeys = rows.map(postKey);
    const allOn = allKeys.length > 0 && allKeys.every((k) => prev.has(k));
    const next = new Set(prev);
    for (const k of allKeys) { if (allOn) next.delete(k); else next.add(k); }
    return next;
  });

  // 添加 modal 状态
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers });
    setTimeout(() => { mutatePosts(); setChecking(false); }, 4000);
  };

  const handleDelete = async (note_id: string, owner_user_id?: number | null) => {
    const ok = await confirmDialog({
      title: "删除监控", content: "确认删除这条监控？",
      confirmText: "删除", cancelText: "取消", danger: true,
    });
    if (!ok) return;
    const qs = owner_user_id ? `?owner_user_id=${owner_user_id}` : "";
    await fetch(API(`/posts/${note_id}${qs}`), { method: "DELETE", headers });
    await mutatePosts();
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.size === 0) return;
    const ok = await confirmDialog({
      title: "批量删除", content: `确认删除选中的 ${selectedKeys.size} 条帖子？`,
      confirmText: "删除", cancelText: "取消", danger: true,
    });
    if (!ok) return;
    const noteIds = Array.from(selectedKeys).map((k) => k.split("__").slice(1).join("__"));
    await fetch(API("/posts/batch-delete"), {
      method: "POST", headers,
      body: JSON.stringify({ note_ids: noteIds }),
    });
    setSelectedKeys(new Set());
    await mutatePosts();
  };

  const handleCleanupDead = async () => {
    const dead = posts.filter((p) => (p.fail_count ?? 0) >= 5);
    if (dead.length === 0) return;
    const ok = await confirmDialog({
      title: "清理失效帖子",
      content: `确认删除 ${dead.length} 条已停抓的帖子？`,
      confirmText: "清理", cancelText: "取消", danger: true,
    });
    if (!ok) return;
    const noteIds = dead.map((p) => p.note_id);
    await fetch(API("/posts/batch-delete"), {
      method: "POST", headers,
      body: JSON.stringify({ note_ids: noteIds }),
    });
    await mutatePosts();
  };

  // 状态 chip
  const fetchStatusChip = (p: PostRow) => {
    const s = p.last_fetch_status;
    const fc = p.fail_count ?? 0;
    if (fc >= 5) {
      return (
        <Tooltip content={`连续 ${fc} 次抓取失败，已停抓。点上方"清理失效"批量删除。`}>
          <Chip size="sm" color="danger" variant="flat">⚠️ 已停抓</Chip>
        </Tooltip>
      );
    }
    if (s === "login_required") {
      return (
        <Tooltip content={`帖子加了登录墙，匿名 ${fc} 次都失败。`}>
          <Chip size="sm" color="warning" variant="flat">🔒 需登录{fc > 0 ? ` (${fc})` : ""}</Chip>
        </Tooltip>
      );
    }
    if (s === "deleted") return <Chip size="sm" color="danger" variant="flat">已删除</Chip>;
    if (s === "error") return <Chip size="sm" color="warning" variant="flat">异常</Chip>;
    if (s === "ok") return <Chip size="sm" color="success" variant="flat">正常</Chip>;
    return <Chip size="sm" variant="flat">未检测</Chip>;
  };

  // 筛选 + 排序 + 分页 状态
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [minLikes, setMinLikes] = useState<string>("");
  const [minCollects, setMinCollects] = useState<string>("");
  const [minComments, setMinComments] = useState<string>("");
  const [sortBy, setSortBy] = useState<"liked" | "collected" | "comment" | "checked" | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

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

  const matchStatus = (p: PostRow, target: string): boolean => {
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

  const kw = search.trim().toLowerCase();
  const filteredPosts = posts.filter((p) => {
    if (kw && !(
      (p.title || "").toLowerCase().includes(kw) ||
      (p.note_id || "").toLowerCase().includes(kw) ||
      (p.account_name || "").toLowerCase().includes(kw) ||
      (p.author || "").toLowerCase().includes(kw)
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

  const totalCount = sortedPosts.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedPosts = sortedPosts.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => { setPage(1); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kw, groupFilter, statusFilter, minLikes, minCollects, minComments, pageSize]);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);

  const groupNameOf = (gid: number | null): string => {
    if (!gid) return "未分组";
    return (groups as any[]).find((g) => g.id === gid)?.name || `#${gid}`;
  };

  const deadCount = posts.filter((p) => (p.fail_count ?? 0) >= 5).length;

  return (
    <>
      {/* 平台专属告警卡片（仅显示该平台的告警） */}
      <PlatformAlertsCard platform={platform} headers={headers} />

      {/* Header 操作行 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">监控帖子（共 {filteredPosts.length} 条）</h2>
        <div className="flex gap-2 flex-wrap">
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
                      const data = await r.json();
                      if (!r.ok) throw new Error(data.detail || "移动失败");
                      const target = gid === null
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
              <Button size="sm" color="danger" variant="flat"
                startContent={<Trash2 size={14} />}
                onPress={handleBatchDelete}>
                删除选中 ({selectedKeys.size})
              </Button>
            </>
          )}
          <Input
            size="sm" variant="bordered"
            startContent={<Search size={14} />}
            placeholder="搜索标题 / ID / 作者"
            value={search} onValueChange={setSearch}
            className="w-64"
          />
          <Button size="sm" variant="flat"
            startContent={<RefreshCw size={16} className={checking ? "animate-spin" : ""} />}
            onPress={handleCheck} isLoading={checking}>
            立即检测
          </Button>
          {deadCount > 0 && (
            <Tooltip content="连续 5 次以上抓取失败的帖子已停止抓取">
              <Button size="sm" variant="flat" color="warning"
                startContent={<Trash2 size={14} />}
                onPress={handleCleanupDead}>
                清理失效 ({deadCount})
              </Button>
            </Tooltip>
          )}
          <MonitorGroupsButton token={token} platform={platform} />
          <MonitorPaceButton />
          <Button size="sm" color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
            {addLabel}
          </Button>
        </div>
      </div>

      {/* Loading / Empty */}
      {isLoading ? (
        <Card><CardBody className="p-0"><TableSkeleton rows={6} cols={6} /></CardBody></Card>
      ) : posts.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={FileText}
              title={emptyTitle}
              hint={emptyHint}
              action={
                <Button color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
                  {addLabel}
                </Button>
              }
            />
          </CardBody>
        </Card>
      ) : (
        <>
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
                  {isAdmin ? <TableColumn>所属用户</TableColumn> : <></>}
                  <TableColumn>状态</TableColumn>
                  {metricColumns.map((mc) => (
                    <TableColumn key={mc.key}>
                      <button onClick={() => toggleSort(mc.sortKey)}
                        className="inline-flex items-center gap-1 hover:text-foreground">
                        {mc.label} {sortIcon(mc.sortKey)}
                      </button>
                    </TableColumn>
                  ))}
                  <TableColumn>
                    <button onClick={() => toggleSort("checked")}
                      className="inline-flex items-center gap-1 hover:text-foreground">
                      最后检测 {sortIcon("checked")}
                    </button>
                  </TableColumn>
                  <TableColumn>操作</TableColumn>
                </TableHeader>
                <TableBody emptyContent={
                  <EmptyState
                    icon={Inbox}
                    title={posts.length === 0 ? emptyTitle : "没有符合筛选条件的帖子"}
                    hint={posts.length === 0 ? emptyHint : "调整筛选或点「清除筛选」"}
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
                        <div className="flex flex-col gap-1">
                          <a href={p.note_url} target="_blank" rel="noreferrer"
                            className="text-primary text-sm truncate max-w-md hover:underline">
                            {p.title || p.note_id}
                          </a>
                          {renderTitleExtras?.(p)}
                          <span className="text-xs text-default-400">{p.note_id}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Chip size="sm" variant="flat"
                          color={p.group_id ? "primary" : "default"}>
                          {groupNameOf(p.group_id ?? null)}
                        </Chip>
                      </TableCell>
                      {isAdmin ? (
                        <TableCell>
                          <Chip size="sm" variant="flat" color="secondary">{p.owner_username ?? "—"}</Chip>
                        </TableCell>
                      ) : <></>}
                      <TableCell>{fetchStatusChip(p)}</TableCell>
                      {metricColumns.map((mc) => (
                        <TableCell key={mc.key}>
                          <span className="font-medium">{(p as any)[mc.key] ?? "—"}</span>
                        </TableCell>
                      ))}
                      <TableCell>
                        <span className="text-xs text-default-400">
                          {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-0.5">
                          <Tooltip content="历史数据">
                            <Button isIconOnly size="sm" variant="light"
                              as={Link} href={`/dashboard/${platform}/posts/history?note_id=${p.note_id}`}>
                              <BarChart2 size={15} />
                            </Button>
                          </Tooltip>
                          {renderRowActions?.(p)}
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

      {/* Modal */}
      {isOpen && (
        <AddModal
          isOpen={isOpen}
          onClose={onClose}
          groups={groups}
          {...addModalProps}
        />
      )}
    </>
  );
}
