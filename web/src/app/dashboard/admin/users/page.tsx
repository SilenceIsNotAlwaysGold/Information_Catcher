"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import {
  Users as UsersIcon, Search, Plus, RefreshCw, Edit, Lock, LogOut, Trash2,
  AlertCircle, Copy, Check, X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import { toastErr, toastOk } from "@/lib/toast";

const PLANS = ["trial", "free", "pro", "team", "enterprise"];
const ROLES = ["user", "admin"];
const STATUSES = ["active", "disabled", "deleted"];

type Usage = {
  used: number;
  quota: number;
};

type UsageSummary = {
  plan: string;
  monitor_posts: Usage;
  accounts: Usage;
  daily_image_gen: Usage;
  daily_remix_sets: Usage;
};

type AdminUser = {
  id: number;
  username: string;
  email: string | null;
  is_active: number;
  plan: string;
  trial_ends_at: string | null;
  role: string;
  status: string;
  disabled_reason: string;
  max_monitor_posts: number;
  last_login_at: string | null;
  login_count: number;
  quota_override_json: string;
  allowed_text_model_ids?: string;
  allowed_image_model_ids?: string;
  created_at: string;
  usage?: UsageSummary | null;
};

export default function AdminUsersPage() {
  const { token } = useAuth();
  const { data: me } = useMe();

  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [keyword, setKeyword] = useState("");

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/auth/admin/users?include_deleted=${includeDeleted}`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (e: any) {
      toastErr(`加载失败：${e?.message || e}`);
    } finally { setLoading(false); }
  }, [token, headers, includeDeleted]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    if (!keyword.trim()) return users;
    const k = keyword.trim().toLowerCase();
    return users.filter((u) =>
      u.username?.toLowerCase().includes(k)
      || (u.email || "").toLowerCase().includes(k)
      || String(u.id) === k
    );
  }, [users, keyword]);

  // 创建用户 modal
  const createModal = useDisclosure();
  const [createForm, setCreateForm] = useState({
    email: "", password: "", username: "",
    role: "user", plan: "team",
  });
  const handleCreate = async () => {
    if (!createForm.email.includes("@") || createForm.password.length < 6) {
      toastErr("请填写正确的邮箱 + 至少 6 位密码");
      return;
    }
    try {
      const r = await fetch("/api/auth/admin/users", {
        method: "POST", headers,
        body: JSON.stringify({
          email: createForm.email.trim(),
          password: createForm.password,
          username: createForm.username.trim() || undefined,
          role: createForm.role,
          plan: createForm.plan,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toastErr(data?.detail || `HTTP ${r.status}`);
        return;
      }
      toastOk(`已创建用户 #${data.id}`);
      createModal.onClose();
      setCreateForm({ email: "", password: "", username: "", role: "user", plan: "team" });
      await reload();
    } catch (e: any) { toastErr(`创建失败：${e?.message || e}`); }
  };

  // 编辑 drawer
  const editModal = useDisclosure();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState<Partial<AdminUser> & {
    quota_override?: Record<string, number>;
    allowed_text: number[] | null;   // null = 不限制；[] = 全禁；[1,3] = 指定
    allowed_image: number[] | null;
  }>({});

  // AI 模型列表（admin 看全部，构建白名单 chip 选择器）
  type AiModelLite = { id: number; display_name: string; usage_type: "text" | "image"; provider_name?: string };
  const [aiModels, setAiModels] = useState<AiModelLite[]>([]);
  useEffect(() => {
    // 后端返回 {models: [...]}，需要解包
    Promise.all([
      fetch("/api/admin/ai/models?usage_type=text", { headers }).then((r) => r.ok ? r.json() : { models: [] }),
      fetch("/api/admin/ai/models?usage_type=image", { headers }).then((r) => r.ok ? r.json() : { models: [] }),
    ]).then(([t, i]) => {
      const tm = Array.isArray(t?.models) ? t.models : [];
      const im = Array.isArray(i?.models) ? i.models : [];
      setAiModels([...tm, ...im]);
    }).catch(() => {});
  }, [headers]);
  const openEdit = (u: AdminUser) => {
    setEditing(u);
    let override: Record<string, number> = {};
    try {
      override = u.quota_override_json ? JSON.parse(u.quota_override_json) : {};
    } catch {}
    // 解析白名单：空字符串 = null（不限制）；'[...]' = 数组
    const parseAllowed = (raw?: string): number[] | null => {
      if (!raw) return null;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.map((x) => Number(x)).filter((x) => !isNaN(x)) : null;
      } catch { return null; }
    };
    setEditForm({
      plan: u.plan,
      role: u.role,
      status: u.status,
      disabled_reason: u.disabled_reason,
      trial_ends_at: u.trial_ends_at || "",
      max_monitor_posts: u.max_monitor_posts,
      email: u.email || "",
      quota_override: override,
      allowed_text: parseAllowed(u.allowed_text_model_ids),
      allowed_image: parseAllowed(u.allowed_image_model_ids),
    });
    editModal.onOpen();
  };
  const handleSaveEdit = async () => {
    if (!editing) return;
    const payload: any = {};
    for (const k of ["plan", "role", "status", "disabled_reason", "trial_ends_at",
                     "max_monitor_posts", "email"]) {
      const v = (editForm as any)[k];
      if (v !== undefined && v !== null && v !== "") payload[k] = v;
    }
    if (editForm.quota_override !== undefined) {
      payload.quota_override = editForm.quota_override;
    }
    // 白名单：null 表示"不限制"，前端用 [] 不会改、要保存就传 null/[]/[1,3]
    if (editForm.allowed_text !== undefined) {
      payload.allowed_text_model_ids = editForm.allowed_text === null ? [] : editForm.allowed_text;
    }
    if (editForm.allowed_image !== undefined) {
      payload.allowed_image_model_ids = editForm.allowed_image === null ? [] : editForm.allowed_image;
    }
    try {
      const r = await fetch(`/api/auth/admin/users/${editing.id}`, {
        method: "PATCH", headers, body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(data?.detail || `HTTP ${r.status}`); return; }
      toastOk("已保存");
      editModal.onClose();
      await reload();
    } catch (e: any) { toastErr(`保存失败：${e?.message || e}`); }
  };

  // 重置密码
  const resetPasswordModal = useDisclosure();
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetResult, setResetResult] = useState<string | null>(null);
  const openReset = (u: AdminUser) => {
    setResetTarget(u);
    setNewPassword("");
    setResetResult(null);
    resetPasswordModal.onOpen();
  };
  const handleReset = async () => {
    if (!resetTarget) return;
    try {
      const r = await fetch(`/api/auth/admin/users/${resetTarget.id}/reset-password`, {
        method: "POST", headers,
        body: JSON.stringify({ new_password: newPassword.trim() || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(data?.detail || `HTTP ${r.status}`); return; }
      setResetResult(data.new_password);
      toastOk("已重置 + 强制下线");
    } catch (e: any) { toastErr(`重置失败：${e?.message || e}`); }
  };

  const handleRevokeTokens = async (u: AdminUser) => {
    if (!confirm(`确认强制下线 ${u.username}？该用户当前所有 token 立即失效。`)) return;
    try {
      const r = await fetch(`/api/auth/admin/users/${u.id}/revoke-tokens`, {
        method: "POST", headers,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(data?.detail || `HTTP ${r.status}`); return; }
      toastOk(`已强制下线 ${u.username}`);
    } catch (e: any) { toastErr(`操作失败：${e?.message || e}`); }
  };

  const handleDelete = async (u: AdminUser) => {
    if (!confirm(`确认软删除用户 ${u.username}？\n该用户：\n• 立即被强制下线\n• 之后无法登录\n• 历史数据保留\n（如需彻底清除请直接操作数据库）`)) return;
    try {
      const r = await fetch(`/api/auth/admin/users/${u.id}`, {
        method: "DELETE", headers,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(data?.detail || `HTTP ${r.status}`); return; }
      toastOk("已删除");
      await reload();
    } catch (e: any) { toastErr(`删除失败：${e?.message || e}`); }
  };

  const planChipColor = (plan: string): "default" | "warning" | "primary" | "secondary" | "success" => {
    if (plan === "trial") return "warning";
    if (plan === "pro") return "primary";
    if (plan === "team") return "secondary";
    if (plan === "enterprise") return "success";
    return "default";
  };

  const statusChip = (s: string) => {
    if (s === "active") return <Chip size="sm" variant="flat" color="success">正常</Chip>;
    if (s === "disabled") return <Chip size="sm" variant="flat" color="warning">已禁用</Chip>;
    if (s === "deleted") return <Chip size="sm" variant="flat" color="danger">已删除</Chip>;
    return <Chip size="sm" variant="flat">{s}</Chip>;
  };

  const usageBar = (u?: Usage | null) => {
    if (!u) return <span className="text-default-400">-</span>;
    if (u.quota < 0) return <span className="text-success">∞</span>;
    const pct = u.quota > 0 ? Math.min(100, Math.round(u.used * 100 / u.quota)) : 0;
    const color = pct >= 90 ? "text-danger" : pct >= 70 ? "text-warning" : "text-default-600";
    return <span className={color}>{u.used}/{u.quota}</span>;
  };

  return (
    <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 text-primary p-3">
          <UsersIcon size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">用户管理</h1>
          <p className="text-sm text-default-500 mt-1">
            查看 / 编辑 / 禁用 / 删除用户；调整套餐和配额；强制下线和重置密码。
          </p>
        </div>
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Input
              placeholder="搜索用户名 / 邮箱 / ID"
              value={keyword}
              onValueChange={setKeyword}
              startContent={<Search size={14} className="text-default-400" />}
              className="w-72"
              size="sm"
            />
            <label className="flex items-center gap-1 text-sm text-default-600">
              <input
                type="checkbox"
                checked={includeDeleted}
                onChange={(e) => setIncludeDeleted(e.target.checked)}
              />
              包含已删除
            </label>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />}
                onPress={reload} isLoading={loading}>
                刷新
              </Button>
              <Button size="sm" color="primary" startContent={<Plus size={14} />}
                onPress={createModal.onOpen}>
                创建用户
              </Button>
            </div>
          </div>

          {loading && users.length === 0 ? (
            <div className="py-12 flex justify-center"><Spinner /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-default-500 border-b border-divider">
                    <th className="py-2 pr-2">ID</th>
                    <th className="py-2 pr-2">用户</th>
                    <th className="py-2 pr-2">角色</th>
                    <th className="py-2 pr-2">套餐 / 状态</th>
                    <th className="py-2 pr-2">监控帖子</th>
                    <th className="py-2 pr-2">账号</th>
                    <th className="py-2 pr-2">今日生图</th>
                    <th className="py-2 pr-2">今日仿写</th>
                    <th className="py-2 pr-2">最近登录</th>
                    <th className="py-2 pr-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => (
                    <tr key={u.id} className="border-b border-divider/50 hover:bg-default-50">
                      <td className="py-2 pr-2 text-default-500">#{u.id}</td>
                      <td className="py-2 pr-2">
                        <div className="font-medium">{u.username}</div>
                        <div className="text-xs text-default-500 truncate max-w-[180px]">{u.email || "-"}</div>
                      </td>
                      <td className="py-2 pr-2">
                        {u.role === "admin"
                          ? <Chip size="sm" color="danger" variant="flat">admin</Chip>
                          : <Chip size="sm" variant="flat">user</Chip>}
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Chip size="sm" color={planChipColor(u.plan)} variant="flat">{u.plan}</Chip>
                          {statusChip(u.status)}
                        </div>
                      </td>
                      <td className="py-2 pr-2">{usageBar(u.usage?.monitor_posts)}</td>
                      <td className="py-2 pr-2">{usageBar(u.usage?.accounts)}</td>
                      <td className="py-2 pr-2">{usageBar(u.usage?.daily_image_gen)}</td>
                      <td className="py-2 pr-2">{usageBar(u.usage?.daily_remix_sets)}</td>
                      <td className="py-2 pr-2 text-xs text-default-500">
                        {u.last_login_at || "-"}
                        <div className="text-default-400">{u.login_count} 次</div>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex gap-1 flex-wrap">
                          <Button size="sm" variant="flat" startContent={<Edit size={13} />}
                            onPress={() => openEdit(u)}>
                            编辑
                          </Button>
                          <Button size="sm" variant="flat" color="warning"
                            startContent={<Lock size={13} />}
                            onPress={() => openReset(u)}>
                            修改密码
                          </Button>
                          <Button size="sm" variant="light" isIconOnly title="强制下线"
                            onPress={() => handleRevokeTokens(u)}
                            isDisabled={u.id === me?.id}>
                            <LogOut size={14} />
                          </Button>
                          <Button size="sm" variant="light" isIconOnly title="软删除"
                            color="danger"
                            onPress={() => handleDelete(u)}
                            isDisabled={u.id === me?.id || u.status === "deleted"}>
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && !loading && (
                    <tr>
                      <td colSpan={10} className="py-12 text-center text-default-400">
                        没有符合条件的用户
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 创建用户 modal */}
      <Modal isOpen={createModal.isOpen} onClose={createModal.onClose}>
        <ModalContent>
          <ModalHeader>创建用户</ModalHeader>
          <ModalBody className="space-y-3">
            <Input label="邮箱" value={createForm.email} isRequired
              onValueChange={(v) => setCreateForm({ ...createForm, email: v })} />
            <Input label="用户名（可选，不填用邮箱前缀）" value={createForm.username}
              onValueChange={(v) => setCreateForm({ ...createForm, username: v })} />
            <Input label="密码" type="password" value={createForm.password} isRequired
              description="至少 6 位"
              onValueChange={(v) => setCreateForm({ ...createForm, password: v })} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-default-700">角色</label>
                <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                  value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-default-700">套餐</label>
                <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                  value={createForm.plan} onChange={(e) => setCreateForm({ ...createForm, plan: e.target.value })}>
                  {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={createModal.onClose}>取消</Button>
            <Button color="primary" onPress={handleCreate}>创建</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 编辑用户 modal */}
      <Modal isOpen={editModal.isOpen} onClose={editModal.onClose} size="2xl">
        <ModalContent>
          {editing && (
            <>
              <ModalHeader>编辑用户：{editing.username}</ModalHeader>
              <ModalBody className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Input label="邮箱" value={editForm.email || ""}
                    onValueChange={(v) => setEditForm({ ...editForm, email: v })} />
                  <div>
                    <label className="text-sm text-default-700">角色</label>
                    <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                      value={editForm.role || "user"}
                      onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-default-700">套餐</label>
                    <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                      value={editForm.plan || "free"}
                      onChange={(e) => setEditForm({ ...editForm, plan: e.target.value })}>
                      {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-default-700">状态</label>
                    <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                      value={editForm.status || "active"}
                      onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
                {editForm.status === "disabled" && (
                  <Input label="禁用原因（可选）"
                    value={editForm.disabled_reason || ""}
                    onValueChange={(v) => setEditForm({ ...editForm, disabled_reason: v })} />
                )}
                <Input label="试用截止时间（ISO 格式，留空表示无）"
                  value={editForm.trial_ends_at || ""}
                  onValueChange={(v) => setEditForm({ ...editForm, trial_ends_at: v })}
                  description="例：2026-12-31T23:59:59" />

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">配额覆盖</p>
                    <p className="text-xs text-default-400">
                      留空 = 走套餐默认；-1 = 无限制；其它正整数 = 强制覆盖
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      ["monitor_posts",   "监控帖子",     "帖"],
                      ["accounts",        "已绑平台账号", "个"],
                      ["total_image_gen", "累计生图（不重置）", "张"],
                      ["daily_text_gen",  "每日写文",     "篇"],
                    ].map(([k, label, suffix]) => (
                      <Input key={k}
                        label={label}
                        type="number"
                        placeholder="留空 / -1 / 数字"
                        endContent={<span className="text-default-400 text-xs">{suffix}</span>}
                        value={String(editForm.quota_override?.[k] ?? "")}
                        onValueChange={(v) => {
                          const next = { ...(editForm.quota_override || {}) };
                          if (v.trim() === "") delete next[k];
                          else next[k] = parseInt(v, 10);
                          setEditForm({ ...editForm, quota_override: next });
                        }}
                      />
                    ))}
                  </div>
                  {Object.keys(editForm.quota_override || {}).length > 0 && (
                    <button type="button"
                      className="text-xs text-danger hover:underline"
                      onClick={() => setEditForm({ ...editForm, quota_override: {} })}>
                      清空所有覆盖（恢复套餐默认）
                    </button>
                  )}
                </div>

                {/* AI 模型权限白名单 */}
                {(["text", "image"] as const).map((utype) => {
                  const models = aiModels.filter((m) => m.usage_type === utype);
                  const key = utype === "text" ? "allowed_text" : "allowed_image";
                  const current = (editForm as any)[key] as number[] | null;
                  const isUnlimited = current === null;
                  const allowedSet = new Set(current || []);
                  return (
                    <div key={utype} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">
                          {utype === "text" ? "文本模型" : "图像模型"} 白名单
                          <span className="text-xs text-default-400 ml-2">
                            {isUnlimited ? "未限制（可用所有上架模型）" : `已选 ${allowedSet.size} 个`}
                          </span>
                        </p>
                        {!isUnlimited && (
                          <button type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => setEditForm({ ...editForm, [key]: null } as any)}>
                            清除限制
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {models.length === 0 && (
                          <span className="text-xs text-default-400">还没配置 {utype} 模型</span>
                        )}
                        {models.map((m) => {
                          const on = allowedSet.has(m.id);
                          return (
                            <button key={m.id} type="button"
                              onClick={() => {
                                const next = new Set(current || []);
                                if (on) next.delete(m.id); else next.add(m.id);
                                setEditForm({ ...editForm, [key]: Array.from(next) } as any);
                              }}
                              className={`px-2 py-1 text-xs rounded border ${
                                on
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-divider text-default-500 hover:border-primary/50"
                              }`}
                              title={m.provider_name}
                            >
                              {on && "✓ "}{m.display_name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={editModal.onClose}>取消</Button>
                <Button color="primary" onPress={handleSaveEdit}>保存</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* 重置密码 modal */}
      <Modal isOpen={resetPasswordModal.isOpen} onClose={resetPasswordModal.onClose}>
        <ModalContent>
          {resetTarget && (
            <>
              <ModalHeader>修改密码：{resetTarget.username}</ModalHeader>
              <ModalBody className="space-y-3">
                {resetResult ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-success">
                      <Check size={16} /> 重置成功，新密码：
                    </div>
                    <div className="font-mono text-lg p-3 rounded-md bg-default-100 break-all">
                      {resetResult}
                    </div>
                    <Button size="sm" variant="flat" startContent={<Copy size={14} />}
                      onPress={() => {
                        navigator.clipboard.writeText(resetResult);
                        toastOk("已复制");
                      }}>
                      复制
                    </Button>
                    <p className="text-xs text-warning-600 flex items-center gap-1">
                      <AlertCircle size={13} /> 此密码只显示一次，关闭后无法找回
                    </p>
                  </div>
                ) : (
                  <>
                    <Input
                      label="新密码（留空则系统生成 12 位随机密码）"
                      type="password"
                      value={newPassword}
                      onValueChange={setNewPassword}
                      description="至少 6 位"
                    />
                    <p className="text-xs text-warning-600">
                      重置后该用户所有现有登录态立即失效，需要用新密码重新登录。
                    </p>
                  </>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={() => {
                  setResetResult(null); resetPasswordModal.onClose();
                }}>关闭</Button>
                {!resetResult && (
                  <Button color="warning" onPress={handleReset}>确认重置</Button>
                )}
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
