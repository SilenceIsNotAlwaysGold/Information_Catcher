"use client";

import { useState, useEffect } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Switch } from "@nextui-org/switch";
import { Divider } from "@nextui-org/divider";
import { Tabs, Tab } from "@nextui-org/tabs";
import { Save } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PromptTemplatesCard } from "@/components/PromptTemplatesCard";
import { MonitorGroupsCard } from "@/components/MonitorGroupsCard";
import { FeishuBindingCard } from "@/components/FeishuBindingCard";
import { PlanUsageCard } from "@/components/PlanUsageCard";
import { FeishuPushToggle } from "@/components/FeishuPushToggle";
import { AiPreferencesCard } from "@/components/AiPreferencesCard";
// v2: 自带 AI 渠道下线（AI 全走平台统一渠道，按点数计费）—— MyAiModelsCard 已移除

const API = (path: string) => `/api/monitor${path}`;

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
  feishu_oauth_redirect_uri: string;
  feishu_bitable_root_folder_token: string;
  feishu_admin_open_id: string;
  feishu_invite_url: string;
  feishu_invite_code: string;
  feishu_bitable_app_token: string;
  feishu_bitable_table_id: string;
  feishu_bitable_image_table_id: string;
  qiniu_access_key: string;
  qiniu_secret_key: string;
  qiniu_bucket: string;
  qiniu_domain: string;
  public_url_prefix: string;
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
  feishu_oauth_redirect_uri: "",
  feishu_bitable_root_folder_token: "",
  feishu_admin_open_id: "",
  feishu_invite_url: "",
  feishu_invite_code: "",
  feishu_bitable_app_token: "",
  feishu_bitable_table_id: "",
  feishu_bitable_image_table_id: "",
  qiniu_access_key: "",
  qiniu_secret_key: "",
  qiniu_bucket: "",
  qiniu_domain: "",
  public_url_prefix: "",
  trending_enabled: "0",
  trending_keywords: "",
  trending_min_likes: "1000",
  trending_account_ids: "",
  comments_fetch_enabled: "0",
};

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

  // 支持 ?tab=global|xhs|douyin|mp|system 直接打开对应 tab（侧边栏「账号管理」入口用）
  const [activeTab, setActiveTab] = useState<string>("global");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && ["global", "xhs", "douyin", "mp", "system"].includes(t)) {
      setActiveTab(t);
    }
  }, []);

  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [platformOverrides, setPlatformOverrides] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const set = (key: keyof Settings, val: string) =>
    setSettings((s) => ({ ...s, [key]: val }));
  const bool = (key: keyof Settings) => settings[key] === "1";
  const toggleBool = (key: keyof Settings) =>
    set(key, settings[key] === "1" ? "0" : "1");


  // ── 平台覆盖 helpers ─────────────────────────────────────────────────────
  const hasPlatformOverride = (platform: PlatformKey) =>
    METRIC_DEFS[platform].some(({ key }) => {
      const { enableKey, threshKey } = metricToFields(key);
      const ovEnable = platformOverrides[`${platform}.${enableKey}`];
      const ovThresh = platformOverrides[`${platform}.${threshKey}`];
      return (ovEnable != null && ovEnable !== "")
        || (ovThresh != null && ovThresh !== "");
    });

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

  const setPlatformOverride = (platform: PlatformKey, key: keyof Settings, val: string) => {
    setPlatformOverrides((m) => ({ ...m, [`${platform}.${key}`]: val }));
  };
  const togglePlatformBool = (platform: PlatformKey, key: keyof Settings) => {
    const cur = platformBool(platform, key);
    setPlatformOverride(platform, key, cur ? "0" : "1");
  };

  const setPlatformInherit = (platform: PlatformKey, inherit: boolean) => {
    if (inherit) {
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
    const s = await fetch(API("/settings"), { headers }).then((r) => r.json());
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
  };

  useEffect(() => { load(); }, [token]);

  const idsCsvToArr = (csv: string): string[] =>
    csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const idsArrToCsv = (arr: string[]): string => arr.join(",");

  const saveSettings = async () => {
    // 此页只保存 user-level + 兜底字段；admin 全局配置（AI / 飞书 App / 七牛 / 检测间隔
    // / 全局阈值 / trending_account_ids 等）已搬到 /dashboard/admin/{ai,feishu,system}，
    // 不再在此处 PUT，避免覆盖用户在独立页修改的最新值。
    const payload: Record<string, any> = {
      // 飞书走应用机器人；企业微信全流程待实现，前端暂不写 webhook_url
      // 用户级 trending 三件套（router 路由到 users 表）
      trending_enabled: bool("trending_enabled"),
      trending_keywords: settings.trending_keywords,
      trending_min_likes: parseInt(settings.trending_min_likes),
      // 全局兜底（admin 用户也只在这里改这些；普通用户改不到）
      likes_alert_enabled: bool("likes_alert_enabled"),
      likes_threshold: parseInt(settings.likes_threshold),
      collects_alert_enabled: bool("collects_alert_enabled"),
      collects_threshold: parseInt(settings.collects_threshold),
      comments_alert_enabled: bool("comments_alert_enabled"),
      comments_threshold: parseInt(settings.comments_threshold),
      ai_rewrite_enabled: bool("ai_rewrite_enabled"),
      feishu_bitable_app_token: settings.feishu_bitable_app_token,
      feishu_bitable_table_id: settings.feishu_bitable_table_id,
      comments_fetch_enabled: bool("comments_fetch_enabled"),
    };
    for (const [k, v] of Object.entries(platformOverrides)) {
      if (v === "" || v == null) {
        payload[k] = "";
        continue;
      }
      if (k.endsWith("_threshold")) {
        const n = parseInt(v);
        payload[k] = Number.isFinite(n) ? n : "";
      } else {
        payload[k] = v === "1";
      }
    }
    await fetch(API("/settings"), {
      method: "PUT", headers, body: JSON.stringify(payload),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // ── 平台 tab 内容：告警阈值（per-platform 覆盖全局）──────────────────────
  // 账号管理已独立到 /dashboard/admin/accounts，平台账号列表不再在此显示。
  const renderPlatformPanel = (platform: PlatformKey) => {
    const inherit = !hasPlatformOverride(platform);
    return (
      <div className="space-y-6">
        {/* Alert thresholds */}
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

  // ── 全局 tab（个人设置）：webhook、告警阈值、飞书多维表格、热门、Prompt ─
  const renderGlobalPanel = () => (
    <div className="space-y-6">
      {/* 套餐 + 用量 + 改密码 */}
      <PlanUsageCard />

      {/* 飞书 OAuth 绑定（推荐，自动建群 + 多维表格） */}
      <FeishuBindingCard />

      {/* 飞书表格写入完成的通知（消息同步专属群，lazy 拉群） */}
      <Card>
        <CardHeader className="font-semibold">飞书消息同步</CardHeader>
        <CardBody>
          <FeishuPushToggle feature="bitable" />
        </CardBody>
      </Card>

      {/* Monitor Groups */}
      <MonitorGroupsCard token={token} />

      {/* Alert Rules */}
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
              {!isAdmin && (
                <p className="text-xs text-default-400">
                  搜索使用平台共享账号池，不消耗你自己的账号。
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {/* Feishu Bitable */}
      <Card>
        <CardHeader className="font-semibold">飞书多维表格同步</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-default-400">
            AI 改写完成后自动同步到飞书多维表格。飞书应用凭据由管理员在「系统配置」中统一配置。
          </p>
          <Input label="Bitable App Token" placeholder="从多维表格 URL 中获取"
            value={settings.feishu_bitable_app_token}
            onValueChange={(v) => set("feishu_bitable_app_token", v)} />
          <Input label="Table ID" placeholder="tbl..."
            value={settings.feishu_bitable_table_id}
            onValueChange={(v) => set("feishu_bitable_table_id", v)} />
        </CardBody>
      </Card>

      {/* Monitor advanced */}
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

      {/* v2: 自带 AI 渠道已下线 —— AI 全走平台统一渠道，按点数计费 */}

      {/* P15: AI 模型偏好（用户级） */}
      <AiPreferencesCard token={token} />

      {/* Prompt Templates */}
      <PromptTemplatesCard token={token} />

      <Button color="primary" startContent={<Save size={16} />} onPress={saveSettings}>
        {saved ? "已保存 ✓" : "保存设置"}
      </Button>
    </div>
  );

  // ── 系统配置 tab（仅管理员）：AI、检测间隔、账号管理、商品图 API ──────────

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">监控设置</h1>

      <Tabs aria-label="settings sections" selectedKey={activeTab} onSelectionChange={(k) => setActiveTab(String(k))}>
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

    </div>
  );
}
