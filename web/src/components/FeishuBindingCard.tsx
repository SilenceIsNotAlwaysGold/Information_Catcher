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
import { DailyReportPushToggle } from "@/components/DailyReportPushToggle";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { LinkIcon, AlertCircle, CheckCircle2, Unlink, ExternalLink, RefreshCw, QrCode, Copy, UserPlus, ChevronDown, ChevronRight } from "lucide-react";
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
  // 已绑定状态下「邀请团队加入企业」区块默认折叠（避免抢主流程视觉）
  const [inviteExpanded, setInviteExpanded] = useState(false);

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

  // 公共：邀请同事加入企业的二维码 + 邀请码 + 引导文案
  // mode="onboard"：未绑定时展示给当前用户自己用（"先加入企业再绑定"）
  // mode="invite"：已绑定时展示给当前用户分享给团队（"邀请同事加入"）
  const renderInviteBlock = (mode: "onboard" | "invite") => {
    if (!status?.invite_url) return null;
    const titleText = mode === "onboard" ? "第一次绑定？需先加入企业" : "邀请团队成员加入你的企业";
    const titleIcon = mode === "onboard" ? <AlertCircle size={15} className="shrink-0" /> : <UserPlus size={15} className="shrink-0" />;
    const tone = mode === "onboard" ? "warning" : "primary";
    const desc = mode === "onboard"
      ? "本平台用的是飞书自建应用，只允许应用所属企业的成员授权。如果你授权时看到「你没有应用使用权限」，扫下方二维码加入企业，通过后再点「绑定飞书」即可。已是企业成员的可直接跳过。"
      : "把下方二维码或邀请链接发给团队同事，他们用飞书 App 扫码加入你的企业即可。同事加入后，**不需要单独走 OAuth 绑定**——你直接在飞书里把他们手动拉进自己的告警群 / 多维表格协作即可使用。";
    return (
      <div className={`rounded-lg border border-${tone}/30 bg-${tone}/5 p-4 space-y-3`}>
        <div className={`flex items-center gap-2 text-sm text-${tone}-700`}>
          {titleIcon}
          <span className="font-medium">{titleText}</span>
        </div>
        <p className="text-xs text-default-600 leading-relaxed whitespace-pre-line">
          {desc.replace(/\*\*(.+?)\*\*/g, "「$1」")}
        </p>
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:items-start">
          <div className="bg-white p-3 rounded-md border border-default-200">
            <QRCodeCanvas value={status.invite_url} size={140} level="M" includeMargin={false} />
          </div>
          <div className="flex flex-col gap-2 text-xs text-default-500">
            <div className="flex items-center gap-1.5">
              <QrCode size={12} className="shrink-0" />
              <span>飞书 App 扫码 → 申请加入</span>
            </div>
            <Button size="sm" variant="light" as="a"
              href={status.invite_url} target="_blank" rel="noreferrer"
              startContent={<ExternalLink size={13} />}
              className="self-start">
              在浏览器打开邀请链接
            </Button>
            <Button size="sm" variant="light"
              startContent={<Copy size={13} />}
              className="self-start"
              onPress={async () => {
                try {
                  await navigator.clipboard.writeText(status.invite_url || "");
                  toastOk("邀请链接已复制");
                } catch { toastErr("复制失败，请手动选中复制"); }
              }}>
              复制邀请链接
            </Button>
          </div>
        </div>
        {status.invite_code && (
          <div className="flex items-center gap-2 rounded border border-default-200 bg-white px-3 py-2">
            <span className="text-xs text-default-500 shrink-0">企业邀请码</span>
            <code className="text-sm font-mono font-semibold tracking-wider text-default-800 select-all">
              {status.invite_code}
            </code>
            <Button size="sm" variant="flat" isIconOnly aria-label="复制邀请码"
              className="ml-auto"
              onPress={async () => {
                try {
                  await navigator.clipboard.writeText(status.invite_code || "");
                  toastOk(`已复制邀请码：${status.invite_code}`);
                } catch { toastErr("复制失败，请手动选中复制"); }
              }}>
              <Copy size={13} />
            </Button>
          </div>
        )}
        {mode === "invite" && (
          <p className="text-[11px] text-default-400">
            提示：同事加入企业后，他们登录平台无需绑定飞书也能用全部功能；你只需在飞书 App 里把他们手动拉进对应群即可收到告警 / 协作多维表格。
          </p>
        )}
      </div>
    );
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
            {renderInviteBlock("onboard")}

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

            {/* 每日日报推送开关 */}
            <DailyReportPushToggle />

            {/* 邀请团队加入企业（已绑定状态下显示，让 owner 把邀请码 / 二维码分享给同事） */}
            {status.invite_url && (
              <div className="border-t border-default-200 pt-3">
                <button type="button"
                  onClick={() => setInviteExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-sm text-primary hover:opacity-80">
                  {inviteExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <UserPlus size={14} />
                  <span className="font-medium">邀请团队成员加入企业</span>
                  <span className="text-xs text-default-400">— 同事加入后无需绑定即可使用</span>
                </button>
                {inviteExpanded && <div className="mt-3">{renderInviteBlock("invite")}</div>}
              </div>
            )}

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
