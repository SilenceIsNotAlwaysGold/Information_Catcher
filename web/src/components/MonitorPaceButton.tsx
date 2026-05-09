"use client";

/**
 * 监控帖子频率配置按钮（按钮 + Modal）。
 *
 * 用于 xhs/posts、douyin/posts、mp/posts 三个监控帖子页右上角，
 * 点开后编辑当前用户的：
 *   - 监控帖子轮询频率（monitor_interval_minutes）
 *
 * 0 = 跟随系统全局基线（admin 设的 check_interval_minutes）
 * > 0 = 用户自定义间隔（最小值 = 系统基线，最大 1440）
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@nextui-org/button";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Input } from "@nextui-org/input";
import { Clock, Save } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/monitor${p}`;

export function MonitorPaceButton() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const modal = useDisclosure();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [monitorInterval, setMonitorInterval] = useState<string>("0");
  const [globalInterval, setGlobalInterval] = useState<string>("30");

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/settings"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setMonitorInterval(String(d.monitor_interval_minutes ?? 0));
      setGlobalInterval(String(d.check_interval_minutes || 30));
    } catch (e: any) {
      toastErr(`读取设置失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (modal.isOpen) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.isOpen]);

  const save = async () => {
    setSaving(true);
    try {
      const baseline = Math.max(1, parseInt(globalInterval, 10) || 30);
      const n = parseInt(monitorInterval || "0", 10);
      const value = !n || n <= 0 ? 0 : Math.max(baseline, Math.min(1440, n));
      const r = await fetch(API("/settings"), {
        method: "PUT",
        headers,
        body: JSON.stringify({ monitor_interval_minutes: value }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || `保存失败 (HTTP ${r.status})`);
        return;
      }
      toastOk(
        value === 0
          ? "已恢复跟随系统频率"
          : `监控频率已设为每 ${value} 分钟`,
      );
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
        startContent={<Clock size={15} />}
        onPress={modal.onOpen}
      >
        监控频率
      </Button>

      <Modal isOpen={modal.isOpen} onClose={modal.onClose} size="md">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <Clock size={18} />
            监控帖子频率
          </ModalHeader>
          <ModalBody className="space-y-3">
            <p className="text-xs text-default-500 leading-relaxed">
              控制系统多久检测一次你的所有监控帖子（点赞 / 收藏 / 评论增量 + 推送告警）。
              填 <code>0</code> 跟随系统基线（当前 <b>{globalInterval}</b> 分钟）；
              填正数表示你希望多久跑一次。
            </p>
            <Input
              label="监控帖子频率（分钟）"
              labelPlacement="outside"
              type="number"
              min={0}
              max={1440}
              value={monitorInterval}
              onValueChange={setMonitorInterval}
              isDisabled={loading}
              description={
                `范围 0-1440（最小值会被自动 clamp 到系统基线 ${globalInterval} 分钟，` +
                `因为系统全局调度按基线 tick）。调高频率可减少风控触发风险。`
              }
            />
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
