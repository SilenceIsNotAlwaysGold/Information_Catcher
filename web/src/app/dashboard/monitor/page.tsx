"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Card, CardBody, CardHeader,
  Button, Textarea, Select, SelectItem,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Chip, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  useDisclosure, Tabs, Tab, Tooltip,
} from "@nextui-org/react";
import { Plus, RefreshCw, Trash2, BarChart2, Settings } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

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
};

type Alert = {
  id: number;
  note_id: string;
  title: string;
  alert_type: string;
  message: string;
  created_at: string;
};

type Account = { id: number; name: string };
type Group = { id: number; name: string; is_builtin: number };

export default function MonitorPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<Post[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [links, setLinks] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [addResults, setAddResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);

  const { isOpen, onOpen, onClose } = useDisclosure();

  const load = useCallback(async () => {
    const [p, a, ac, gr] = await Promise.all([
      fetch(API("/posts"), { headers }).then((r) => r.json()),
      fetch(API("/alerts?limit=30"), { headers }).then((r) => r.json()),
      fetch(API("/accounts"), { headers }).then((r) => r.json()),
      fetch(API("/groups"), { headers }).then((r) => r.json()),
    ]);
    setPosts(p.posts ?? []);
    setAlerts(a.alerts ?? []);
    setGroups(gr.groups ?? []);
    setAccounts(ac.accounts ?? []);
  }, [token]);

  useEffect(() => { load(); }, [load]);

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
      await load();
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (note_id: string) => {
    await fetch(API(`/posts/${note_id}`), { method: "DELETE", headers });
    await load();
  };

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers });
    setTimeout(async () => { await load(); setChecking(false); }, 3000);
  };

  const handleDeleteAlert = async (id: number) => {
    await fetch(API(`/alerts/${id}`), { method: "DELETE", headers });
    await load();
  };

  const handleClearAlerts = async () => {
    if (!alerts.length) return;
    if (!confirm(`确认清空全部 ${alerts.length} 条告警记录？`)) return;
    await fetch(API("/alerts"), { method: "DELETE", headers });
    await load();
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
      alert("没有连续失败超过 5 次的帖子");
      return;
    }
    if (!confirm(`将停抓 ${dead.length} 条已失效的帖子（不可撤销，但帖子不会真删除，可以重新添加）？`)) return;
    const r = await fetch(API("/posts/cleanup-dead"), { method: "POST", headers });
    const d = await r.json();
    alert(`已清理 ${d.cleaned} 条失效帖子`);
    await load();
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">帖子监控</h1>
        <div className="flex gap-2">
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
            添加帖子
          </Button>
        </div>
      </div>

      {/* Tabs — 一个分组一个 Tab */}
      <Tabs>
        {groups.map((g) => {
          const groupPosts = posts.filter((p) => p.group_id === g.id);
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
                  <TableBody emptyContent={`「${g.name}」分组下暂无帖子`}>
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
                                  as={Link} href={`/dashboard/monitor/history?note_id=${p.note_id}`}>
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
                <TableBody emptyContent="暂无告警记录">
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

      {/* Add Posts Modal */}
      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalContent>
          <ModalHeader>添加监控帖子</ModalHeader>
          <ModalBody className="space-y-4">
            <Select
              label="分组"
              placeholder="选择分组"
              selectedKeys={selectedGroupId ? new Set([selectedGroupId]) : new Set()}
              onSelectionChange={(keys) => setSelectedGroupId(Array.from(keys)[0] as string ?? "")}
            >
              {groups.map((g) => (
                <SelectItem key={String(g.id)}>{g.name}</SelectItem>
              ))}
            </Select>
            <Textarea
              label="帖子链接"
              placeholder={"每行粘贴一个链接，自动识别平台：\n- 小红书：xhslink.com/... 或 explore/{id}\n- 抖音、公众号开发中"}
              value={links}
              onValueChange={setLinks}
              minRows={5}
            />
            {accounts.length > 0 && (
              <Select
                label="绑定账号（可选）"
                placeholder="不选则不使用 Cookie 抓取"
                selectedKeys={selectedAccount ? new Set([selectedAccount]) : new Set()}
                onSelectionChange={(keys) => setSelectedAccount(Array.from(keys)[0] as string ?? "")}
              >
                {accounts.map((a) => (
                  <SelectItem key={String(a.id)}>{a.name}</SelectItem>
                ))}
              </Select>
            )}

            {addResults.length > 0 && (
              <div className="space-y-1">
                {addResults.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Chip size="sm" color={r.ok ? "success" : "danger"} variant="flat">
                      {r.ok ? "成功" : "失败"}
                    </Chip>
                    <span className="truncate text-default-500">{r.link}</span>
                    {r.reason && <span className="text-danger text-xs">{r.reason}</span>}
                  </div>
                ))}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={onClose}>取消</Button>
            <Button color="primary" isLoading={adding} onPress={handleAdd}>
              解析并添加
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

