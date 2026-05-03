"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Switch } from "@nextui-org/switch";
import { Divider } from "@nextui-org/divider";
import { Checkbox, CheckboxGroup } from "@nextui-org/checkbox";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { Tooltip } from "@nextui-org/tooltip";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Tabs, Tab } from "@nextui-org/tabs";
import { Trash2, Save, Pencil, QrCode, RefreshCw, ShieldCheck, Server } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PromptTemplatesCard } from "@/components/PromptTemplatesCard";
import { MonitorGroupsCard } from "@/components/MonitorGroupsCard";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";

const API = (path: string) => `/api/monitor${path}`;

type Account = {
  id: number;
  name: string;
  created_at: string;
  proxy_url: string;
  user_agent: string;
  viewport: string;
  timezone: string;
  locale: string;
  fp_browser_type: string;
  fp_profile_id: string;
  fp_api_url: string;
  cookie_status?: string; // valid | expired | unknown
  cookie_checked_at?: string | null;
};

type Settings = {
  webhook_url: string;
  feishu_webhook_url: string;
  check_interval_minutes: string;
  daily_report_enabled: string;
  daily_report_time: string;
  likes_alert_enabled: string;
  likes_threshold: string;
  collects_alert_enabled: string;
  collects_threshold: string;
  comments_alert_enabled: string;
  comments_threshold: string;
  ai_base_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_rewrite_enabled: string;
  ai_rewrite_prompt: string;
  feishu_app_id: string;
  feishu_app_secret: string;
  feishu_bitable_app_token: string;
  feishu_bitable_table_id: string;
  trending_enabled: string;
  trending_keywords: string;
  trending_min_likes: string;
  trending_account_ids: string;
  comments_fetch_enabled: string;
};

const DEFAULTS: Settings = {
  webhook_url: "",
  feishu_webhook_url: "",
  check_interval_minutes: "30",
  daily_report_enabled: "1",
  daily_report_time: "09:00",
  likes_alert_enabled: "1",
  likes_threshold: "50",
  collects_alert_enabled: "1",
  collects_threshold: "50",
  comments_alert_enabled: "1",
  comments_threshold: "1",
  ai_base_url: "https://api.openai.com/v1",
  ai_api_key: "",
  ai_model: "gpt-4o-mini",
  ai_rewrite_enabled: "0",
  ai_rewrite_prompt: "你是小红书爆款文案创作者，请将以下内容改写为更吸引人的小红书风格文案，保持原意但语气更活泼、更有共鸣感，适当加入emoji。原文：\n\n{content}",
  feishu_app_id: "",
  feishu_app_secret: "",
  feishu_bitable_app_token: "",
  feishu_bitable_table_id: "",
  trending_enabled: "0",
  trending_keywords: "",
  trending_min_likes: "1000",
  trending_account_ids: "",
  comments_fetch_enabled: "0",
};

const emptyAccountForm = { name: "", proxy_url: "" };
const emptyEditForm = { name: "", cookie: "", proxy_url: "" };

type PlatformKey = "xhs" | "douyin" | "mp";
type MetricKey = "likes" | "collects" | "comments";

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  xhs: "小红书",
  douyin: "抖音",
  mp: "公众号",
};

// 公众号没有"收藏"概念，第二项展示成"在看"，但仍存到 collects_threshold 字段
const METRIC_DEFS: Record<PlatformKey, Array<{ key: MetricKey; label: string; desc: string; unit: string }>> = {
  xhs: [
    { key: "likes",    label: "点赞量告警", desc: "单次检测点赞增量超过阈值时推送", unit: "次" },
    { key: "collects", label: "收藏量告警", desc: "单次检测收藏增量超过阈值时推送", unit: "次" },
    { key: "comments", label: "评论告警",   desc: "单次检测新增评论超过阈值时推送", unit: "条" },
  ],
  douyin: [
    { key: "likes",    label: "点赞量告警", desc: "单次检测点赞增量超过阈值时推送", unit: "次" },
    { key: "collects", label: "收藏量告警", desc: "单次检测收藏增量超过阈值时推送", unit: "次" },
    { key: "comments", label: "评论告警",   desc: "单次检测新增评论超过阈值时推送", unit: "条" },
  ],
  mp: [
    { key: "likes",    label: "点赞量告警", desc: "单次检测点赞增量超过阈值时推送", unit: "次" },
    { key: "collects", label: "在看告警",   desc: "单次检测在看增量超过阈值时推送（公众号特有）", unit: "次" },
    { key: "comments", label: "留言告警",   desc: "单次检测新增留言超过阈值时推送", unit: "条" },
  ],
};

