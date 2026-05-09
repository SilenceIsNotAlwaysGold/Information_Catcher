"use client";

/**
 * 热门内容监控设置按钮（按钮 + Modal）。
 *
 * 用于 xhs/trending、douyin/trending 页右上角，点开后编辑当前用户的：
 *  - 是否启用关键词搜索（trending_enabled）
 *  - 关键词列表（trending_keywords，逗号分隔）
 *  - 最低点赞阈值（trending_min_likes）
 *
 * 这三个字段已经改为 per-user 存在 users 表里。后端通过 /api/monitor/settings
 * GET / PUT 接收，写入 auth_service.update_user_trending。
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@nextui-org/button";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Input, Textarea } from "@nextui-org/input";
import { Switch } from "@nextui-org/switch";
import { Settings as SettingsIcon, Save } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/monitor${p}`;

export function TrendingSettingsButton() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const modal = useDisclosure();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [keywords, setKeywords] = useState("");
  const [minLikes, setMinLikes] = useState<string>("1000");
  const [maxPerKeyword, setMaxPerKeyword] = useState<string>("30");
  const [monitorInterval, setMonitorInterval] = useState<string>("0");
  const [trendingInterval, setTrendingInterval] = useState<string>("0");
  const [globalInterval, setGlobalInterval] = useState<string>("30");

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/settings"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setEnabled(d.trending_enabled === "1" || d.trending_enabled === true);
      setKeywords(d.trending_keywords || "");
      setMinLikes(String(d.trending_min_likes || 1000));
      setMaxPerKeyword(String(d.trending_max_per_keyword || 30));
      setMonitorInterval(String(d.monitor_interval_minutes ?? 0));
      setTrendingInterval(String(d.trending_interval_minutes ?? 0));
      setGlobalInterval(String(d.check_interval_minutes || 30));
    } catch (e: any) {
      toastErr(`读取设置失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  // 打开 modal 时拉一次最新数据
  useEffect(() => {
    if (modal.isOpen) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.isOpen]);

  const save = async () => {
    setSaving(true);
    try {
      // 抓取频率：0 = 跟全局；>0 必须 ≥ 全局基线（admin 设的 check_interval_minutes）
      const baseline = Math.max(1, parseInt(globalInterval, 10) || 30);
      const clampInterval = (raw: string) => {
        const n = parseInt(raw || "0", 10);
        if (!n || n <= 0) return 0;
        return Math.max(baseline, Math.min(1440, n));
      };
      const payload: Record<string, any> = {
        trending_enabled: enabled,
        trending_keywords: keywords.trim(),
        trending_min_likes: Math.max(1, parseInt(minLikes || "1000")),
        trending_max_per_keyword: Math.max(
          1,
          Math.min(200, parseInt(maxPerKeyword || "30") || 30),
        ),
        monitor_interval_minutes: clampInterval(monitorInterval),
        trending_interval_minutes: clampInterval(trendingInterval),
      };
      const r = await fetch(API("/settings"), {
        method: "PUT", headers, body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || `保存失败 (HTTP ${r.status})`);
        return;
      }
      toastOk("热门监控设置已保存");
      modal.onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="flat"
        size="sm"
        startContent={<SettingsIcon size={15} />}
        onPress={modal.onOpen}
      >
        监控设置
      </Button>

      <Modal isOpen={modal.isOpen} onClose={modal.onClose} size="lg">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <SettingsIcon size={18} />
            热门内容监控设置
          </ModalHeader>
          <ModalBody className="space-y-4">
            <p className="text-xs text-default-400">
              这些设置只影响你自己的热门池：你的关键词、你的阈值、你的抓取触发。
              抓取通过你自己的浏览器扩展执行（请先安装 TrendPulse Helper 并登录平台）。
            </p>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">启用关键词搜索</p>
                <p className="text-xs text-default-400">
                  关闭后定时任务跳过你；你仍可手动「立即抓取」。
                </p>
              </div>
              <Switch
                isSelected={enabled}
                onValueChange={setEnabled}
                isDisabled={loading}
                color="primary"
              />
            </div>

            <Textarea
              label="关键词列表"
              labelPlacement="outside"
              placeholder="多个用英文逗号分隔，例：护肤精华, 口红, 咖啡机"
              minRows={2}
              value={keywords}
              onValueChange={setKeywords}
              isDisabled={loading}
              description="每个关键词会单独跑一次搜索"
            />

            <Input
              label="最低点赞阈值"
              labelPlacement="outside"
              type="number"
              min={1}
              value={minLikes}
              onValueChange={setMinLikes}
              isDisabled={loading}
              description="点赞数低于该值的帖子直接过滤掉"
            />

            <Input
              label="单关键词单次抓取数量"
              labelPlacement="outside"
              type="number"
              min={1}
              max={200}
              value={maxPerKeyword}
              onValueChange={setMaxPerKeyword}
              isDisabled={loading}
              description="每个关键词每次定时任务抓多少篇（1-200，默认 30；浏览器单次最多约 100，超过会按页数 cap）"
            />

            <div className="border-t border-divider pt-3 space-y-3">
              <p className="text-sm font-medium text-default-700">
                抓取频率（分钟）
              </p>
              <p className="text-xs text-default-400 -mt-2">
                填 <code>0</code> 跟随系统基线（当前 <b>{globalInterval}</b> 分钟）；
                填正数表示你希望多久跑一次（最小值 = 系统基线，最大 1440）。调高频率可减少风控触发。
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="监控帖子频率"
                  labelPlacement="outside"
                  type="number"
                  min={0}
                  max={1440}
                  value={monitorInterval}
                  onValueChange={setMonitorInterval}
                  isDisabled={loading}
                  description="0 = 跟随系统"
                />
                <Input
                  label="热门抓取频率"
                  labelPlacement="outside"
                  type="number"
                  min={0}
                  max={1440}
                  value={trendingInterval}
                  onValueChange={setTrendingInterval}
                  isDisabled={loading}
                  description="0 = 跟随系统"
                />
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={modal.onClose} isDisabled={saving}>
              取消
            </Button>
            <Button
              color="primary"
              startContent={<Save size={15} />}
              onPress={save}
              isLoading={saving}
              isDisabled={loading}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
