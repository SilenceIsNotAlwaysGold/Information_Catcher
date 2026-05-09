"use client";

/**
 * 统一的「推送到飞书 + 重建群」组件，用于 creator / bitable 两个 feature
 * （trending 已在 TrendingSettingsButton modal 内联实现）。
 *
 * 用法：
 *   <FeishuPushToggle feature="creator" platform="xhs" />
 *   <FeishuPushToggle feature="bitable" />     // bitable 不分平台
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@nextui-org/button";
import { Switch } from "@nextui-org/switch";
import { Bell } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const PLATFORM_LABEL: Record<string, string> = {
  xhs: "小红书", douyin: "抖音", mp: "公众号",
};

const FEATURE_LABEL: Record<string, string> = {
  creator: "博主追新",
  bitable: "消息同步",
};

type Props = {
  feature: "creator" | "bitable";
  platform?: "xhs" | "douyin" | "mp";   // creator 必传，bitable 不传
  /** 紧凑模式：去掉描述文字，只保留开关；默认 false（带描述） */
  compact?: boolean;
};

export function FeishuPushToggle({ feature, platform, compact = false }: Props) {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [enabled, setEnabled] = useState(false);
  const [chatMapRaw, setChatMapRaw] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch("/api/monitor/settings", { headers });
      if (!r.ok) return;
      const d = await r.json();
      setEnabled(d[`${feature}_push_enabled`] === "1" || d[`${feature}_push_enabled`] === true);
      setChatMapRaw(d[`${feature}_chat_id`] || "");
    } finally { setLoading(false); }
  }, [token, headers, feature]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    try {
      const r = await fetch("/api/monitor/settings", {
        method: "PUT", headers,
        body: JSON.stringify({ [`${feature}_push_enabled`]: next }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || `保存失败 (HTTP ${r.status})`);
        setEnabled(!next);  // 回滚
      } else {
        toastOk(next ? "已开启飞书推送，下一条数据会自动建群" : "已关闭飞书推送（群保留）");
      }
    } finally { setSaving(false); }
  };

  const handleRebuild = async () => {
    if (!confirm(`重建后旧群保留但不再发新消息，新群从下一条数据开始接收。确认？`)) return;
    setRebuilding(true);
    try {
      const url = feature === "creator"
        ? `/api/feishu/feature-chat/creator/recreate?platform=${platform}`
        : `/api/feishu/feature-chat/bitable/recreate`;
      const r = await fetch(url, { method: "POST", headers });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(d.detail || `HTTP ${r.status}`); return; }
      toastOk("已重建专属群");
      await load();
    } finally { setRebuilding(false); }
  };

  // 解析当前是否已有专属群
  let hasChat = false;
  if (feature === "creator" && platform) {
    try {
      const m = chatMapRaw ? JSON.parse(chatMapRaw) : {};
      hasChat = !!m[platform];
    } catch {}
  } else if (feature === "bitable") {
    hasChat = !!chatMapRaw;
  }

  const featureLabel = FEATURE_LABEL[feature];
  const platformLabel = platform ? PLATFORM_LABEL[platform] : "";
  const groupNameHint = feature === "creator"
    ? `TrendPulse ${platformLabel} ${featureLabel} - 你的用户名`
    : `TrendPulse ${featureLabel} - 你的用户名`;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <Bell size={14} className="text-default-400" />
        <span className="text-xs text-default-600">飞书推送</span>
        <Switch
          isSelected={enabled} onValueChange={handleToggle}
          size="sm" isDisabled={loading || saving} color="primary"
        />
        {enabled && hasChat && (
          <Button size="sm" variant="light" isDisabled={rebuilding} onPress={handleRebuild}>
            重建群
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="border border-divider rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium flex items-center gap-2">
            <Bell size={14} className="text-default-500" />
            {featureLabel}{platformLabel ? `（${platformLabel}）` : ""}飞书推送
          </p>
          <p className="text-xs text-default-400 mt-0.5">
            打开后第一条数据会自动建专属群「{groupNameHint}」；关闭后停止推送但群保留。
          </p>
        </div>
        <Switch
          isSelected={enabled} onValueChange={handleToggle}
          isDisabled={loading || saving} color="primary"
        />
      </div>
      {enabled && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-default-500">
            {hasChat ? "✅ 群已建好，下次有新数据会推送" : "⏳ 还未建群，首次有新数据时自动建"}
          </span>
          {hasChat && (
            <Button size="sm" variant="flat" isDisabled={rebuilding} onPress={handleRebuild}>
              重建群
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
