"use client";

/**
 * /dashboard/admin/system —— 通用系统配置（admin only）
 *
 * 包含：
 *   - 检测频率 / 日报时间
 *   - 全局告警阈值（fallback；用户可在分组里覆盖）
 *   - 七牛云 / 本地存储 / 商品图历史飞书表
 *   - trending 共享账号池
 *   - 第三方数据源（newrank）
 */
import { useState, useEffect } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Input } from "@nextui-org/input";
import { Switch } from "@nextui-org/switch";
import { Button } from "@nextui-org/button";
import { Divider } from "@nextui-org/divider";
import { Save, Settings, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import { useAdminSettings } from "@/lib/useAdminSettings";

const METRIC_DEFS = [
  { key: "likes",    label: "点赞量告警", desc: "单次检测点赞增量超过阈值时推送", unit: "次" },
  { key: "collects", label: "收藏量告警", desc: "单次检测收藏增量超过阈值时推送", unit: "次" },
  { key: "comments", label: "评论告警",   desc: "单次检测新增评论超过阈值时推送", unit: "条" },
] as const;

export default function AdminSystemPage() {
  useAuth();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const { settings, loading, saving, saveSubset } = useAdminSettings();

  const [interval, setInterval] = useState("30");
  const [reportEnabled, setReportEnabled] = useState(true);
  const [reportTime, setReportTime] = useState("09:00");
  const [thresholds, setThresholds] = useState<Record<string, { enabled: boolean; value: string }>>({
    likes: { enabled: true, value: "50" },
    collects: { enabled: true, value: "50" },
    comments: { enabled: true, value: "1" },
  });
  const [qiniuAk, setQiniuAk] = useState("");
  const [qiniuSk, setQiniuSk] = useState("");
  const [qiniuBucket, setQiniuBucket] = useState("");
  const [qiniuDomain, setQiniuDomain] = useState("");
  const [publicUrlPrefix, setPublicUrlPrefix] = useState("");
  const [bitableAppToken, setBitableAppToken] = useState("");
  const [imageTableId, setImageTableId] = useState("");
  const [trendingAccountIds, setTrendingAccountIds] = useState("");
  const [newrankKey, setNewrankKey] = useState("");
  const [newrankBase, setNewrankBase] = useState("");

  useEffect(() => {
    if (!loading) {
      setInterval(settings.check_interval_minutes || "30");
      setReportEnabled(settings.daily_report_enabled === "1" || settings.daily_report_enabled === true);
      setReportTime(settings.daily_report_time || "09:00");
      setThresholds({
        likes:    { enabled: settings.likes_alert_enabled === "1",    value: settings.likes_threshold || "50" },
        collects: { enabled: settings.collects_alert_enabled === "1", value: settings.collects_threshold || "50" },
        comments: { enabled: settings.comments_alert_enabled === "1", value: settings.comments_threshold || "1" },
      });
      setQiniuAk(settings.qiniu_access_key || "");
      setQiniuSk(settings.qiniu_secret_key || "");
      setQiniuBucket(settings.qiniu_bucket || "");
      setQiniuDomain(settings.qiniu_domain || "");
      setPublicUrlPrefix(settings.public_url_prefix || "");
      setBitableAppToken(settings.feishu_bitable_app_token || "");
      setImageTableId(settings.feishu_bitable_image_table_id || "");
      setTrendingAccountIds(settings.trending_account_ids || "");
      setNewrankKey(settings.newrank_api_key || "");
      setNewrankBase(settings.newrank_api_base || "https://api.newrank.cn");
    }
  }, [loading, settings]);

  if (!isAdmin && me) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardBody className="flex flex-row gap-2 items-center text-sm text-warning">
            <AlertCircle size={16} /> 仅管理员可访问
          </CardBody>
        </Card>
      </div>
    );
  }

  const handleSave = () =>
    saveSubset({
      check_interval_minutes: parseInt(interval) || 30,
      daily_report_enabled: reportEnabled,
      daily_report_time: reportTime,
      likes_alert_enabled: thresholds.likes.enabled,
      likes_threshold: parseInt(thresholds.likes.value) || 50,
      collects_alert_enabled: thresholds.collects.enabled,
      collects_threshold: parseInt(thresholds.collects.value) || 50,
      comments_alert_enabled: thresholds.comments.enabled,
      comments_threshold: parseInt(thresholds.comments.value) || 1,
      qiniu_access_key: qiniuAk.trim(),
      qiniu_secret_key: qiniuSk.trim(),
      qiniu_bucket: qiniuBucket.trim(),
      qiniu_domain: qiniuDomain.trim(),
      public_url_prefix: publicUrlPrefix.trim(),
      feishu_bitable_app_token: bitableAppToken.trim(),
      feishu_bitable_image_table_id: imageTableId.trim(),
      trending_account_ids: trendingAccountIds.trim(),
      newrank_api_key: newrankKey.trim(),
      newrank_api_base: newrankBase.trim() || "https://api.newrank.cn",
    }, "系统配置已保存");

  const updateThreshold = (key: "likes" | "collects" | "comments", patch: Partial<{ enabled: boolean; value: string }>) =>
    setThresholds((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings size={22} />
          通用系统配置
        </h1>
        <p className="text-sm text-default-500 mt-1">
          检测频率、全局阈值、存储后端、第三方数据源。所有用户共享。
        </p>
      </div>

      <Card>
        <CardHeader className="font-semibold">检测频率 & 日报</CardHeader>
        <CardBody className="space-y-4">
          <Input
            type="number"
            label="检测间隔（分钟）"
            labelPlacement="outside"
            min={1}
            value={interval}
            onValueChange={setInterval}
            isDisabled={loading}
            description="所有平台监控帖子统一节奏。建议 ≥ 15 分钟避免风控。"
          />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">每日数据日报</p>
              <p className="text-xs text-default-400">每天定时把所有监控帖子的数据汇总推送给各租户。</p>
            </div>
            <Switch isSelected={reportEnabled} onValueChange={setReportEnabled} isDisabled={loading} />
          </div>
          {reportEnabled && (
            <Input
              type="time"
              label="日报时间"
              labelPlacement="outside"
              value={reportTime}
              onValueChange={setReportTime}
              isDisabled={loading}
              className="max-w-[200px]"
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">全局告警阈值（兜底）</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-default-400">
            未在分组里覆盖的帖子用此处阈值。每个用户可在自己的分组里设独立阈值。
          </p>
          {METRIC_DEFS.map((m, i) => (
            <div key={m.key}>
              {i > 0 && <Divider className="mb-4" />}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">{m.label}</p>
                    <p className="text-xs text-default-400">{m.desc}</p>
                  </div>
                  <Switch
                    isSelected={thresholds[m.key].enabled}
                    onValueChange={(v) => updateThreshold(m.key, { enabled: v })}
                    isDisabled={loading}
                    color="primary"
                  />
                </div>
                {thresholds[m.key].enabled && (
                  <Input
                    size="sm"
                    type="number"
                    label="触发阈值"
                    labelPlacement="outside"
                    value={thresholds[m.key].value}
                    onValueChange={(v) => updateThreshold(m.key, { value: v })}
                    isDisabled={loading}
                    endContent={<span className="text-xs text-default-400">{m.unit}</span>}
                    className="max-w-[240px]"
                  />
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">商品图存储（七牛 / 本地二选一）</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-default-400 leading-relaxed">
            商品图工具生成的图片需要公网 URL 才能写入飞书。优先七牛，回落本地。
            没备案域名直接用本地（部署服务器自身的公网 IP/HTTPS）。
          </p>
          <Input
            label="本地存储公网前缀"
            labelPlacement="outside"
            placeholder="https://my-server.com:8003"
            value={publicUrlPrefix}
            onValueChange={setPublicUrlPrefix}
            isDisabled={loading}
            description="留空则禁用本地存储。结尾不带 /；图片通过 /static/images/* 暴露。"
          />
          <Divider />
          <p className="text-xs text-default-400">下面是七牛云配置（可选，备案域名稳定方案）</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Access Key"  labelPlacement="outside" value={qiniuAk}     onValueChange={setQiniuAk}     isDisabled={loading} />
            <Input label="Secret Key"  labelPlacement="outside" type="password"     value={qiniuSk}     onValueChange={setQiniuSk}     isDisabled={loading} />
            <Input label="Bucket"      labelPlacement="outside" value={qiniuBucket} onValueChange={setQiniuBucket} isDisabled={loading} />
            <Input label="加速域名"    labelPlacement="outside" placeholder="img.example.com" value={qiniuDomain} onValueChange={setQiniuDomain} isDisabled={loading} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">飞书多维表格（admin 兜底）</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-default-400">
            用户绑定飞书后系统会为每人自动建表，这里是 admin 维护的<strong>全局兜底表</strong>，
            供未绑定用户使用。新部署一般留空即可。
          </p>
          <Input
            label="App Token（兜底表）"
            labelPlacement="outside"
            placeholder="bascn... / NzeAbqAFXa..."
            value={bitableAppToken}
            onValueChange={setBitableAppToken}
            isDisabled={loading}
          />
          <Input
            label="商品图历史 Table ID"
            labelPlacement="outside"
            placeholder="tbl..."
            value={imageTableId}
            onValueChange={setImageTableId}
            isDisabled={loading}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">热门抓取账号池</CardHeader>
        <CardBody className="space-y-3">
          <Input
            label="trending_account_ids"
            labelPlacement="outside"
            placeholder="1,3,7（共享池中专用于 trending 抓取的账号 ID，逗号分隔）"
            value={trendingAccountIds}
            onValueChange={setTrendingAccountIds}
            isDisabled={loading}
            description="留空则用所有 active 共享账号轮询。"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">第三方数据源（公众号阅读数）</CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs text-default-400">
            可选。配上后公众号文章可以从新榜拿到真实阅读数（需付费授权）。留空则用客户端凭证方案。
          </p>
          <Input label="新榜 API Base" labelPlacement="outside" value={newrankBase} onValueChange={setNewrankBase} isDisabled={loading} />
          <Input label="新榜 API Key"  labelPlacement="outside" type="password"     value={newrankKey}  onValueChange={setNewrankKey}  isDisabled={loading} />
        </CardBody>
      </Card>

      <div className="flex justify-end pb-12">
        <Button color="primary" startContent={<Save size={16} />} isLoading={saving} onPress={handleSave}>
          保存
        </Button>
      </div>
    </div>
  );
}
