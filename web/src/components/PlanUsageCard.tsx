"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Crown, Lock, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr, toastOk } from "@/lib/toast";

type Usage = {
  used: number;
  quota: number;
};

type UsageSummary = {
  plan: string;
  monitor_posts: Usage;
  accounts: Usage;
  daily_image_gen: Usage;
  daily_text_gen: Usage;
  daily_remix_sets?: Usage;  // deprecated
};

const PLAN_LABEL: Record<string, string> = {
  trial: "试用", free: "免费版", pro: "专业版",
  team: "团队版", enterprise: "企业版",
};

const PLAN_COLOR: Record<string, "warning" | "default" | "primary" | "secondary" | "success"> = {
  trial: "warning", free: "default", pro: "primary",
  team: "secondary", enterprise: "success",
};

// 图 / 文 配额分轨：所有使用模型的板块都按这两个 key 累计
//   - daily_image_gen：商品图自创 + 作品仿写换图 + 文字仿写印字 → 任何生图调用
//   - daily_text_gen：作品仿写文案 → 任何 AI 文本生成
const ITEMS: { key: keyof Omit<UsageSummary, "plan" | "daily_remix_sets">; label: string; suffix: string }[] = [
  { key: "monitor_posts",    label: "监控帖子",  suffix: "帖" },
  { key: "accounts",         label: "账号池",    suffix: "个" },
  { key: "daily_image_gen",  label: "今日生图",  suffix: "张" },
  { key: "daily_text_gen",   label: "今日写文",  suffix: "篇" },
];

export function PlanUsageCard() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const [usageR, meR] = await Promise.all([
        fetch("/api/auth/me/usage", { headers }),
        fetch("/api/auth/me", { headers }),
      ]);
      if (usageR.ok) setUsage(await usageR.json());
      if (meR.ok) {
        const me = await meR.json();
        setTrialEndsAt(me?.trial_ends_at || null);
      }
    } catch {}
  }, [token, headers]);

  useEffect(() => { reload(); }, [reload]);

  // 改密码
  const pwdModal = useDisclosure();
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const handleChangePwd = async () => {
    if (newPwd.length < 6) { toastErr("新密码至少 6 位"); return; }
    if (newPwd !== confirmPwd) { toastErr("两次输入的新密码不一致"); return; }
    try {
      const r = await fetch("/api/auth/me/change-password", {
        method: "POST", headers,
        body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(data?.detail || `HTTP ${r.status}`); return; }
      toastOk("密码已更新");
      setOldPwd(""); setNewPwd(""); setConfirmPwd("");
      pwdModal.onClose();
    } catch (e: any) { toastErr(`修改失败：${e?.message || e}`); }
  };

  if (!usage) {
    return (
      <Card>
        <CardBody className="text-sm text-default-500">加载套餐 / 用量中…</CardBody>
      </Card>
    );
  }

  const plan = usage.plan;

  // 试用倒计时（如果是试用 + 有截止）
  let trialDays: number | null = null;
  if (plan === "trial" && trialEndsAt) {
    try {
      const ms = new Date(trialEndsAt).getTime() - Date.now();
      if (ms > 0) trialDays = Math.ceil(ms / 86400000);
    } catch {}
  }

  const usagePct = (u: Usage): number => {
    if (u.quota < 0) return 0;
    if (u.quota === 0) return 100;
    return Math.min(100, Math.round(u.used * 100 / u.quota));
  };

  const usageColor = (pct: number, unlimited: boolean) => {
    if (unlimited) return "success";
    if (pct >= 90) return "danger";
    if (pct >= 70) return "warning";
    return "primary";
  };

  return (
    <>
      <Card>
        <CardHeader className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Crown size={18} className="text-secondary" />
            <span className="font-semibold">我的套餐 + 用量</span>
            <Chip size="sm" color={PLAN_COLOR[plan] || "default"} variant="flat">
              {PLAN_LABEL[plan] || plan}
            </Chip>
            {trialDays !== null && (
              <Chip size="sm" variant="flat" color="warning">
                还剩 {trialDays} 天
              </Chip>
            )}
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<Lock size={14} />}
            onPress={pwdModal.onOpen}
          >
            修改密码
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          {ITEMS.map((it) => {
            const u = usage[it.key];
            const unlimited = u.quota < 0;
            const pct = usagePct(u);
            return (
              <div key={it.key}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-default-700">{it.label}</span>
                  <span className="text-default-500">
                    {unlimited
                      ? `${u.used} / ∞`
                      : `${u.used} / ${u.quota} ${it.suffix}`}
                  </span>
                </div>
                {/* 原生进度条：避免 @nextui-org/progress 子包 tree-shaking 问题 */}
                <div className="w-full h-1.5 bg-default-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      usageColor(pct, unlimited) === "danger" ? "bg-danger" :
                      usageColor(pct, unlimited) === "warning" ? "bg-warning" :
                      usageColor(pct, unlimited) === "success" ? "bg-success" :
                      "bg-primary"
                    }`}
                    style={{ width: unlimited ? "100%" : `${pct}%` }}
                  />
                </div>
                {!unlimited && pct >= 80 && (
                  <p className="text-xs text-warning-600 mt-1 flex items-center gap-1">
                    <AlertCircle size={12} />
                    用量已达 {pct}%，接近配额上限
                  </p>
                )}
              </div>
            );
          })}
          {plan === "trial" && (
            <div className="flex items-start gap-2 text-xs bg-warning/10 rounded-md p-2 mt-2">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-warning-600" />
              <span className="text-default-600">
                试用期到期后会自动降级到「免费版」，监控帖子上限会从 50 降到 20。
                如需继续高额度使用，请联系管理员升级。
              </span>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal isOpen={pwdModal.isOpen} onClose={pwdModal.onClose}>
        <ModalContent>
          <ModalHeader>修改密码</ModalHeader>
          <ModalBody className="space-y-3">
            <Input label="当前密码" type="password" value={oldPwd} onValueChange={setOldPwd} isRequired />
            <Input label="新密码" type="password" value={newPwd} onValueChange={setNewPwd}
              description="至少 6 位" isRequired />
            <Input label="确认新密码" type="password" value={confirmPwd} onValueChange={setConfirmPwd} isRequired />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={pwdModal.onClose}>取消</Button>
            <Button color="primary" onPress={handleChangePwd}
              isDisabled={!oldPwd || !newPwd || !confirmPwd}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
