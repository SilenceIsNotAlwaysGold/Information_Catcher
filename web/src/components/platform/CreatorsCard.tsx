"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Input } from "@nextui-org/input";
import { Tooltip } from "@nextui-org/tooltip";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Plus, RefreshCw, X, Settings, Bell, BellOff } from "lucide-react";
import { Switch } from "@nextui-org/switch";
import { useAuth } from "@/contexts/AuthContext";
import { CreatorRow, PlatformKey, PLATFORM_LABEL } from "./types";
import { toastOk, toastErr, toastInfo } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";
import { FeishuPushToggle } from "@/components/FeishuPushToggle";

/**
 * 通用「博主追新」卡片组件，三个平台共用。
 *
 * v2：
 * - chip 颜色按 last_check_status 区分（ok=绿 / no_account=橙 / cookie_invalid=红 / error=黄）
 * - chip 显示未读数 (unread_count)，按"未读 + 最近发帖"排序（后端已排）
 * - tooltip 展示上次检查时间 / 状态 / 错误说明
 * - 列表展示后自动调 POST /creators/seen 清零未读（避免反复显示）
 */
export function CreatorsCard({ platform }: { platform: PlatformKey }) {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [creators, setCreators] = useState<CreatorRow[]>([]);
  const [loading, setLoading] = useState(true);
  // 用 ref 记录已经"标记已读"过的 creator id，避免每次 setState 又触发重复 POST
  const seenIdsRef = useRef<Set<number>>(new Set());

  const followModal = useDisclosure();
  const [followInput, setFollowInput] = useState("");
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState("");
  const [followResult, setFollowResult] = useState<{ added: number; fetched: number } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/monitor/creators`, { headers });
      if (r.ok) {
        const d = await r.json();
        const list = ((d.creators || []) as CreatorRow[]).filter(
          (c) => c.platform === platform,
        );
        setCreators(list);

        // 该平台下"有未读且本次会话还没标记过"的 creator → 一次性 POST 清零
        const toMark = list
          .filter((c) => (c.unread_count || 0) > 0 && !seenIdsRef.current.has(c.id))
          .map((c) => c.id);
        if (toMark.length) {
          toMark.forEach((id) => seenIdsRef.current.add(id));
          // fire-and-forget
          fetch(`/api/monitor/creators/seen`, {
            method: "POST", headers,
            body: JSON.stringify({ creator_ids: toMark }),
          }).catch(() => {});
        }
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (token) load(); }, [token, platform]);

  const submitFollow = async () => {
    setFollowError(""); setFollowResult(null);
    if (!followInput.trim()) {
      setFollowError(platform === "mp" ? "请输入公众号名称" : "请输入博主主页 URL");
      return;
    }
    setFollowBusy(true);
    try {
      const r = await fetch(`/api/monitor/creators`, {
        method: "POST", headers,
        body: JSON.stringify({
          creator_url: followInput.trim(),
          creator_name: followInput.trim(),
          platform,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setFollowError(j.detail || "添加失败");
        return;
      }
      const d = await r.json();
      const c = await fetch(`/api/monitor/creators/${d.id}/check`, {
        method: "POST", headers,
      });
      if (c.ok) {
        const cd = await c.json();
        setFollowResult({ added: cd.added || 0, fetched: cd.fetched || 0 });
        // 0 帖 + warning：温和提示用户加 cookie，订阅本身已成功
        if ((cd.fetched || 0) === 0 && cd.warning) {
          setFollowError(cd.warning);
        }
      } else {
        const j = await c.json().catch(() => ({}));
        setFollowError(j.detail || "");
      }
      setFollowInput("");
      await load();
    } catch (e: any) {
      setFollowError(e.message || "失败");
    } finally {
      setFollowBusy(false);
    }
  };

  const unfollow = async (cid: number) => {
    const ok = await confirmDialog({
      title: "取消订阅",
      content: "取消订阅这个博主？已抓到的帖子会保留",
      confirmText: "取消订阅",
      cancelText: "保留",
      danger: true,
    });
    if (!ok) return;
    await fetch(`/api/monitor/creators/${cid}`, { method: "DELETE", headers });
    await load();
  };

  // ── 全局博主追新设置弹窗（影响该用户所有博主）───────────────────────
  const settingsModal = useDisclosure();
  const [pushOnEdit, setPushOnEdit] = useState(true);
  const [intervalEdit, setIntervalEdit] = useState<number>(60);
  const [savingSettings, setSavingSettings] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<{
    bound: boolean; chat_id?: string; chat_name?: string;
    bitable_app_token?: string;
  } | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const openGlobalSettings = async () => {
    settingsModal.onOpen();
    // 拉飞书状态
    try {
      const r = await fetch("/api/feishu/status", { headers });
      if (r.ok) {
        const d = await r.json();
        setFeishuStatus({
          bound: !!d.bound || !!d.feishu_open_id,
          chat_id: d.feishu_chat_id || "",
          chat_name: d.feishu_chat_name || "",
          bitable_app_token: d.feishu_bitable_app_token || "",
        });
      }
    } catch {}
    // 当前已订阅博主中取最常见的设置作为默认（简单起见取第一个）
    if (creators.length > 0) {
      const c = creators[0];
      setPushOnEdit(!(c.push_enabled === false || c.push_enabled === 0));
      setIntervalEdit(c.fetch_interval_minutes || 60);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      // 批量把所有博主的 push_enabled / fetch_interval_minutes 同步成全局值
      const tasks = creators.map((c) =>
        fetch(`/api/monitor/creators/${c.id}/settings`, {
          method: "PUT", headers,
          body: JSON.stringify({
            push_enabled: pushOnEdit,
            fetch_interval_minutes: intervalEdit,
          }),
        }),
      );
      await Promise.all(tasks);
      toastOk(`已保存（应用到 ${creators.length} 个博主）`);
      settingsModal.onClose();
      await load();
    } finally {
      setSavingSettings(false);
    }
  };

  const reprovision = async () => {
    setProvisioning(true);
    try {
      const r = await fetch("/api/feishu/reprovision", { method: "POST", headers });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toastErr(j.detail || "建群失败");
        return;
      }
      toastOk("飞书群已建/已重建，告警将推送到该群");
      // 刷新状态
      const sr = await fetch("/api/feishu/status", { headers });
      if (sr.ok) {
        const d = await sr.json();
        setFeishuStatus({
          bound: !!d.bound || !!d.feishu_open_id,
          chat_id: d.feishu_chat_id || "",
          chat_name: d.feishu_chat_name || "",
          bitable_app_token: d.feishu_bitable_app_token || "",
        });
      }
    } finally {
      setProvisioning(false);
    }
  };

  const checkOne = async (cid: number) => {
    const r = await fetch(`/api/monitor/creators/${cid}/check`, { method: "POST", headers });
    if (r.ok) {
      const d = await r.json();
      // 后端会在"无 cookie + 抓回 0 帖"时返回 warning（XHS 三路抓取兜底失败）
      if (d.warning) {
        toastInfo(d.warning);
      } else {
        toastOk(`刷新完成：抓到 ${d.fetched || 0} 篇，新增 ${d.added || 0} 篇`);
      }
      // 手动刷新会带新 unread → 立刻再清零（用户主动操作就视为已读）
      seenIdsRef.current.delete(cid);
      await load();
    } else {
      const j = await r.json().catch(() => ({}));
      toastErr(`抓取失败：${j.detail || "未知错误"}`);
    }
  };

  const placeholder = platform === "mp"
    ? "例：人民日报 / 36氪 / 阮一峰的网络日志"
    : platform === "douyin"
    ? "https://www.douyin.com/user/{sec_uid}"
    : "https://www.xiaohongshu.com/user/profile/{user_id}";

  const desc = platform === "mp"
    ? "输入公众号名称即可订阅，系统通过搜狗微信搜索抓最近 ~10 篇文章并自动入库；6 小时检查一次更新。"
    : platform === "douyin"
    ? "输入博主主页 URL 订阅。通过 TrendPulse Helper 浏览器扩展抓取（请安装扩展并在浏览器登录抖音），6 小时检查一次更新。"
    : "输入博主主页 URL 订阅。通过 TrendPulse Helper 浏览器扩展抓取（请安装扩展并在浏览器登录小红书），6 小时检查一次更新。";

  return (
    <>
      <Card>
        <CardHeader className="flex justify-between items-center">
          <div>
            <p className="text-sm font-medium">{PLATFORM_LABEL[platform]} · 博主追新</p>
            <p className="text-xs text-default-400">已订阅 {creators.length} 个</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="flat" startContent={<Settings size={14} />}
              onPress={openGlobalSettings}>
              追新设置
            </Button>
            <Button size="sm" color="primary" startContent={<Plus size={14} />}
              onPress={() => { setFollowInput(""); setFollowError(""); setFollowResult(null); followModal.onOpen(); }}>
              {platform === "mp" ? "订阅公众号" : "订阅博主"}
            </Button>
          </div>
        </CardHeader>
        <CardBody className="space-y-2">
          {loading ? (
            <p className="text-sm text-default-400">加载中…</p>
          ) : creators.length === 0 ? (
            <p className="text-sm text-default-400">还没有订阅任何博主</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {creators.map((c) => {
                const status = c.last_check_status || "unknown";
                const unread = c.unread_count || 0;
                const dotColor =
                  status === "cookie_invalid" ? "bg-danger"
                  : status === "no_extension" ? "bg-warning"
                  : status === "ext_login_required" ? "bg-warning"
                  : status === "no_account"   ? "bg-warning"
                  : status === "error"        ? "bg-warning"
                  : status === "ok"           ? "bg-success"
                  :                              "bg-default-300";
                const statusText =
                  status === "no_extension" ? "未连接扩展"
                  : status === "ext_login_required" ? "扩展未登录该平台"
                  : status === "cookie_invalid" ? "Cookie 失效"
                  : status === "no_account"   ? "无账号"
                  : status === "error"        ? "抓取出错"
                  : status === "ok"           ? "抓取正常"
                  :                              "尚未运行";

                const tipLines: string[] = [];
                tipLines.push(`状态：${statusText}`);
                if (c.last_check_at) tipLines.push(`上次检查：${c.last_check_at}`);
                if (c.last_post_at)  tipLines.push(`最近发帖：${c.last_post_at.slice(5, 16)}`);
                if (c.last_check_error) tipLines.push(`错误：${c.last_check_error}`);

                const name = c.creator_name || "(未知博主)";
                const initial = (name || "?").slice(0, 1);
                const followers = (c as any).followers_count || 0;
                const likes = (c as any).likes_count || 0;
                const notes = (c as any).notes_count || 0;
                const desc = (c as any).creator_desc || "";
                const fmt = (n: number) =>
                  n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n || 0);

                return (
                  <div key={c.id}
                    className="rounded-lg border border-default-200 hover:border-default-300 transition px-3 py-3 bg-content1">
                    <div className="flex items-start gap-3">
                      {/* avatar */}
                      {c.avatar_url ? (
                        <img src={c.avatar_url} alt="" referrerPolicy="no-referrer"
                          className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-base font-semibold flex-shrink-0">
                          {initial}
                        </div>
                      )}
                      {/* main */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
                          <Tooltip content={<div className="text-xs whitespace-pre-line max-w-xs">{tipLines.join("\n")}</div>}>
                            <span className="text-sm font-medium truncate cursor-help">{name}</span>
                          </Tooltip>
                          {unread > 0 && (
                            <span className="px-1.5 py-px rounded-full bg-success-100 text-success-700 text-[10px] font-semibold flex-shrink-0">
                              {unread} 新
                            </span>
                          )}
                        </div>
                        {/* 数据条：粉丝 / 获赞 / 笔记数 */}
                        <div className="flex gap-3 mt-1 text-[11px] text-default-600">
                          <span><span className="text-default-400">粉丝</span> <strong>{fmt(followers)}</strong></span>
                          <span><span className="text-default-400">获赞</span> <strong>{fmt(likes)}</strong></span>
                          <span><span className="text-default-400">作品</span> <strong>{fmt(notes)}</strong></span>
                        </div>
                        {/* 简介 */}
                        {desc && (
                          <div className="text-[11px] text-default-500 mt-1 truncate" title={desc}>
                            {desc}
                          </div>
                        )}
                        {/* 最近帖子 */}
                        <div className="text-[11px] text-default-500 mt-1 truncate">
                          {c.last_post_title
                            ? <span className="text-default-700">📄 {c.last_post_title}</span>
                            : c.last_post_at
                              ? <span className="text-default-400">最近发帖 {c.last_post_at.slice(5, 16)}</span>
                              : <span className="text-default-300">尚未抓到帖子</span>}
                        </div>
                      </div>
                      {/* actions */}
                      <div className="flex flex-col gap-0.5 flex-shrink-0">
                        <Button size="sm" variant="light" isIconOnly
                          onPress={() => checkOne(c.id)}
                          aria-label="立刻刷新" className="min-w-0 w-7 h-7">
                          <RefreshCw size={13} />
                        </Button>
                        <Button size="sm" variant="light" isIconOnly color="danger"
                          onPress={() => unfollow(c.id)}
                          aria-label="取消订阅" className="min-w-0 w-7 h-7">
                          <X size={13} />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Modal isOpen={followModal.isOpen} onClose={followModal.onClose} size="lg">
        <ModalContent>
          <ModalHeader>{platform === "mp" ? "订阅公众号（零配置）" : `订阅 ${PLATFORM_LABEL[platform]} 博主`}</ModalHeader>
          <ModalBody className="space-y-3">
            <p className="text-xs text-default-500">{desc}</p>
            <Input
              autoFocus
              label={platform === "mp" ? "公众号名称" : "博主主页 URL"}
              placeholder={placeholder}
              value={followInput}
              onValueChange={setFollowInput}
            />
            {followError && <p className="text-sm text-danger">{followError}</p>}
            {followResult && (
              <div className="text-sm text-success bg-success-50 rounded p-2">
                ✅ 已订阅。首批抓到 {followResult.fetched} 篇，新增 {followResult.added} 篇。
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={followModal.onClose}>关闭</Button>
            <Button color="primary" onPress={submitFollow} isLoading={followBusy}>
              订阅并立即抓取
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 全局博主追新设置弹窗（影响该用户所有博主）*/}
      <Modal isOpen={settingsModal.isOpen} onClose={settingsModal.onClose} size="md">
        <ModalContent>
          <ModalHeader>博主追新 · 全局设置</ModalHeader>
          <ModalBody className="space-y-4">
            <p className="text-tiny text-default-500">
              这些设置会应用到你订阅的所有博主（共 {creators.length} 个）。
            </p>

            {/* per-feature 飞书推送：lazy 拉「博主追新」专属群 */}
            <FeishuPushToggle feature="creator" platform={platform} />

            {/* 推送开关 */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">推送到飞书</p>
                <p className="text-xs text-default-400 mt-0.5">
                  开启后博主有新帖会推送到下方绑定的飞书群；关闭只静默入库。
                </p>
              </div>
              <Switch isSelected={pushOnEdit} onValueChange={setPushOnEdit} color="primary" />
            </div>

            {/* 飞书群绑定状态 + 拉群 */}
            <div className="px-3 py-2.5 rounded-md bg-default-50 border border-default-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">飞书群</span>
                {feishuStatus === null ? (
                  <span className="text-tiny text-default-400">加载中…</span>
                ) : !feishuStatus.bound ? (
                  <span className="text-tiny text-warning">未绑定飞书</span>
                ) : feishuStatus.chat_id ? (
                  <span className="text-tiny text-success">已建群</span>
                ) : (
                  <span className="text-tiny text-warning">已绑飞书但无群</span>
                )}
              </div>
              {feishuStatus?.bound && feishuStatus.chat_id && (
                <div className="text-tiny text-default-500 break-all">
                  群 ID: <code className="text-[10px]">{feishuStatus.chat_id.slice(0, 30)}…</code>
                </div>
              )}
              {!feishuStatus?.bound ? (
                <a href="/dashboard/profile" className="block text-tiny text-primary underline">
                  → 前往「个人设置」绑定飞书
                </a>
              ) : (
                <Button size="sm" variant="flat" color="primary"
                  isLoading={provisioning}
                  onPress={reprovision}
                  className="mt-1">
                  {feishuStatus.chat_id ? "重建群组" : "立即建群"}
                </Button>
              )}
            </div>

            {/* 频率 */}
            <div>
              <p className="text-sm font-medium mb-2">默认抓取频率</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { v: 30,   l: "30 分钟" },
                  { v: 60,   l: "1 小时" },
                  { v: 180,  l: "3 小时" },
                  { v: 360,  l: "6 小时" },
                  { v: 1440, l: "每天" },
                ].map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setIntervalEdit(opt.v)}
                    className={`px-3 py-1.5 rounded-md text-xs border transition ${
                      intervalEdit === opt.v
                        ? "bg-primary text-white border-primary"
                        : "bg-content1 border-default-200 hover:border-default-400"
                    }`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  type="number" size="sm" className="w-28"
                  value={String(intervalEdit)}
                  onValueChange={(v) => {
                    const n = parseInt(v || "60");
                    if (!isNaN(n)) setIntervalEdit(n);
                  }}
                  min={5}
                  endContent={<span className="text-tiny text-default-400">分钟</span>}
                />
                <span className="text-tiny text-default-400">自定义（≥ 5 分钟）</span>
              </div>
              {intervalEdit < 30 && (
                <div className="mt-2 px-3 py-2 rounded-md bg-warning-50 border border-warning-200 text-tiny text-warning-700">
                  ⚠️ 频率高于每 30 分钟有触发风控的风险。建议保持 ≥ 30 分钟。
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={settingsModal.onClose} isDisabled={savingSettings}>
              取消
            </Button>
            <Button color="primary" onPress={saveSettings} isLoading={savingSettings}
              isDisabled={creators.length === 0}>
              保存（应用到 {creators.length} 个博主）
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
