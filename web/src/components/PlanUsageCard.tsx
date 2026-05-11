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
  total_image_gen: Usage;     // 账户累计生图（不重置）
  daily_text_gen: Usage;      // 每日写文（0 点重置）
  daily_image_gen?: Usage;    // deprecated 别名
  daily_remix_sets?: Usage;   // deprecated
};

const PLAN_LABEL: Record<string, string> = {
  trial: "试用", free: "免费版", pro: "专业版",
  team: "团队版", enterprise: "企业版",
};

const PLAN_COLOR: Record<string, "warning" | "default" | "primary" | "secondary" | "success"> = {
  trial: "warning", free: "default", pro: "primary",
  team: "secondary", enterprise: "success",
};

// 配额体系：
//   - 图：账户**累计**额度（用完为止，不重置）→ total_image_gen
//   - 文：每日重置                              → daily_text_gen
type ItemKey = keyof Omit<UsageSummary, "plan" | "daily_image_gen" | "daily_remix_sets">;
type ItemDef = { key: ItemKey; label: string; suffix: string; hint?: string };

// 账号资源：长期累计（监控帖子、已绑账号）
const ACCOUNT_ITEMS: ItemDef[] = [
  { key: "monitor_posts", label: "监控帖子", suffix: "帖",
    hint: "已加入监控的小红书 / 抖音 / 公众号 帖子总数" },
  { key: "accounts",      label: "已绑平台账号", suffix: "个",
    hint: "绑到 Pulse 的小红书 / 抖音 / 公众号 cookie 账号数。爬虫用这些账号拿真实数据" },
];
// AI 用量：图按账户累计；文按每日重置
const AI_IMAGE: ItemDef[] = [
  { key: "total_image_gen", label: "累计生图", suffix: "张",
    hint: "商品图 / 作品仿写 / 文字仿写 三个工具产生的图片合计。账户累计、不重置，用完为止" },
];
const AI_TEXT: ItemDef[] = [
  { key: "daily_text_gen",  label: "今日写文", suffix: "篇",
    hint: "作品仿写每套 1 篇文案；其他 AI 写文场景未来也并入这里。每日 0 点重置" },
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

  // 单行 usage 渲染（账号资源 + AI 用量两组共用）
  const renderUsageRow = (it: ItemDef, u: Usage) => {
    const unlimited = u.quota < 0;
    const pct = usagePct(u);
    const color = usageColor(pct, unlimited);
    return (
      <div key={it.key}>
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-default-700 flex items-center gap-1.5">
            {it.label}
            {it.hint && (
              <span title={it.hint} className="text-default-400 cursor-help text-xs">
                ⓘ
              </span>
            )}
          </span>
          <span className="text-default-500 tabular-nums">
            {unlimited
              ? `${u.used} / ∞`
              : `${u.used} / ${u.quota} ${it.suffix}`}
          </span>
        </div>
        <div className="w-full h-1.5 bg-default-200 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${
              color === "danger" ? "bg-danger" :
              color === "warning" ? "bg-warning" :
              color === "success" ? "bg-success" :
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
        <CardBody className="space-y-4">
          {/* 账号资源（长期累计） */}
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-wider text-default-400 font-semibold">
              账号资源
            </p>
            {ACCOUNT_ITEMS.map((it) => renderUsageRow(it, usage[it.key]))}
          </div>

          {/* AI 用量：图配额账户累计 + 文配额每日重置 */}
          <div className="space-y-3 border-t border-divider pt-3">
            <p className="text-xs uppercase tracking-wider text-secondary font-semibold">
              AI 用量
            </p>
            {AI_IMAGE.map((it) => {
              const u = usage[it.key];
              return (
                <div key={it.key}>
                  {renderUsageRow(it, u)}
                  <p className="text-[10px] text-default-400 mt-0.5 pl-0.5">
                    账户累计配额，用完联系管理员加额度（不每日重置）
                  </p>
                </div>
              );
            })}
            {AI_TEXT.map((it) => {
              const u = usage[it.key];
              return (
                <div key={it.key}>
                  {renderUsageRow(it, u)}
                  <p className="text-[10px] text-default-400 mt-0.5 pl-0.5">
                    每日 0 点重置
                  </p>
                </div>
              );
            })}
          </div>

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
