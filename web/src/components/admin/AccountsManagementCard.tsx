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
import { Input, Textarea } from "@nextui-org/input";
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
  const importModal = useDisclosure();
  const [importCookie, setImportCookie] = useState("");
  const [importUserAgent, setImportUserAgent] = useState("");
  const [importing, setImporting] = useState(false);
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

  const submitImportCookie = async () => {
    const name = accountForm.name.trim();
    const cookie = importCookie.trim();
    if (!name) { toastErr("请填写账号名称"); return; }
    if (!cookie) { toastErr("Cookie 不能为空"); return; }
    setImporting(true);
    try {
      const r = await fetch(API("/accounts"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          cookie,
          proxy_url: accountForm.proxy_url || "",
          user_agent: importUserAgent.trim() || "",
          fp_browser_type: "builtin",
          platform: accountForm.platform || "xhs",
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toastErr(`添加失败：${data?.detail || `HTTP ${r.status}`}`);
        return;
      }
      toastOk("账号已导入，正在检查 Cookie 健康度...");
      importModal.onClose();
      setImportCookie("");
      setImportUserAgent("");
      setAccountForm(emptyAccountForm);
      await load();
      // 自动检查 cookie 健康度（让用户立刻看到是否有效）
      if (data?.id) {
        try { await fetch(API(`/accounts/${data.id}/check-cookie`), { method: "POST", headers }); } catch {}
        await load();
      }
    } catch (e: any) {
      toastErr(`导入异常：${e?.message || e}`);
    } finally {
      setImporting(false);
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
            <div className="flex gap-2 flex-wrap">
              <Button
                color="primary"
                startContent={<QrCode size={15} />}
                isDisabled={!accountForm.name.trim() || accountForm.platform !== "xhs"}
                onPress={startQrLogin}
              >
                扫码登录（仅小红书）
              </Button>
              <Button
                color="secondary"
                variant="flat"
                isDisabled={!accountForm.name.trim()}
                onPress={importModal.onOpen}
              >
                导入 Cookie（任意平台）
              </Button>
            </div>
            <p className="text-xs text-default-400">
              抖音 / 公众号没有扫码登录入口，从浏览器 F12 → Application → Cookies 复制完整 cookie 字符串，粘贴到「导入 Cookie」即可。
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

      {/* 导入 Cookie Modal — 三平台通用 */}
      <Modal isOpen={importModal.isOpen} onClose={importModal.onClose} size="2xl">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <span>导入 Cookie · {PLATFORM_LABELS[(accountForm.platform || "xhs") as PlatformKey]}</span>
            <span className="text-xs text-default-500 font-normal">
              账号「{accountForm.name || "未命名"}」 / 平台「{accountForm.platform || "xhs"}」
              {accountForm.proxy_url && " / 已配代理"}
            </span>
          </ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-xs text-default-500 leading-relaxed bg-default-50 rounded p-3 space-y-2">
              <div><b>怎么拿 Cookie：</b></div>
              {accountForm.platform === "xhs" && (
                <ol className="list-decimal list-inside space-y-1">
                  <li>浏览器登录 <code>www.xiaohongshu.com</code></li>
                  <li>F12 → Application → Cookies → <code>https://www.xiaohongshu.com</code></li>
                  <li>**关键 cookie**：<code>web_session</code>（必须有）+ <code>a1</code> <code>webId</code> <code>xsecappid</code> 等</li>
                  <li>右键导出全部 / 用 EditThisCookie 插件导出，或手动复制每行成 <code>name=value;</code> 格式</li>
                </ol>
              )}
              {accountForm.platform === "douyin" && (
                <ol className="list-decimal list-inside space-y-1">
                  <li>浏览器登录 <code>www.douyin.com</code></li>
                  <li>F12 → Application → Cookies → <code>https://www.douyin.com</code></li>
                  <li>**关键 cookie**：<code>sessionid</code> <code>sessionid_ss</code>（必须有）+ <code>ttwid</code> <code>passport_csrf_token</code> 等</li>
                  <li>用 EditThisCookie / Cookie-Editor 插件导出更稳，手动会漏字段</li>
                </ol>
              )}
              {accountForm.platform === "mp" && (
                <ol className="list-decimal list-inside space-y-1">
                  <li>浏览器登录 <code>mp.weixin.qq.com</code></li>
                  <li>F12 → Application → Cookies → <code>https://mp.weixin.qq.com</code></li>
                  <li>**关键 cookie**：<code>slave_user</code> <code>slave_sid</code> <code>data_bizuin</code> <code>data_ticket</code> <code>wxuin</code> 等（缺一不可）</li>
                  <li>公众号 cookie 字段多，建议用插件一次性导出全部</li>
                </ol>
              )}
              <div className="text-warning-700 mt-2">
                ⚠️ Cookie 含登录凭证，仅你自己能看到 / 用，不会泄露给其他用户。失效后自动告警。
              </div>
            </div>

            <Textarea
              label="Cookie 字符串"
              labelPlacement="outside"
              placeholder="key1=value1; key2=value2; key3=value3"
              minRows={6}
              value={importCookie}
              onValueChange={setImportCookie}
              classNames={{ input: "font-mono text-xs" }}
            />
            <Input
              label="User-Agent（可选，建议跟你的浏览器一致）"
              labelPlacement="outside"
              placeholder="Mozilla/5.0 (Macintosh; ...) AppleWebKit/... Chrome/..."
              value={importUserAgent}
              onValueChange={setImportUserAgent}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={importModal.onClose}>取消</Button>
            <Button
              color="primary"
              isLoading={importing}
              onPress={submitImportCookie}
              isDisabled={!accountForm.name.trim() || !importCookie.trim() || importing}
            >
              导入并检查 Cookie
            </Button>
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