const metricToFields = (m: MetricKey) => ({
  enableKey: `${m}_alert_enabled` as keyof Settings,
  threshKey: (m === "likes" ? "likes_threshold"
    : m === "collects" ? "collects_threshold"
    : "comments_threshold") as keyof Settings,
});

export default function MonitorSettingsPage() {
  const { token, user } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === "admin";

  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  // 平台覆盖：保存从后端读到的所有 {platform}.{key} 键值对（字符串："1"/"0" or 数字字符串）
  // 未出现在此 map 的 key === "沿用全局"
  const [platformOverrides, setPlatformOverrides] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountForm, setAccountForm] = useState(emptyAccountForm);
  const [saved, setSaved] = useState(false);

  const editModal = useDisclosure();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [savingEdit, setSavingEdit] = useState(false);
  const setEdit = (k: keyof typeof emptyEditForm, v: string) =>
    setEditForm((f) => ({ ...f, [k]: v }));

  const qrModal = useDisclosure();
  const [qrSessionId, setQrSessionId] = useState<string | null>(null);
  const [qrImage, setQrImage] = useState<string>("");
  const [qrStatus, setQrStatus] = useState<string>("idle"); // idle|loading|waiting|success|failed|expired|cancelled
  const [qrError, setQrError] = useState<string>("");
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrActiveRef = useRef(false); // guards against modal-close during loading

  const stopQrPoll = () => {
    if (qrPollRef.current) {
      clearInterval(qrPollRef.current);
      qrPollRef.current = null;
    }
  };

  const startQrLogin = async () => {
    stopQrPoll(); // defensive: clear any stale poll
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
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail || "启动失败");
      }
      const data = await resp.json();

      // If user closed the modal while loading, cancel the session we just started
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
        method: "POST",
        headers,
      }).catch(() => {});
    }
    setQrSessionId(null);
    setQrImage("");
    setQrStatus("idle");
    setQrError("");
    qrModal.onClose();
  };

  useEffect(() => () => { qrActiveRef.current = false; stopQrPoll(); }, []);

  const set = (key: keyof Settings, val: string) =>
    setSettings((s) => ({ ...s, [key]: val }));
  const bool = (key: keyof Settings) => settings[key] === "1";
  const toggleBool = (key: keyof Settings) =>
    set(key, settings[key] === "1" ? "0" : "1");

  // ── 平台覆盖：一组操作 helpers ───────────────────────────────────────────
  // 是否有任何平台级覆盖（任意一个 enable 或 threshold 已设值）
  const hasPlatformOverride = (platform: PlatformKey) =>
    METRIC_DEFS[platform].some(({ key }) => {
      const { enableKey, threshKey } = metricToFields(key);
      const ovEnable = platformOverrides[`${platform}.${enableKey}`];
      const ovThresh = platformOverrides[`${platform}.${threshKey}`];
      return (ovEnable != null && ovEnable !== "")
        || (ovThresh != null && ovThresh !== "");
    });

  // 读单项：优先 platform 覆盖，否则 fallback 到全局 settings
  const platformBool = (platform: PlatformKey, key: keyof Settings): boolean => {
    const ov = platformOverrides[`${platform}.${key}`];
    if (ov != null && ov !== "") return ov === "1";
    return settings[key] === "1";
  };
  const platformStr = (platform: PlatformKey, key: keyof Settings): string => {
    const ov = platformOverrides[`${platform}.${key}`];
    if (ov != null && ov !== "") return ov;
    return settings[key] || "";
  };

  // 写单项（只更新本地 state，保存时下发）
  const setPlatformOverride = (platform: PlatformKey, key: keyof Settings, val: string) => {
    setPlatformOverrides((m) => ({ ...m, [`${platform}.${key}`]: val }));
  };
  const togglePlatformBool = (platform: PlatformKey, key: keyof Settings) => {
    const cur = platformBool(platform, key);
    setPlatformOverride(platform, key, cur ? "0" : "1");
  };

  // "沿用全局"切换：clear 所有该平台的覆盖键（保存时会发空串让后端 DELETE）
  const setPlatformInherit = (platform: PlatformKey, inherit: boolean) => {
    if (inherit) {
      // 显式置空，保存时后端会 DELETE
      setPlatformOverrides((m) => {
        const next = { ...m };
        for (const { key } of METRIC_DEFS[platform]) {
          const { enableKey, threshKey } = metricToFields(key);
          next[`${platform}.${enableKey}`] = "";
          next[`${platform}.${threshKey}`] = "";
        }
        return next;
      });
    } else {
      // 关闭"沿用全局" → 用全局当前值预填该平台
      setPlatformOverrides((m) => {
        const next = { ...m };
        for (const { key } of METRIC_DEFS[platform]) {
          const { enableKey, threshKey } = metricToFields(key);
          next[`${platform}.${enableKey}`] = settings[enableKey] || "1";
          next[`${platform}.${threshKey}`] = settings[threshKey] || "50";
        }
        return next;
      });
    }
  };

  const load = async () => {
    setAccountsLoading(true);
    try {
      const [s, a] = await Promise.all([
        fetch(API("/settings"), { headers }).then((r) => r.json()),
        fetch(API("/accounts"), { headers }).then((r) => r.json()),
      ]);
      // 拆分：dotted key（"xhs.likes_threshold"）→ platformOverrides；其余 → settings
      const baseSettings: Record<string, string> = {};
      const overrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(s as Record<string, string>)) {
        if (/^(xhs|douyin|mp)\./.test(k)) {
          overrides[k] = v;
        } else {
          baseSettings[k] = v;
        }
      }
      setSettings((prev) => ({ ...prev, ...baseSettings }));
      setPlatformOverrides(overrides);
      setAccounts(a.accounts ?? []);
    } finally {
      setAccountsLoading(false);
    }
  };

  useEffect(() => { load(); }, [token]);

  // CheckboxGroup helpers — store csv in settings, expose array to UI
  const idsCsvToArr = (csv: string): string[] =>
    csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const idsArrToCsv = (arr: string[]): string => arr.join(",");

  const saveSettings = async () => {
    // 用户级字段：所有用户都能保存
    const payload: Record<string, any> = {
      webhook_url: settings.webhook_url,
      feishu_webhook_url: settings.feishu_webhook_url,
      likes_alert_enabled: bool("likes_alert_enabled"),
      likes_threshold: parseInt(settings.likes_threshold),
      collects_alert_enabled: bool("collects_alert_enabled"),
      collects_threshold: parseInt(settings.collects_threshold),
      comments_alert_enabled: bool("comments_alert_enabled"),
      comments_threshold: parseInt(settings.comments_threshold),
      ai_rewrite_enabled: bool("ai_rewrite_enabled"),
      feishu_bitable_app_token: settings.feishu_bitable_app_token,
      feishu_bitable_table_id: settings.feishu_bitable_table_id,
      trending_enabled: bool("trending_enabled"),
      trending_keywords: settings.trending_keywords,
      trending_min_likes: parseInt(settings.trending_min_likes),
      comments_fetch_enabled: bool("comments_fetch_enabled"),
    };
    // admin only：仅 admin 才把这些字段加入 payload
    if (isAdmin) {
      Object.assign(payload, {
        check_interval_minutes: parseInt(settings.check_interval_minutes),
        daily_report_enabled: bool("daily_report_enabled"),
        daily_report_time: settings.daily_report_time,
        ai_base_url: settings.ai_base_url,
        ai_api_key: settings.ai_api_key,
        ai_model: settings.ai_model,
        feishu_app_id: settings.feishu_app_id,
        feishu_app_secret: settings.feishu_app_secret,
        trending_account_ids: settings.trending_account_ids,
      });
    }
    // 平台覆盖：dotted keys 直接放进 payload，由后端做白名单 + DELETE/UPSERT
    for (const [k, v] of Object.entries(platformOverrides)) {
      // 空串 → 后端 DELETE（沿用全局）
      // bool 字段保留 "1"/"0"；threshold 字段转 number 让后端的 int 校验通过
      if (v === "" || v == null) {
        payload[k] = "";
        continue;
      }
      if (k.endsWith("_threshold")) {
        const n = parseInt(v);
        payload[k] = Number.isFinite(n) ? n : "";
      } else {
        // alert_enabled：发 boolean，后端 bool_val 转 "1"/"0"
        payload[k] = v === "1";
      }
    }
    await fetch(API("/settings"), {
      method: "PUT", headers, body: JSON.stringify(payload),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const deleteAccount = async (id: number) => {
    await fetch(API(`/accounts/${id}`), { method: "DELETE", headers });
    await load();
  };

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
    // Omit cookie from patch when blank so the server keeps the existing value.
    const { cookie, ...rest } = editForm;
    const body: Record<string, string> = { ...rest };
    if (cookie.trim()) body.cookie = cookie;
    await fetch(API(`/accounts/${editingId}`), {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    setSavingEdit(false);
    editModal.onClose();
    await load();
  };

  const renderAccountBadges = (a: Account) => {
    if (!a.proxy_url) return null;
    return <Chip size="sm" color="warning" variant="flat">代理</Chip>;
  };

  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const checkOne = async (id: number) => {
    setCheckingId(id);
    try {
      await fetch(API(`/accounts/${id}/check-cookie`), { method: "POST", headers });
      await load();
    } finally {
      setCheckingId(null);
    }
  };

  const checkAll = async () => {
    setCheckingAll(true);
    await fetch(API("/accounts/check-cookies"), { method: "POST", headers });
    // health check is async; refresh a few times to pick up incremental results
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      await load();
    }
    setCheckingAll(false);
  };

  const cookieStatusChip = (a: Account) => {
    const s = a.cookie_status || "unknown";
    if (s === "valid") return <Chip size="sm" color="success" variant="flat">正常</Chip>;
    if (s === "expired") return <Chip size="sm" color="danger" variant="flat">已失效</Chip>;
    return <Chip size="sm" color="default" variant="flat">未检测</Chip>;
  };

  // ── 渲染：单个平台 tab 内容（阈值 + 沿用全局） ──────────────────────────
  const renderPlatformPanel = (platform: PlatformKey) => {
    const inherit = !hasPlatformOverride(platform);
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader className="font-semibold flex justify-between items-center">
            <span>{PLATFORM_LABELS[platform]} · 告警阈值</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-default-500">沿用全局</span>
              <Switch
                size="sm"
                isSelected={inherit}
                onValueChange={(v) => setPlatformInherit(platform, v)}
              />
            </div>
          </CardHeader>
          <CardBody className="space-y-5">
            {inherit && (
              <p className="text-xs text-default-400">
                当前沿用「全局」tab 中的告警阈值。关闭上方开关后可单独配置 {PLATFORM_LABELS[platform]} 的阈值。
              </p>
            )}
            {!inherit && METRIC_DEFS[platform].map((item, i) => {
              const { enableKey, threshKey } = metricToFields(item.key);
              const enabled = platformBool(platform, enableKey);
              return (
                <div key={item.key}>
                  {i > 0 && <Divider className="mb-5" />}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{item.label}</p>
                        <p className="text-xs text-default-400">{item.desc}</p>
                      </div>
                      <Switch
                        isSelected={enabled}
                        onValueChange={() => togglePlatformBool(platform, enableKey)}
                        color="primary"
                      />
                    </div>
                    {enabled && (
                      <Input size="sm" type="number" label="触发阈值"
                        value={platformStr(platform, threshKey)}
                        onValueChange={(v) => setPlatformOverride(platform, threshKey, v)}
                        endContent={<span className="text-default-400 text-xs">{item.unit}</span>}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </CardBody>
        </Card>

        <Button color="primary" startContent={<Save size={16} />} onPress={saveSettings}>
          {saved ? "已保存 ✓" : "保存设置"}
        </Button>
      </div>
    );
  };

  // ── 渲染：全局 tab（webhook、AI、daily report、外部数据源等） ────────────
  const renderGlobalPanel = () => (
    <div className="space-y-6">
      {/* Push Channels */}
      <Card>
        <CardHeader className="font-semibold">推送渠道</CardHeader>
        <CardBody className="space-y-4">
          <Input
            label="企业微信 Webhook URL"
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
            value={settings.webhook_url}
            onValueChange={(v) => set("webhook_url", v)}
          />
          <Input
            label="飞书机器人 Webhook URL"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={settings.feishu_webhook_url}
            onValueChange={(v) => set("feishu_webhook_url", v)}
          />
          {isAdmin ? (
            <Input
              label="检测间隔"
              type="number"
              value={settings.check_interval_minutes}
              onValueChange={(v) => set("check_interval_minutes", v)}
              endContent={<span className="text-default-400 text-sm">分钟</span>}
            />
          ) : (
            <p className="text-xs text-default-400">检测间隔由管理员统一配置（默认 30 分钟）</p>
          )}
        </CardBody>
      </Card>

      {/* Monitor Groups */}
      <MonitorGroupsCard token={token} />

      {/* Alert Rules：全局阈值，作为各平台 tab 未单独配置时的兜底 */}
      <Card>
        <CardHeader className="font-semibold">全局告警阈值（兜底）</CardHeader>
        <CardBody className="space-y-5">
          <p className="text-xs text-default-400">
            未单独配置的平台会沿用此处阈值。如需为「小红书 / 抖音 / 公众号」分别设置，请切换到对应 tab。
          </p>
          {[
            { key: "likes" as const, label: "点赞量告警", desc: "单次检测点赞增量超过阈值时推送", unit: "次" },
            { key: "collects" as const, label: "收藏量告警", desc: "单次检测收藏增量超过阈值时推送", unit: "次" },
            { key: "comments" as const, label: "评论告警", desc: "单次检测新增评论超过阈值时推送", unit: "条" },
          ].map((item, i) => {
            const enableKey = `${item.key}_alert_enabled` as keyof Settings;
            const realThreshKey = item.key === "likes" ? "likes_threshold"
              : item.key === "collects" ? "collects_threshold"
              : "comments_threshold";
            return (
              <div key={item.key}>
                {i > 0 && <Divider className="mb-5" />}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{item.label}</p>
                      <p className="text-xs text-default-400">{item.desc}</p>
                    </div>
                    <Switch isSelected={bool(enableKey)} onValueChange={() => toggleBool(enableKey)} color="primary" />
                  </div>
                  {bool(enableKey) && (
                    <Input size="sm" type="number" label="触发阈值"
                      value={settings[realThreshKey as keyof Settings]}
                      onValueChange={(v) => set(realThreshKey as keyof Settings, v)}
                      endContent={<span className="text-default-400 text-xs">{item.unit}</span>}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </CardBody>
      </Card>

      {/* Daily Report：仅 admin 可配置 */}
      {isAdmin && (
        <Card>
          <CardHeader className="font-semibold">每日日报</CardHeader>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">启用每日日报</span>
              <Switch isSelected={bool("daily_report_enabled")} onValueChange={() => toggleBool("daily_report_enabled")} color="primary" />
            </div>
            <Input label="日报发送时间" type="time" value={settings.daily_report_time}
              onValueChange={(v) => set("daily_report_time", v)} />
          </CardBody>
        </Card>
      )}

      {/* Trending Monitor */}
      <Card>
        <CardHeader className="font-semibold">热门内容监控</CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">启用热门抓取</p>
              <p className="text-xs text-default-400">每隔检测周期自动搜索关键词，发现新热门内容推送通知</p>
            </div>
            <Switch isSelected={bool("trending_enabled")} onValueChange={() => toggleBool("trending_enabled")} color="primary" />
          </div>
          {bool("trending_enabled") && (
            <>
              <Input
                label="监控关键词（逗号分隔）"
                placeholder="例：美食探店,穿搭,护肤"
                value={settings.trending_keywords}
                onValueChange={(v) => set("trending_keywords", v)}
              />
              <Input
                label="最低点赞数（低于此值忽略）"
                type="number"
                value={settings.trending_min_likes}
                onValueChange={(v) => set("trending_min_likes", v)}
                endContent={<span className="text-default-400 text-xs">赞</span>}
              />
              {isAdmin && accounts.length > 0 && (
                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium">参与搜索的账号（不选=自动从共享池里挑）</p>
                    <p className="text-xs text-default-400">仅管理员可配置。多选时按关键词轮询账号。</p>
                  </div>
                  <CheckboxGroup
                    orientation="horizontal"
                    value={idsCsvToArr(settings.trending_account_ids)}
                    onValueChange={(arr) => set("trending_account_ids", idsArrToCsv(arr))}
                  >
                    {accounts.map((a) => (
                      <Checkbox key={a.id} value={String(a.id)}>{a.name}</Checkbox>
                    ))}
                  </CheckboxGroup>
                </div>
              )}
              {!isAdmin && (
                <p className="text-xs text-default-400">
                  搜索使用平台共享账号池，不消耗你自己的账号。
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {/* AI Config — 仅 admin 可见。普通用户不需要配置 API Key，平台已统一提供 */}
      {isAdmin && (
        <Card>
          <CardHeader className="font-semibold">AI 配置（仅管理员可见）</CardHeader>
          <CardBody className="space-y-4">
            <p className="text-xs text-default-400">
              这里的 API Key 给全平台所有用户共用。普通用户在「热门内容」页直接点改写即可。
            </p>
            <Input label="API Base URL（OpenAI 格式）"
              placeholder="https://api.openai.com/v1"
              value={settings.ai_base_url}
              onValueChange={(v) => set("ai_base_url", v)} />
            <Input label="API Key" type="password"
              placeholder="sk-..."
              value={settings.ai_api_key}
              onValueChange={(v) => set("ai_api_key", v)} />
            <Input label="模型名称"
              placeholder="gpt-4o-mini"
              value={settings.ai_model}
              onValueChange={(v) => set("ai_model", v)} />
          </CardBody>
        </Card>
      )}

      {/* Prompt Templates */}
      <PromptTemplatesCard token={token} />


      {/* Feishu Bitable — App ID/Secret 仅 admin；表格地址普通用户也能配置（属于自己的目的地） */}
      <Card>
        <CardHeader className="font-semibold">飞书多维表格同步</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-default-400">
            AI 改写完成后自动同步到飞书多维表格。
            {!isAdmin && " 飞书应用 App ID/Secret 由管理员统一配置；你只需要填目标表格地址。"}
          </p>
          {isAdmin && (
            <div className="grid grid-cols-2 gap-3">
              <Input label="App ID（管理员）" placeholder="cli_..." value={settings.feishu_app_id}
                onValueChange={(v) => set("feishu_app_id", v)} />
              <Input label="App Secret（管理员）" type="password" placeholder="..."
                value={settings.feishu_app_secret}
                onValueChange={(v) => set("feishu_app_secret", v)} />
            </div>
          )}
          <Input label="Bitable App Token" placeholder="从多维表格 URL 中获取"
            value={settings.feishu_bitable_app_token}
            onValueChange={(v) => set("feishu_bitable_app_token", v)} />
          <Input label="Table ID" placeholder="tbl..."
            value={settings.feishu_bitable_table_id}
            onValueChange={(v) => set("feishu_bitable_table_id", v)} />
        </CardBody>
      </Card>

      {/* Monitor advanced settings */}
      <Card>
        <CardHeader className="font-semibold">监控高级设置</CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">抓取帖子评论内容</p>
              <p className="text-xs text-default-400">监控帖子时，推送具体评论文本（需 Playwright，较慢）</p>
            </div>
            <Switch isSelected={bool("comments_fetch_enabled")} onValueChange={() => toggleBool("comments_fetch_enabled")} color="primary" />
          </div>
        </CardBody>
      </Card>

      <Button color="primary" startContent={<Save size={16} />} onPress={saveSettings}>
        {saved ? "已保存 ✓" : "保存设置"}
      </Button>

      {!isAdmin && (
        <Card>
          <CardBody className="text-center text-sm text-default-500 py-6">
            🔐 平台已为你配置好搜索账号和 AI 改写所需的 API Key，无需自行管理。
          </CardBody>
        </Card>
      )}

      {isAdmin && <Divider />}

      {/* Account Management — 仅 admin 才需要看到 cookie 录入面板 */}
      {isAdmin && (
      <Card>
        <CardHeader className="font-semibold">账号管理</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-default-500">
            每个账号可独立配置代理、指纹参数或接入外置指纹浏览器。Cookie 需包含{" "}
            <code className="bg-default-100 px-1 rounded">web_session</code>。
          </p>

          {accountsLoading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : accounts.length > 0 ? (
            <>
              <div className="flex justify-end">
                <Button size="sm" variant="flat"
                  startContent={<ShieldCheck size={14} />}
                  isLoading={checkingAll}
                  onPress={checkAll}>
                  检查全部 Cookie
                </Button>
              </div>
              <Table aria-label="accounts" removeWrapper>
                <TableHeader>
                  <TableColumn>账号</TableColumn>
                  <TableColumn>状态</TableColumn>
                  <TableColumn>代理</TableColumn>
                  <TableColumn>最后检测</TableColumn>
                  <TableColumn>操作</TableColumn>
                </TableHeader>
                <TableBody>
                  {accounts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell><Chip size="sm" variant="flat">{a.name}</Chip></TableCell>
                      <TableCell>{cookieStatusChip(a)}</TableCell>
                      <TableCell>{renderAccountBadges(a) ?? <span className="text-xs text-default-400">—</span>}</TableCell>
                      <TableCell>
                        <span className="text-xs text-default-400">
                          {a.cookie_checked_at ? a.cookie_checked_at.slice(0, 16) : "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Tooltip content="检查 Cookie">
                            <Button isIconOnly size="sm" variant="light"
                              isLoading={checkingId === a.id}
                              onPress={() => checkOne(a.id)}>
                              <RefreshCw size={15} />
                            </Button>
                          </Tooltip>
                          <Button isIconOnly size="sm" variant="light"
                            onPress={() => openEdit(a)}>
                            <Pencil size={15} />
                          </Button>
                          <Button isIconOnly size="sm" variant="light" color="danger"
                            onPress={() => deleteAccount(a.id)}>
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <EmptyState
              icon={Server}
              title="暂无账号"
              hint="填写下方账号名称后点「扫码登录」，用小红书 App 扫码即可自动保存账号。"
            />
          )}

          <Divider />

          <div className="space-y-3">
            <p className="text-sm text-default-500">填写账号名称后点击「扫码登录」，用小红书 App 扫码即可自动保存账号。</p>
            <Input
              label="账号名称"
              placeholder="例：账号A"
              value={accountForm.name}
              onValueChange={(v) => setAccountForm((f) => ({ ...f, name: v }))}
            />
            <Input
              label="代理 URL（可选，仅用于监控）"
              placeholder="http://user:pass@host:port 或 socks5://host:port"
              description="代理只在后台监控时生效，扫码登录始终使用本机直连"
              value={accountForm.proxy_url}
              onValueChange={(v) => setAccountForm((f) => ({ ...f, proxy_url: v }))}
            />
            <Button
              color="primary"
              startContent={<QrCode size={16} />}
              onPress={startQrLogin}
              isDisabled={!accountForm.name}
              className="w-full"
            >
              扫码登录
            </Button>
          </div>
        </CardBody>
      </Card>
      )}
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">监控设置</h1>

      <Tabs aria-label="settings sections">
        <Tab key="global" title="全局">
          {renderGlobalPanel()}
        </Tab>
        <Tab key="xhs" title={PLATFORM_LABELS.xhs}>
          {renderPlatformPanel("xhs")}
        </Tab>
        <Tab key="douyin" title={PLATFORM_LABELS.douyin}>
          {renderPlatformPanel("douyin")}
        </Tab>
        <Tab key="mp" title={PLATFORM_LABELS.mp}>
          {renderPlatformPanel("mp")}
        </Tab>
      </Tabs>

      {/* Edit Account Modal */}
      <Modal isOpen={editModal.isOpen} onClose={editModal.onClose} size="md">
        <ModalContent>
          <ModalHeader>编辑账号</ModalHeader>
          <ModalBody>
            <div className="space-y-3">
              <Input
                label="账号名称"
                value={editForm.name}
                onValueChange={(v) => setEdit("name", v)}
              />
              <Input
                label="代理 URL（仅用于监控）"
                placeholder="http://user:pass@host:port 或 socks5://host:port"
                description="后台监控使用，扫码登录不受影响"
                value={editForm.proxy_url}
                onValueChange={(v) => setEdit("proxy_url", v)}
              />
              <Textarea
                label="Cookie（留空则保持原值）"
                placeholder="仅在需要手动更新 Cookie 时填写"
                value={editForm.cookie}
                onValueChange={(v) => setEdit("cookie", v)}
                minRows={3}
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={editModal.onClose}>取消</Button>
            <Button color="primary" onPress={saveEdit} isLoading={savingEdit}
              isDisabled={!editForm.name}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* QR Login Modal */}
      <Modal isOpen={qrModal.isOpen} onClose={closeQrModal} size="md" hideCloseButton={false}>
        <ModalContent>
          <ModalHeader>扫码登录小红书</ModalHeader>
          <ModalBody>
            <div className="flex flex-col items-center gap-3 py-2">
              {qrStatus === "loading" && (
                <p className="text-sm text-default-500">正在启动浏览器获取二维码…</p>
              )}
              {qrStatus === "waiting" && qrImage && (
                <>
                  <img
                    src={qrImage}
                    alt="QR"
                    className="w-52 h-52 border rounded-lg bg-white p-2"
                  />
                  <p className="text-sm">请用小红书 App 扫码，登录后自动保存账号</p>
                  <p className="text-xs text-default-400">
                    账号名：<span className="font-medium text-default-600">{accountForm.name}</span>
                    {accountForm.proxy_url && <>　· 代理已启用</>}
                  </p>
                </>
              )}
              {qrStatus === "success" && (
                <p className="text-success font-medium">✓ 登录成功，账号已保存</p>
              )}
              {qrStatus === "expired" && (
                <p className="text-warning">二维码已过期，请重试</p>
              )}
              {qrStatus === "cancelled" && (
                <p className="text-default-500">已取消</p>
              )}
              {qrStatus === "failed" && (
                <div className="text-center">
                  <p className="text-danger font-medium">登录失败</p>
                  {qrError && <p className="text-xs text-default-400 mt-1">{qrError}</p>}
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={closeQrModal}>
              {qrStatus === "waiting" ? "取消" : "关闭"}
            </Button>
            {(qrStatus === "expired" || qrStatus === "failed") && (
              <Button color="primary" onPress={startQrLogin}>重试</Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
