"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Input } from "@nextui-org/input";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { CreatorRow, PlatformKey, PLATFORM_LABEL } from "./types";
import { toastOk, toastErr } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";

/**
 * 通用「博主追新」卡片组件，三个平台共用。
 *
 * 使用：<CreatorsCard platform="xhs" />
 * - 列出当前用户在该平台订阅的所有博主
 * - 加 / 删 / 立即抓取
 * - 文案根据 platform 不同（XHS/抖音用「博主主页 URL」，公众号用「公众号名称」）
 */
export function CreatorsCard({ platform }: { platform: PlatformKey }) {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [creators, setCreators] = useState<CreatorRow[]>([]);
  const [loading, setLoading] = useState(true);

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
        setCreators((d.creators || []).filter((c: CreatorRow) => c.platform === platform));
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
      toastOk(`刷新完成：抓到 ${d.fetched || 0} 篇，新增 ${d.added || 0} 篇`);
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
              {creators.map((c) => (
                <Chip key={c.id} size="sm" variant="dot" color="success"
                  onClose={() => unfollow(c.id)}
                  endContent={
                    <Button size="sm" variant="light" isIconOnly
                      onPress={() => checkOne(c.id)}
                      className="ml-1 min-w-0 w-5 h-5">
                      <RefreshCw size={11} />
                    </Button>
                  }>
                  {c.creator_name || c.creator_url}
                  {c.last_check_at && (
                    <span className="text-[10px] text-default-400 ml-1">
                      · {c.last_check_at.slice(5, 16)}
                    </span>
                  )}
                </Chip>
              ))}
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
