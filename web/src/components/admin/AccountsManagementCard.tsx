"use client";

/**
 * 账号管理独立组件（admin only）
 *
 * 完整功能：
 *   - 列表（按平台分组：xhs / douyin / mp）
 *   - QR 扫码登录（仅 xhs）
 *   - 添加 + 编辑（手填 cookie / 代理）
 *   - 单独 / 批量检查 cookie 健康度
 *   - 删除
 *
 * 此前散落在 settings 页 system tab 里，2026-05 重构时整体抽出来作为独立 admin 子页。
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Divider } from "@nextui-org/divider";
import { Tooltip } from "@nextui-org/tooltip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Trash2, Pencil, QrCode, RefreshCw, ShieldCheck, Server } from "lucide-react";
import { toastOk, toastErr } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";

const API = (path: string) => `/api/monitor${path}`;

type PlatformKey = "xhs" | "douyin" | "mp";

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  xhs: "小红书",
  douyin: "抖音",
  mp: "公众号",
};

type Account = {
  id: number;
  name: string;
  created_at: string;
  proxy_url: string;
  platform?: string;
  cookie_status?: string;
  cookie_checked_at?: string | null;
  cookie_last_check?: string | null;
};

const emptyAccountForm = { name: "", proxy_url: "", platform: "xhs" as PlatformKey };
const emptyEditForm = { name: "", cookie: "", proxy_url: "" };

export function AccountsManagementCard({ token }: { token: string | null }) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [accountForm, setAccountForm] = useState(emptyAccountForm);

  const editModal = useDisclosure();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [savingEdit, setSavingEdit] = useState(false);
  const setEdit = (k: keyof typeof emptyEditForm, v: string) =>
    setEditForm((f) => ({ ...f, [k]: v }));

  const qrModal = useDisclosure();
  const [qrSessionId, setQrSessionId] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState<string>("");
  const [qrStatus, setQrStatus] = useState<string>("idle");
  const [qrError, setQrError] = useState<string>("");
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrActiveRef = useRef(false);

  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/accounts"), { headers });
      const d = await r.json();
      setAccounts(d.accounts ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  // ── QR 登录 ─────────────────────────────────────────────────────────────
  const stopQrPoll = () => {
    if (qrPollRef.current) {
      clearInterval(qrPollRef.current);
      qrPollRef.current = null;
    }
  };

  const startQrLogin = async () => {
    stopQrPoll();
    qrActiveRef.current = true;
    setQrSessionId(null);
    setQrError("");
    setQrStatus("loading");
    setQrImage("");
    qrModal.onOpen();
    try {
      const resp = await fetch(API("/accounts/qr-login/start"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: accountForm.name,
          proxy_url: accountForm.proxy_url,
          platform: accountForm.platform || "xhs",
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail || "启动失败");
      }
      const data = await resp.json();
      if (!qrActiveRef.current) {
        fetch(API(`/accounts/qr-login/${data.session_id}/cancel`), {
          method: "POST", headers,
        }).catch(() => {});
        return;
      }
      setQrSessionId(data.session_id);
      setQrImage(data.qr_image);
      setQrStatus("waiting");

      let errCount = 0;
      qrPollRef.current = setInterval(async () => {
        const r = await fetch(API(`/accounts/qr-login/${data.session_id}`), { headers });
        if (!r.ok) {
          if (++errCount >= 3) { stopQrPoll(); setQrStatus("failed"); setQrError("连接断开，请重试"); }
          return;
        }
        errCount = 0;
        const info = await r.json();
        setQrStatus(info.status);
        if (info.status !== "waiting") {
          stopQrPoll();
          if (info.status === "success") {
            await load();
            setTimeout(() => {
              qrModal.onClose();
              setAccountForm(emptyAccountForm);
            }, 1200);
          } else if (info.error) {
            setQrError(info.error);
          }
        }
      }, 2000);
    } catch (e: any) {
      if (qrActiveRef.current) {
        setQrStatus("failed");
        setQrError(e?.message || String(e));
      }
    }
  };

  const closeQrModal = async () => {
    qrActiveRef.current = false;
    stopQrPoll();
    if (qrSessionId && qrStatus === "waiting") {
      await fetch(API(`/accounts/qr-login/${qrSessionId}/cancel`), {
        method: "POST", headers,
      }).catch(() => {});
    }
    setQrSessionId(null); setQrImage(""); setQrStatus("idle"); setQrError("");
    qrModal.onClose();
  };

  useEffect(() => () => { qrActiveRef.current = false; stopQrPoll(); }, []);

  // ── 编辑 / 删除 / 检查 ─────────────────────────────────────────────────
  const openEdit = (a: Account) => {
    setEditingId(a.id);
    setEditForm({
      name: a.name || "",
      cookie: "",
      proxy_url: a.proxy_url || "",
    });
    editModal.onOpen();
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    setSavingEdit(true);
    try {
      const { cookie, ...rest } = editForm;
      const body: Record<string, string> = { ...rest };
      if (cookie.trim()) body.cookie = cookie;
      const r = await fetch(API(`/accounts/${editingId}`), {
        method: "PATCH", headers,
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || "保存失败");
        return;
      }
      toastOk("已保存");
      editModal.onClose();
      await load();
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteAccount = async (id: number) => {
    if (!confirm("确认删除该账号？")) return;
    await fetch(API(`/accounts/${id}`), { method: "DELETE", headers });
    await load();
  };

  const checkOne = async (id: number) => {
    setCheckingId(id);
    try {
      await fetch(API(`/accounts/${id}/check-cookie`), { method: "POST", headers });
      await load();
    } finally { setCheckingId(null); }
  };

  const checkAll = async () => {
    setCheckingAll(true);
    await fetch(API("/accounts/check-cookies"), { method: "POST", headers });
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      await load();
    }
    setCheckingAll(false);
  };

  // ── helpers ─────────────────────────────────────────────────────────────
  const cookieStatusChip = (a: Account) => {
    const s = a.cookie_status || "unknown";
    const last = a.cookie_last_check || a.cookie_checked_at || "";
    const lastShort = last ? last.slice(5, 16).replace("T", " ") : "";
    const chip =
      s === "valid"   ? <Chip size="sm" color="success" variant="flat">正常</Chip>
      : s === "expired" ? <Chip size="sm" color="danger" variant="flat">已失效</Chip>
      : <Chip size="sm" color="default" variant="flat">未检测</Chip>;
    return (
      <div className="flex items-center gap-1.5">
        {chip}
        {lastShort && <span className="text-[10px] text-default-400">{lastShort}</span>}
      </div>
    );
  };

  const accountActions = (a: Account) => (
    <div className="flex gap-1">
      <Tooltip content="检查 Cookie">
        <Button isIconOnly size="sm" variant="light"
          isLoading={checkingId === a.id}
          onPress={() => checkOne(a.id)}>
          <RefreshCw size={15} />
        </Button>
      </Tooltip>
      <Button isIconOnly size="sm" variant="light" onPress={() => openEdit(a)}>
        <Pencil size={15} />
      </Button>
      <Button isIconOnly size="sm" variant="light" color="danger"
        onPress={() => deleteAccount(a.id)}>
        <Trash2 size={15} />
      </Button>
    </div>
  );

  const renderTable = (rows: Account[]) =>
    rows.length === 0 ? (
      <EmptyState
        icon={Server}
        title="暂无账号"
        hint="填写下方账号名称后点「扫码登录」（仅小红书），其他平台手动填写 Cookie 后通过编辑功能保存。"
      />
    ) : (
      <Table aria-label="accounts" removeWrapper>
        <TableHeader>
          <TableColumn>账号</TableColumn>
          <TableColumn>平台</TableColumn>
          <TableColumn>状态</TableColumn>
          <TableColumn>代理</TableColumn>
          <TableColumn>操作</TableColumn>
        </TableHeader>
        <TableBody>
          {rows.map((a) => (
            <TableRow key={a.id}>
              <TableCell><Chip size="sm" variant="flat">{a.name}</Chip></TableCell>
              <TableCell>
                <Chip size="sm" variant="flat" color="secondary">
                  {PLATFORM_LABELS[(a.platform || "xhs") as PlatformKey] || a.platform || "xhs"}
                </Chip>
              </TableCell>
              <TableCell>{cookieStatusChip(a)}</TableCell>
              <TableCell>
                {a.proxy_url
                  ? <Chip size="sm" color="warning" variant="flat">代理</Chip>
                  : <span className="text-xs text-default-400">—</span>}
              </TableCell>
              <TableCell>{accountActions(a)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );

  return (
    <>
      <Card>
        <CardHeader className="font-semibold flex items-center justify-between">
          <span>账号管理</span>
          <Button size="sm" variant="flat"
            startContent={<ShieldCheck size={14} />}
            isLoading={checkingAll}
            isDisabled={accounts.length === 0}
            onPress={checkAll}>
            检查全部 Cookie
          </Button>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-default-500">
            每个账号可独立配置代理或共享池。Cookie 必须包含
            <code className="bg-default-100 px-1 rounded mx-1">web_session</code>
            （扫码登录会自动写入）。
          </p>
          {loading ? <TableSkeleton rows={3} cols={5} /> : renderTable(accounts)}

          <Divider />

          <div className="space-y-3">
            <p className="text-sm text-default-500">
              填写账号名称选好平台后：小红书可点「扫码登录」自动获取 cookie；其他平台需要先手动添加再用「编辑」录入 cookie。
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="账号名称"
                placeholder="例：账号A"
                value={accountForm.name}
                onValueChange={(v) => setAccountForm((f) => ({ ...f, name: v }))}
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-default-700">平台</span>
                <div className="flex gap-2">
                  {(["xhs", "douyin", "mp"] as PlatformKey[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAccountForm((f) => ({ ...f, platform: p }))}
                      className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                        accountForm.platform === p
                          ? "bg-primary text-white border-primary"
                          : "border-divider text-default-600 hover:bg-default-100"
                      }`}
                    >
                      {PLATFORM_LABELS[p]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <Input
              label="代理 URL（可选，仅监控时生效）"
              placeholder="http://user:pass@host:port 或 socks5://host:port"
              value={accountForm.proxy_url}
              onValueChange={(v) => setAccountForm((f) => ({ ...f, proxy_url: v }))}
            />
            <Button
              color="primary"
              startContent={<QrCode size={15} />}
              isDisabled={!accountForm.name.trim() || accountForm.platform !== "xhs"}
              onPress={startQrLogin}
            >
              扫码登录（仅小红书）
            </Button>
            <p className="text-xs text-default-400">
              抖音 / 公众号：先随便填一个临时 cookie 添加进来（比如 <code>web_session=tmp</code>），然后点「编辑」录入正式 cookie。
            </p>
          </div>
        </CardBody>
      </Card>

      {/* QR 登录 Modal */}
      <Modal isOpen={qrModal.isOpen} onClose={closeQrModal} size="md" hideCloseButton={false}>
        <ModalContent>
          <ModalHeader>扫码登录小红书</ModalHeader>
          <ModalBody className="flex items-center justify-center py-6">
            {qrStatus === "loading" && <p className="text-sm text-default-500">正在获取二维码…</p>}
            {qrStatus === "waiting" && qrImage && (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrImage} alt="qr" className="w-56 h-56 rounded-lg border" />
                <p className="text-sm text-default-500">用手机小红书扫码后点「确认登录」</p>
              </div>
            )}
            {qrStatus === "success" && (
              <p className="text-sm text-success">登录成功，账号已保存。</p>
            )}
            {(qrStatus === "failed" || qrStatus === "expired" || qrStatus === "cancelled") && (
              <div className="flex flex-col items-center gap-2 text-sm text-danger">
                <span>{qrStatus === "expired" ? "二维码已过期" : qrStatus === "cancelled" ? "已取消" : "登录失败"}</span>
                {qrError && <span className="text-xs text-default-400">{qrError}</span>}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeQrModal}>关闭</Button>
            {(qrStatus === "failed" || qrStatus === "expired") && (
              <Button color="primary" onPress={startQrLogin}>重新扫码</Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 编辑 Modal */}
      <Modal isOpen={editModal.isOpen} onClose={editModal.onClose} size="md">
        <ModalContent>
          <ModalHeader>编辑账号</ModalHeader>
          <ModalBody className="space-y-3">
            <Input label="名称"
              value={editForm.name}
              onValueChange={(v) => setEdit("name", v)} />
            <Input label="Cookie（留空不修改）"
              type="password"
              placeholder="web_session=...; 其他=...; "
              value={editForm.cookie}
              onValueChange={(v) => setEdit("cookie", v)} />
            <Input label="代理 URL"
              placeholder="http:// / socks5://（留空表示直连）"
              value={editForm.proxy_url}
              onValueChange={(v) => setEdit("proxy_url", v)} />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={editModal.onClose}>取消</Button>
            <Button color="primary" isLoading={savingEdit} onPress={saveEdit}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
