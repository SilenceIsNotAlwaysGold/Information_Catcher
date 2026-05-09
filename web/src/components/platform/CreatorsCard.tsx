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
import { Plus, RefreshCw, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { CreatorRow, PlatformKey, PLATFORM_LABEL } from "./types";
import { toastOk, toastErr, toastInfo } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";

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
    ? "输入博主主页 URL 订阅。需要平台抖音账号 cookie，6 小时检查一次更新。"
    : "输入博主主页 URL 订阅。需要平台小红书账号 cookie，6 小时检查一次更新。";

  return (
    <>
      <Card>
        <CardHeader className="flex justify-between items-center">
          <div>
            <p className="text-sm font-medium">{PLATFORM_LABEL[platform]} · 博主追新</p>
            <p className="text-xs text-default-400">已订阅 {creators.length} 个</p>
          </div>
          <Button size="sm" color="primary" startContent={<Plus size={14} />}
            onPress={() => { setFollowInput(""); setFollowError(""); setFollowResult(null); followModal.onOpen(); }}>
            {platform === "mp" ? "订阅公众号" : "订阅博主"}
          </Button>
        </CardHeader>
        <CardBody className="space-y-2">
          {loading ? (
            <p className="text-sm text-default-400">加载中…</p>
          ) : creators.length === 0 ? (
            <p className="text-sm text-default-400">还没有订阅任何博主</p>
          ) : (
            <div className="flex flex-row gap-2 flex-wrap">
              {creators.map((c) => {
                const status = c.last_check_status || "unknown";
                const unread = c.unread_count || 0;
                // chip 配色：失效=红、无账号=橙、错=黄、ok/未知=绿
                const color: any =
                  status === "cookie_invalid" ? "danger"
                  : status === "no_account"   ? "warning"
                  : status === "error"        ? "warning"
                  :                              "success";
                const statusText =
                  status === "cookie_invalid" ? "账号 Cookie 失效（去账号管理重新登录）"
                  : status === "no_account"   ? "缺少可用账号 cookie，无法追新"
                  : status === "error"        ? "上次抓取出错"
                  : status === "ok"           ? "抓取正常"
                  :                              "尚未运行过";

                const tipLines: string[] = [];
                tipLines.push(`状态：${statusText}`);
                if (c.last_check_at) tipLines.push(`上次检查：${c.last_check_at}`);
                if (c.last_post_at)  tipLines.push(`最近发帖：${c.last_post_at.slice(5, 16)}`);
                if (c.last_check_error) tipLines.push(`错误：${c.last_check_error}`);

                // 标签文本：creator_name 优先，URL 作 fallback；URL 太长截断防 chip 撑爆
                const rawLabel = c.creator_name || c.creator_url;
                const label = rawLabel.length > 28 ? rawLabel.slice(0, 26) + "…" : rawLabel;
                return (
                  <Tooltip key={c.id} content={
                    <div className="text-xs whitespace-pre-line max-w-xs">
                      {tipLines.join("\n")}
                    </div>
                  }>
                    <Chip size="sm" variant="dot" color={color}
                      endContent={
                        <span className="flex items-center gap-0.5 ml-1">
                          <Button size="sm" variant="light" isIconOnly
                            onPress={() => checkOne(c.id)}
                            className="min-w-0 w-5 h-5"
                            aria-label="立刻刷新">
                            <RefreshCw size={11} />
                          </Button>
                          <Button size="sm" variant="light" isIconOnly color="danger"
                            onPress={() => unfollow(c.id)}
                            className="min-w-0 w-5 h-5"
                            aria-label="取消订阅">
                            <X size={12} />
                          </Button>
                        </span>
                      }>
                      <span className="truncate inline-block max-w-[14rem] align-middle">
                        {label}
                      </span>
                      {unread > 0 && (
                        <span className="ml-1 px-1.5 py-px rounded-full bg-success-100 text-success-700 text-[10px] font-semibold">
                          {unread} 新
                        </span>
                      )}
                      {!unread && c.last_post_at && (
                        <span className="text-[10px] text-default-400 ml-1">
                          · {c.last_post_at.slice(5, 16)}
                        </span>
                      )}
                    </Chip>
                  </Tooltip>
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
    </>
  );
}
