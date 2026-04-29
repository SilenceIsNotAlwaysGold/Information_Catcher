"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  Card, CardBody, CardHeader, Button, Input, Switch, Chip, Textarea,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Tabs, Tab, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
  useDisclosure, Spinner, Tooltip,
} from "@nextui-org/react";
import { ShieldCheck, Users, Server, Cpu, RefreshCw, QrCode, Plus, Pencil, KeyRound } from "lucide-react";

const API = (path: string) => `/api${path}`;

type AdminUser = {
  id: number;
  username: string;
  email: string;
  role: "user" | "admin";
  plan: string;
  trial_ends_at: string | null;
  is_active: number;
  created_at: string;
};

type SharedAccount = {
  id: number;
  name: string;
  is_shared: number;
  user_id: number | null;
  proxy_url?: string;
  cookie_status?: string;
  cookie_checked_at?: string | null;
  last_used_at?: string | null;
  usage_count?: number;
  created_at: string;
};

type Settings = Record<string, string>;

export default function AdminPage() {
  const router = useRouter();
  const { user, token, isLoading } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [accounts, setAccounts] = useState<SharedAccount[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 扫码新增共享账号
  const qrModal = useDisclosure();
  const [qrName, setQrName] = useState("");
  const [qrSession, setQrSession] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [qrStatus, setQrStatus] = useState<"idle" | "loading" | "waiting" | "success" | "failed" | "expired">("idle");
  const [qrError, setQrError] = useState("");
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrActiveRef = useRef(false);

  // 手动录入 cookie 新增共享账号
  const cookieModal = useDisclosure();
  const [cookieForm, setCookieForm] = useState({ name: "", cookie: "", proxy_url: "" });
  const [cookieSaving, setCookieSaving] = useState(false);
  const [cookieError, setCookieError] = useState("");

  // 编辑现有账号（cookie / 代理 / 名称）
  const editModal = useDisclosure();
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", cookie: "", proxy_url: "" });
  const [editSaving, setEditSaving] = useState(false);

  // 等用户加载完再判断权限，否则刷新页面会先 push("/dashboard") 再才知道是 admin
  useEffect(() => {
    if (isLoading) return;
    if (!user) return;
    if (user.role !== "admin") {
      router.replace("/dashboard");
    }
  }, [isLoading, user, router]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [u, a, s] = await Promise.all([
        fetch(API("/auth/admin/users"), { headers }).then((r) => r.json()),
        fetch(API("/monitor/accounts"), { headers }).then((r) => r.json()),
        fetch(API("/monitor/settings"), { headers }).then((r) => r.json()),
      ]);
      setUsers(u.users ?? []);
      setAccounts(a.accounts ?? []);
      setSettings(s ?? {});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token && user?.role === "admin") fetchAll();
  }, [token, user]);

  const toggleShared = async (acc: SharedAccount) => {
    await fetch(API(`/monitor/accounts/${acc.id}`), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ is_shared: !acc.is_shared }),
    });
    await fetchAll();
  };

  // 手动录入 cookie 创建共享账号
  const submitCookie = async () => {
    setCookieError("");
    if (!cookieForm.name.trim() || !cookieForm.cookie.trim()) {
      setCookieError("名称和 Cookie 都必须填");
      return;
    }
    if (!/web_session/i.test(cookieForm.cookie)) {
      setCookieError("Cookie 里必须包含 web_session=...，否则无法访问搜索接口");
      return;
    }
    setCookieSaving(true);
    try {
      const r = await fetch(API("/monitor/accounts"), {
        method: "POST", headers,
        body: JSON.stringify({
          name: cookieForm.name.trim(),
          cookie: cookieForm.cookie.trim(),
          proxy_url: cookieForm.proxy_url.trim(),
          is_shared: true,
        }),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          msg = j.detail || msg;
        } catch { /* not json */ }
        throw new Error(msg);
      }
      cookieModal.onClose();
      setCookieForm({ name: "", cookie: "", proxy_url: "" });
      await fetchAll();
    } catch (e: any) {
      setCookieError(e.message || "创建失败");
    } finally {
      setCookieSaving(false);
    }
  };

  // 编辑账号：cookie / 代理 / 名称（留空保留原值）
  const openEdit = (acc: SharedAccount) => {
    setEditId(acc.id);
    setEditForm({ name: acc.name, cookie: "", proxy_url: "" });
    editModal.onOpen();
  };

  const submitEdit = async () => {
    if (editId == null) return;
    setEditSaving(true);
    try {
      const payload: Record<string, any> = {};
      if (editForm.name.trim()) payload.name = editForm.name.trim();
      if (editForm.cookie.trim()) payload.cookie = editForm.cookie.trim();
      // 代理：空字符串等价于「清除代理」，所以即使 trim 后为空也发出去
      payload.proxy_url = editForm.proxy_url.trim();
      const r = await fetch(API(`/monitor/accounts/${editId}`), {
        method: "PATCH", headers, body: JSON.stringify(payload),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = await r.json();
          msg = j.detail || msg;
        } catch { /* not json */ }
        alert(`保存失败：${msg}`);
        return;
      }
      editModal.onClose();
      await fetchAll();
    } finally {
      setEditSaving(false);
    }
  };

  const checkCookie = async (id: number) => {
    await fetch(API(`/monitor/accounts/${id}/check-cookie`), { method: "POST", headers });
    await fetchAll();
  };

  const stopQrPoll = () => {
    if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; }
  };

  const startQrLogin = async () => {
    if (!qrName.trim()) return;
    setQrStatus("loading"); setQrError(""); setQrImage(""); qrActiveRef.current = true;
    qrModal.onOpen();
    try {
      const r = await fetch(API("/monitor/accounts/qr-login/start"), {
        method: "POST", headers,
        body: JSON.stringify({ name: qrName.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setQrSession(data.session_id);
      // 拉一次拿二维码
      const probe = async () => {
        const rr = await fetch(API(`/monitor/accounts/qr-login/${data.session_id}`), { headers });
        const d = await rr.json();
        if (d.qr_image) setQrImage(d.qr_image);
        setQrStatus(d.status || "waiting");
        if (d.error) setQrError(d.error);
        if (["success", "failed", "expired", "cancelled"].includes(d.status)) {
          stopQrPoll();
          if (d.status === "success") {
            // 后端已建账号，标 is_shared=1
            if (d.account_id) {
              await fetch(API(`/monitor/accounts/${d.account_id}`), {
                method: "PATCH", headers,
                body: JSON.stringify({ is_shared: true }),
              });
            }
            await fetchAll();
          }
        }
      };
      await probe();
      qrPollRef.current = setInterval(probe, 2000);
    } catch (e: any) {
      setQrStatus("failed");
      setQrError(e.message || "启动失败");
    }
  };

  const cancelQr = async () => {
    if (qrSession) {
      await fetch(API(`/monitor/accounts/qr-login/${qrSession}/cancel`), {
        method: "POST", headers,
      }).catch(() => {});
    }
    stopQrPoll();
    setQrSession(null); setQrImage(""); setQrStatus("idle"); setQrError("");
    qrActiveRef.current = false;
    qrModal.onClose();
  };

  const setSetting = (k: string, v: string) =>
    setSettings((prev) => ({ ...prev, [k]: v }));

  const saveSettings = async () => {
    setSaving(true);
    try {
      await fetch(API("/monitor/settings"), {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ai_base_url: settings.ai_base_url,
          ai_api_key: settings.ai_api_key,
          ai_model: settings.ai_model,
          ai_rewrite_prompt: settings.ai_rewrite_prompt,
        }),
      });
    } finally {
      setSaving(false);
    }
  };

  // 后端接受 is_active 为 boolean，所以这里用宽松的 Record 类型
  const updateUser = async (uid: number, patch: Record<string, any>) => {
    await fetch(API(`/auth/admin/users/${uid}`), {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    });
    await fetchAll();
  };

  if (isLoading || !user) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spinner color="primary" />
      </div>
    );
  }
  if (user.role !== "admin") return null;

  const sharedCount = accounts.filter((a) => a.is_shared).length;
  const healthyShared = accounts.filter(
    (a) => a.is_shared && a.cookie_status !== "expired"
  ).length;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="text-primary" size={22} />
        <h1 className="text-xl font-semibold">管理员控制台</h1>
        <Chip size="sm" color="warning" variant="flat" className="ml-2">仅管理员可见</Chip>
        <Button
          size="sm" variant="light" startContent={<RefreshCw size={14} />}
          onPress={fetchAll}
          isLoading={loading}
          className="ml-auto"
        >刷新</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={<Users size={18} />} label="用户数" value={users.length} />
        <StatCard
          icon={<Server size={18} />} label="共享账号池"
          value={`${healthyShared}/${sharedCount}`}
          hint="健康/共享总数"
        />
        <StatCard
          icon={<Cpu size={18} />} label="AI 配置"
          value={settings.ai_api_key ? "已配置" : "未配置"}
          hint={settings.ai_model || ""}
        />
      </div>

      <Tabs aria-label="admin sections">
        <Tab key="users" title="用户管理">
          <Card>
            <CardBody className="p-0">
              <Table aria-label="users" removeWrapper>
                <TableHeader>
                  <TableColumn>邮箱 / 用户名</TableColumn>
                  <TableColumn>角色</TableColumn>
                  <TableColumn>套餐</TableColumn>
                  <TableColumn>试用到期</TableColumn>
                  <TableColumn>状态</TableColumn>
                  <TableColumn>操作</TableColumn>
                </TableHeader>
                <TableBody emptyContent={loading ? "加载中..." : "暂无用户"}>
                  {users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{u.email || u.username}</span>
                          <span className="text-xs text-default-400">#{u.id} · {u.username}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Chip size="sm" color={u.role === "admin" ? "warning" : "default"} variant="flat">
                          {u.role}
                        </Chip>
                      </TableCell>
                      <TableCell>
                        <Input
                          size="sm" value={u.plan || ""} className="max-w-[100px]"
                          onValueChange={(v) =>
                            setUsers((arr) => arr.map((x) => (x.id === u.id ? { ...x, plan: v } : x)))
                          }
                          onBlur={() => updateUser(u.id, { plan: u.plan })}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-default-500">
                          {u.trial_ends_at?.slice(0, 10) || "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Switch
                          size="sm"
                          isSelected={!!u.is_active}
                          onValueChange={(v) => updateUser(u.id, { is_active: v })}
                        />
                      </TableCell>
                      <TableCell>
                        {u.role !== "admin" && (
                          <Button
                            size="sm" variant="light"
                            onPress={() => updateUser(u.id, { role: "admin" })}
                          >设为管理员</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardBody>
          </Card>
        </Tab>

        <Tab key="pool" title="平台账号池">
          <Card>
            <CardHeader className="flex justify-between items-center flex-wrap gap-2">
              <span className="text-sm text-default-500">
                共享账号给全平台搜索/抓取任务复用，按 LRU 调度
              </span>
              <div className="flex items-center gap-2">
                <Input
                  size="sm" placeholder="新账号名称" className="w-[180px]"
                  value={qrName} onValueChange={setQrName}
                />
                <Button
                  size="sm" color="primary" startContent={<QrCode size={14} />}
                  onPress={startQrLogin} isDisabled={!qrName.trim()}
                >
                  扫码新增
                </Button>
                <Button
                  size="sm" variant="flat" startContent={<KeyRound size={14} />}
                  onPress={() => {
                    setCookieForm({ name: "", cookie: "", proxy_url: "" });
                    setCookieError("");
                    cookieModal.onOpen();
                  }}
                >
                  手动录入 Cookie
                </Button>
              </div>
            </CardHeader>
            <CardBody className="p-0">
              <Table aria-label="accounts" removeWrapper>
                <TableHeader>
                  <TableColumn>账号</TableColumn>
                  <TableColumn>归属</TableColumn>
                  <TableColumn>Cookie</TableColumn>
                  <TableColumn>代理</TableColumn>
                  <TableColumn>最近使用</TableColumn>
                  <TableColumn>用量</TableColumn>
                  <TableColumn>共享</TableColumn>
                  <TableColumn>操作</TableColumn>
                </TableHeader>
                <TableBody emptyContent={loading ? "加载中..." : "暂无账号"}>
                  {accounts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{a.name}</span>
                          <span className="text-xs text-default-400">#{a.id}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-default-500">
                          {a.user_id ? `user#${a.user_id}` : "全局"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="sm" variant="flat"
                          color={
                            a.cookie_status === "valid" ? "success" :
                            a.cookie_status === "expired" ? "danger" : "default"
                          }
                        >
                          {a.cookie_status || "unknown"}
                        </Chip>
                      </TableCell>
                      <TableCell>
                        {a.proxy_url ? (
                          <Tooltip content={a.proxy_url}>
                            <Chip size="sm" variant="flat" color="primary">已配置</Chip>
                          </Tooltip>
                        ) : (
                          <span className="text-xs text-default-400">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-default-500">
                          {a.last_used_at?.replace("T", " ").slice(0, 16) || "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs">{a.usage_count ?? 0}</span>
                      </TableCell>
                      <TableCell>
                        <Switch size="sm" isSelected={!!a.is_shared} onValueChange={() => toggleShared(a)} />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Tooltip content="检测 Cookie 是否有效">
                            <Button isIconOnly size="sm" variant="light" onPress={() => checkCookie(a.id)}>
                              <RefreshCw size={14} />
                            </Button>
                          </Tooltip>
                          <Tooltip content="编辑（改名/换 cookie/换代理）">
                            <Button isIconOnly size="sm" variant="light" onPress={() => openEdit(a)}>
                              <Pencil size={14} />
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

        <Tab key="ai" title="AI 配置">
          <Card>
            <CardHeader className="text-sm text-default-500">
              这里的 AI 配置对全平台所有用户生效。普通用户在「设置」页看不到这些字段，只能开关「AI 改写」是否启用。
            </CardHeader>
            <CardBody className="space-y-3">
              <Input
                label="Base URL"
                value={settings.ai_base_url || ""}
                onValueChange={(v) => setSetting("ai_base_url", v)}
              />
              <Input
                label="API Key"
                type="password"
                value={settings.ai_api_key || ""}
                onValueChange={(v) => setSetting("ai_api_key", v)}
              />
              <Input
                label="Model"
                value={settings.ai_model || ""}
                onValueChange={(v) => setSetting("ai_model", v)}
                description="例如 gpt-4o-mini / deepseek-chat"
              />
              <Button color="primary" onPress={saveSettings} isLoading={saving} className="self-start">
                保存
              </Button>
            </CardBody>
          </Card>
        </Tab>
      </Tabs>

      {/* 手动录入 Cookie Modal */}
      <Modal isOpen={cookieModal.isOpen} onClose={cookieModal.onClose} size="lg">
        <ModalContent>
          <ModalHeader>手动录入共享账号</ModalHeader>
          <ModalBody className="space-y-3">
            <p className="text-xs text-default-500">
              直接粘贴登录后的 Cookie 字符串和（可选的）代理 URL。账号会自动加入共享池供搜索使用。
            </p>
            <Input
              label="账号名称"
              placeholder="例：搜索-A1"
              value={cookieForm.name}
              onValueChange={(v) => setCookieForm((f) => ({ ...f, name: v }))}
            />
            <Textarea
              label="Cookie"
              placeholder="必须包含 web_session=...; a1=...; webId=..."
              minRows={4}
              value={cookieForm.cookie}
              onValueChange={(v) => setCookieForm((f) => ({ ...f, cookie: v }))}
            />
            <Input
              label="代理 URL（可选）"
              placeholder="http://user:pass@host:port  或  socks5://host:port"
              description="✅ http(s) 代理含鉴权可用；✅ socks5 仅 IP 白名单（无密码）；❌ socks5 + 密码 不被支持"
              value={cookieForm.proxy_url}
              onValueChange={(v) => setCookieForm((f) => ({ ...f, proxy_url: v }))}
            />
            {cookieError && <p className="text-sm text-danger">{cookieError}</p>}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={cookieModal.onClose}>取消</Button>
            <Button color="primary" onPress={submitCookie} isLoading={cookieSaving}>
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 编辑账号 Modal */}
      <Modal isOpen={editModal.isOpen} onClose={editModal.onClose} size="lg">
        <ModalContent>
          <ModalHeader>编辑账号</ModalHeader>
          <ModalBody className="space-y-3">
            <Input
              label="账号名称"
              value={editForm.name}
              onValueChange={(v) => setEditForm((f) => ({ ...f, name: v }))}
            />
            <Textarea
              label="新 Cookie（留空保留原值）"
              placeholder="只在需要更换 cookie 时填"
              minRows={3}
              value={editForm.cookie}
              onValueChange={(v) => setEditForm((f) => ({ ...f, cookie: v }))}
            />
            <Input
              label="代理 URL（清空表示去掉代理）"
              placeholder="http://user:pass@host:port  或  socks5://host:port"
              description="✅ http(s) 代理含鉴权可用；✅ socks5 仅 IP 白名单（无密码）；❌ socks5 + 密码 不被支持"
              value={editForm.proxy_url}
              onValueChange={(v) => setEditForm((f) => ({ ...f, proxy_url: v }))}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={editModal.onClose}>取消</Button>
            <Button color="primary" onPress={submitEdit} isLoading={editSaving}>
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* QR Login Modal — 复用既有 /accounts/qr-login 接口 */}
      <Modal
        isOpen={qrModal.isOpen}
        onClose={cancelQr}
        size="md" hideCloseButton
        isDismissable={false}
        isKeyboardDismissDisabled
      >
        <ModalContent>
          <ModalHeader>扫码新增共享账号</ModalHeader>
          <ModalBody className="text-center space-y-3 py-6">
            {qrStatus === "loading" && (
              <>
                <Spinner color="primary" />
                <p className="text-sm text-default-500">正在打开小红书登录页…</p>
              </>
            )}
            {qrStatus === "waiting" && qrImage && (
              <>
                <img src={qrImage} alt="qr" className="mx-auto w-44 h-44" />
                <p className="text-sm text-default-500">用小红书 App 扫码并确认登录</p>
                <p className="text-xs text-default-400">登录后会自动作为「共享账号」加入平台池</p>
              </>
            )}
            {qrStatus === "success" && (
              <p className="text-success font-medium">✅ 登录成功，已加入共享池</p>
            )}
            {(qrStatus === "failed" || qrStatus === "expired") && (
              <p className="text-danger text-sm">{qrError || "登录失败/超时，请重试"}</p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={cancelQr}>
              {qrStatus === "success" ? "关闭" : "取消"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

function StatCard({ icon, label, value, hint }: {
  icon: React.ReactNode; label: string; value: string | number; hint?: string;
}) {
  return (
    <Card>
      <CardBody className="flex flex-row items-center gap-3 py-4">
        <div className="text-primary">{icon}</div>
        <div className="flex-1">
          <div className="text-xs text-default-400">{label}</div>
          <div className="text-lg font-semibold">{value}</div>
          {hint && <div className="text-xs text-default-400 truncate">{hint}</div>}
        </div>
      </CardBody>
    </Card>
  );
}
