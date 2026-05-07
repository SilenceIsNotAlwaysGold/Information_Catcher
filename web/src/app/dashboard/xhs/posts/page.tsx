"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { useDisclosure } from "@nextui-org/modal";
import { Tabs, Tab } from "@nextui-org/tabs";
import { Tooltip } from "@nextui-org/tooltip";
import { Plus, RefreshCw, Trash2, BarChart2, Settings, Search, FileText, Inbox } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
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
  last_fetch_status?: string;
  last_fetch_at?: string | null;
  fail_count?: number;
  platform?: string; // "xhs" / "douyin" / "mp"，老数据为 "xhs"
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
  const posts = (rawPosts as Post[]).filter(isXhs);
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

  const handleDelete = async (note_id: string) => {
    await fetch(API(`/posts/${note_id}`), { method: "DELETE", headers });
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

  // 搜索过滤：标题 / note_id / 作者
  const kw = search.trim().toLowerCase();
  const filteredPosts = kw
    ? posts.filter((p) =>
        (p.title || "").toLowerCase().includes(kw) ||
        (p.note_id || "").toLowerCase().includes(kw) ||
        (p.account_name || "").toLowerCase().includes(kw))
    : posts;

  return (
    <div className="p-6 space-y-4">
      <PlatformSubNav platform="xhs" current="posts" />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">监控帖子（共 {filteredPosts.length} 条）</h2>
        <div className="flex gap-2">
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
          <Button size="sm" variant="flat" as={Link} href="/dashboard/monitor/settings"
            startContent={<Settings size={16} />}>
            设置
          </Button>
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
      ) : isAdmin ? (
        /* Admin 平铺视图：所有用户帖子 + 所属用户列 */
        <Card>
          <CardBody className="p-0">
            <Table aria-label="all-posts-admin" removeWrapper>
              <TableHeader>
                <TableColumn>标题 / ID</TableColumn>
                <TableColumn>所属用户</TableColumn>
                <TableColumn>状态</TableColumn>
                <TableColumn>点赞</TableColumn>
                <TableColumn>收藏</TableColumn>
                <TableColumn>评论</TableColumn>
                <TableColumn>最后检测</TableColumn>
                <TableColumn>操作</TableColumn>
              </TableHeader>
              <TableBody emptyContent={<EmptyState icon={FileText} title="暂无帖子" hint="还没有任何用户添加帖子。" />}>
                {filteredPosts.map((p) => (
                  <TableRow key={p.note_id}>
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
                      <Chip size="sm" variant="flat" color="secondary">{p.owner_username ?? "—"}</Chip>
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
                      <div className="flex gap-1">
                        <Tooltip content="历史数据">
                          <Button isIconOnly size="sm" variant="light"
                            as={Link} href={`/dashboard/xhs/posts/history?note_id=${p.note_id}`}>
                            <BarChart2 size={15} />
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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      ) : (
      <Tabs>
        {groups.map((g) => {
          const groupPosts = filteredPosts.filter((p) => p.group_id === g.id);
          return (
          <Tab
            key={`g-${g.id}`}
            title={`${g.name} (${groupPosts.length})`}
          >
            <Card>
              <CardBody className="p-0">
                <Table aria-label={`group-${g.id}`} removeWrapper>
                  <TableHeader>
                    <TableColumn>标题 / ID</TableColumn>
                    <TableColumn>状态</TableColumn>
                    <TableColumn>点赞</TableColumn>
                    <TableColumn>收藏</TableColumn>
                    <TableColumn>评论</TableColumn>
                    <TableColumn>账号</TableColumn>
                    <TableColumn>最后检测</TableColumn>
                    <TableColumn>操作</TableColumn>
                  </TableHeader>
                  <TableBody emptyContent={
                    <EmptyState icon={Inbox} title={`「${g.name}」分组下暂无帖子`}
                      hint={search ? "尝试清除搜索条件，或为该分组添加帖子。" : "在添加帖子时选择该分组，即可入组。"} />
                  }>
                    {groupPosts.map((p) => (
                        <TableRow key={p.note_id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <a href={p.note_url} target="_blank" rel="noreferrer"
                                className="text-primary text-sm truncate max-w-xs hover:underline">
                                {p.title || p.note_id}
                              </a>
                              <span className="text-xs text-default-400">{p.note_id}</span>
                            </div>
                          </TableCell>
                          <TableCell>{fetchStatusChip(p)}</TableCell>
                          <TableCell><span className="font-medium">{p.liked_count ?? "—"}</span></TableCell>
                          <TableCell><span className="font-medium">{p.collected_count ?? "—"}</span></TableCell>
                          <TableCell><span className="font-medium">{p.comment_count ?? "—"}</span></TableCell>
                          <TableCell>
                            <Chip size="sm" variant="flat">{p.account_name ?? "未绑定"}</Chip>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-default-400">
                              {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Tooltip content="历史数据">
                                <Button isIconOnly size="sm" variant="light"
                                  as={Link} href={`/dashboard/xhs/posts/history?note_id=${p.note_id}`}>
                                  <BarChart2 size={15} />
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
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardBody>
            </Card>
          </Tab>
          );
        })}

        <Tab key="alerts" title={`告警记录 (${alerts.length})`}>
          <Card>
            <CardHeader className="flex justify-end py-2">
              <Button size="sm" variant="flat" color="danger"
                startContent={<Trash2 size={14} />}
                isDisabled={!alerts.length}
                onPress={handleClearAlerts}>
                清空告警
              </Button>
            </CardHeader>
            <CardBody className="p-0">
              <Table aria-label="alerts" removeWrapper>
                <TableHeader>
                  <TableColumn>类型</TableColumn>
                  <TableColumn>帖子</TableColumn>
                  <TableColumn>消息</TableColumn>
                  <TableColumn>时间</TableColumn>
                  <TableColumn>操作</TableColumn>
                </TableHeader>
                <TableBody emptyContent={
                  <EmptyState icon={Inbox} title="暂无告警记录"
                    hint="数据指标超过阈值时会在这里显示告警。" />
                }>
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
          </Card>
        </Tab>
      </Tabs>
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
