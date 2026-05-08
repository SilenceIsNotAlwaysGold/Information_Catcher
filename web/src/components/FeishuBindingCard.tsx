"use client";

/**
 * 飞书绑定卡片
 *
 * 状态：
 *  - 未配置 OAuth：提示管理员先去填 redirect_uri
 *  - 未绑定：「绑定飞书」按钮 → 跳转飞书授权页
 *  - 已绑定：显示飞书姓名 / chat_id / bitable token / 解绑按钮
 *
 * 飞书告警走应用机器人（chat_id），不再支持 webhook 兜底。
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { LinkIcon, AlertCircle, CheckCircle2, Unlink, ExternalLink, RefreshCw, QrCode, Copy } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

type Status = {
  bound: boolean;
  open_id: string;
  name: string;
  chat_id: string;
  bitable_app_token: string;
  image_table_id: string;
  trending_table_id: string;
  bound_at: string;
  webhook_url: string;
  oauth_configured: boolean;
  invite_url?: string;
  invite_code?: string;
};

const API = (p: string) => `/api/feishu${p}`;

export function FeishuBindingCard() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/status"), { headers });
      if (!r.ok) throw new Error(await r.text());
      setStatus(await r.json());
    } catch (e: any) {
      toastErr(`读取飞书状态失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  useEffect(() => { load(); }, [load]);

  // OAuth 回调跳回时 URL 带 ?feishu=ok|error&msg=...
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const flag = u.searchParams.get("feishu");
    if (!flag) return;
    if (flag === "ok") {
      toastOk("飞书已绑定");
    } else {
      toastErr(`飞书绑定失败：${u.searchParams.get("msg") || "unknown"}`);
    }
    u.searchParams.delete("feishu");
    u.searchParams.delete("msg");
    window.history.replaceState({}, "", u.toString());
    load();
  }, [load]);

  const handleBind = async () => {
    setBusy(true);
    try {
      const r = await fetch(API("/oauth/authorize"), { headers });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toastErr(d.detail || "获取授权 URL 失败");
        return;
      }
      window.location.href = d.authorize_url;
    } catch (e: any) {
      toastErr(`绑定失败：${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async () => {
    if (!confirm("解绑后告警将不再推送，飞书侧静默；要重新接收需要再次扫码绑定。确认解绑？")) return;
    setBusy(true);
    try {
      const r = await fetch(API("/unbind"), { method: "POST", headers });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || "解绑失败");
        return;
      }
      toastOk("已解绑");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleReprovision = async (force: boolean) => {
    if (force && !confirm("强制重建会清空当前的群和多维表格关联（不会删远端数据），重新创建一份。确认？")) {
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(API(`/reprovision?force=${force}`), {
        method: "POST", headers,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toastErr(d.detail || "重建失败");
        return;
      }
      toastOk(force ? "已强制重建" : "已补全缺失的资源");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <LinkIcon size={18} className="text-primary" />
        <span className="font-semibold">飞书绑定</span>
        {status?.bound && <Chip size="sm" color="success" variant="flat">已绑定</Chip>}
        {status && !status.bound && <Chip size="sm" variant="flat">未绑定</Chip>}
      </CardHeader>
      <CardBody className="space-y-4">
        {loading || !status ? (
          <div className="flex items-center gap-2 text-sm text-default-400">
            <Spinner size="sm" /> 加载中…
          </div>
        ) : !status.oauth_configured ? (
          <div className="flex items-start gap-2 text-sm text-warning bg-warning/10 rounded-lg p-3">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <div>
              飞书 OAuth 未配置，请联系管理员在「系统设置」里填写 <code>feishu_oauth_redirect_uri</code>、<code>feishu_app_id</code>、<code>feishu_app_secret</code>。
            </div>
          </div>
        ) : !status.bound ? (
          <>
            <p className="text-sm text-default-500">
              绑定飞书后，告警会通过应用机器人推送到你的专属群（自动拉你 + admin 进群），
              热门内容 / 商品图历史会自动写入你的专属多维表格。
            </p>

            {/* 自建应用：只允许应用所属企业的成员授权。外部用户需先扫码加入企业 */}
            {status.invite_url && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-warning-700">
                  <AlertCircle size={15} className="shrink-0" />
                  <span className="font-medium">第一次绑定？需先加入企业</span>
                </div>
                <p className="text-xs text-default-600 leading-relaxed">
                  本平台用的是飞书自建应用，只允许应用所属企业的成员授权。
                  如果你授权时看到「你没有应用使用权限」，扫下方二维码加入企业，
                  通过后再点「绑定飞书」即可。已是企业成员的可直接跳过。
                </p>
                <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start">
                  <div className="bg-white p-3 rounded-md border border-default-200">
                    <QRCodeCanvas
                      value={status.invite_url}
                      size={140}
                      level="M"
                      includeMargin={false}
                    />
                  </div>
                  <div className="flex flex-col gap-2 text-xs text-default-500">
                    <div className="flex items-center gap-1.5">
                      <QrCode size={12} className="shrink-0" />
                      <span>飞书 App 扫码 → 申请加入</span>
                    </div>
                    <Button
                      size="sm"
                      variant="light"
                      as="a"
                      href={status.invite_url}
                      target="_blank"
                      rel="noreferrer"
                      startContent={<ExternalLink size={13} />}
                      className="self-start"
                    >
                      或在浏览器打开邀请链接
                    </Button>
                  </div>
                </div>

                {/* 8 位企业邀请码：扫码后飞书 App 跳到「输入企业邀请码」页时手动输入 */}
                {status.invite_code && (
                  <div className="flex items-center gap-2 rounded border border-default-200 bg-white px-3 py-2">
                    <span className="text-xs text-default-500 shrink-0">企业邀请码</span>
                    <code className="text-sm font-mono font-semibold tracking-wider text-default-800 select-all">
                      {status.invite_code}
                    </code>
                    <Button
                      size="sm"
                      variant="flat"
                      isIconOnly
                      aria-label="复制邀请码"
                      className="ml-auto"
                      onPress={async () => {
                        try {
                          await navigator.clipboard.writeText(status.invite_code || "");
                          toastOk(`已复制邀请码：${status.invite_code}`);
                        } catch {
                          toastErr("复制失败，请手动选中复制");
                        }
                      }}
                    >
                      <Copy size={13} />
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div>
              <Button
                color="primary"
                isLoading={busy}
                onPress={handleBind}
                startContent={<LinkIcon size={15} />}
              >
                绑定飞书（扫码授权）
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2 text-sm text-success bg-success/10 rounded-lg p-3">
              <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
              <div>
                已绑定为 <strong>{status.name || status.open_id}</strong>
                {status.bound_at && (
                  <span className="text-default-500 ml-2">
                    （{new Date(status.bound_at).toLocaleString("zh-CN")}）
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <Field label="open_id" value={status.open_id} mono />
              <Field label="群 chat_id" value={status.chat_id || "（待 Phase 2 自动建群）"} mono />
              <Field label="多维表 app_token" value={status.bitable_app_token || "（待 Phase 3 自动建表）"} mono />
              <Field label="image_table_id" value={status.image_table_id || "—"} mono />
              <Field label="trending_table_id" value={status.trending_table_id || "—"} mono />
            </div>

            <div className="flex gap-2 pt-2 flex-wrap">
              {status.bitable_app_token && (
                <Button
                  size="sm"
                  variant="flat"
                  as="a"
                  href={`https://feishu.cn/base/${status.bitable_app_token}`}
                  target="_blank"
                  rel="noreferrer"
                  startContent={<ExternalLink size={14} />}
                >
                  打开多维表格
                </Button>
              )}
              <Button
                size="sm"
                variant="flat"
                color="primary"
                isLoading={busy}
                onPress={() => handleReprovision(false)}
                startContent={<RefreshCw size={14} />}
              >
                补全缺失
              </Button>
              <Button
                size="sm"
                variant="flat"
                color="warning"
                isLoading={busy}
                onPress={() => handleReprovision(true)}
                startContent={<RefreshCw size={14} />}
              >
                强制重建
              </Button>
              <Button
                size="sm"
                variant="flat"
                color="danger"
                isLoading={busy}
                onPress={handleUnbind}
                startContent={<Unlink size={14} />}
              >
                解绑
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-default-400">{label}</div>
      <div
        className={`text-default-700 break-all ${mono ? "font-mono" : ""}`}
        title={value}
      >
        {value || "—"}
      </div>
    </div>
  );
}
