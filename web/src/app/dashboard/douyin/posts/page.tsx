"use client";

import { useState } from "react";
import { usePosts, mutatePosts, useLives, mutateLives } from "@/lib/useApi";
import dynamic from "next/dynamic";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { useDisclosure } from "@nextui-org/modal";
import { Tooltip } from "@nextui-org/tooltip";
import { Plus, RefreshCw, Trash2, Download, Radio, FileText } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { toastOk, toastErr } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";

// 添加视频 / 订阅直播 Modal —— 首屏不需要，懒加载
const AddDouyinPostsModal = dynamic(() => import("./_modals/AddDouyinPostsModal"), { ssr: false });
const SubscribeLiveModal = dynamic(() => import("./_modals/SubscribeLiveModal"), { ssr: false });

const API = (path: string) => `/api/monitor${path}`;

type Post = {
  note_id: string;
  title: string;
  note_url: string;
  liked_count: number | null;
  collected_count: number | null;
  comment_count: number | null;
  checked_at: string | null;
  last_fetch_status?: string;
  fail_count?: number;
  platform: string;
  tags?: string;
  author?: string;
};

type Live = {
  id: number;
  room_url: string;
  streamer_name?: string;
  online_alert_threshold?: number;
  last_online?: number | null;
  last_check_at?: string | null;
  room_id?: string | null;
};

function parseTags(s?: string): string[] {
  if (!s) return [];
  try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

export default function DouyinPostsPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const { posts: rawPosts, isLoading } = usePosts();
  const posts = (rawPosts as Post[]).filter((p) => p.platform === "douyin");
  const [links, setLinks] = useState("");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const handleAdd = async () => {
    const items = links.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    setAdding(true);
    setResults([]);
    try {
      const r = await fetch(API("/posts"), {
        method: "POST", headers, body: JSON.stringify({ links: items }),
      });
      const d = await r.json();
      setResults(d.results ?? []);
      setLinks("");
      await mutatePosts();
    } finally {
      setAdding(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers });
    setTimeout(() => { mutatePosts(); setChecking(false); }, 4000);
  };

  const handleDelete = async (note_id: string) => {
    const ok = await confirmDialog({
      title: "删除监控",
      content: "确认删除这条监控？",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    await fetch(API(`/posts/${note_id}`), { method: "DELETE", headers });
    await mutatePosts();
  };

  const statusChip = (p: Post) => {
    const fc = p.fail_count ?? 0;
    if (fc >= 5) return <Chip size="sm" color="danger" variant="flat">⚠️ 已停抓</Chip>;
    if (p.last_fetch_status === "ok") return <Chip size="sm" color="success" variant="flat">正常</Chip>;
    if (p.last_fetch_status === "login_required")
      return <Chip size="sm" color="warning" variant="flat">🔒 需验证</Chip>;
    if (p.last_fetch_status === "deleted") return <Chip size="sm" color="danger" variant="flat">已删除</Chip>;
    if (p.last_fetch_status === "error") return <Chip size="sm" color="danger" variant="flat">抓取异常</Chip>;
    return <Chip size="sm" variant="flat">未检测</Chip>;
  };

  // ── 直播订阅 ──────────────────────────────────────────────────
  const { lives: rawLives, isLoading: livesLoading } = useLives();
  const lives = (rawLives as Live[]);
  const liveModal = useDisclosure();
  const [liveRoomUrl, setLiveRoomUrl] = useState("");
  const [liveStreamer, setLiveStreamer] = useState("");
  const [liveThreshold, setLiveThreshold] = useState("");
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState("");

  const submitLive = async () => {
    setLiveError("");
    if (!liveRoomUrl.trim()) { setLiveError("请填写直播间 URL"); return; }
    setLiveBusy(true);
    try {
      const r = await fetch(API("/lives"), {
        method: "POST", headers,
        body: JSON.stringify({
          room_url: liveRoomUrl.trim(),
          streamer_name: liveStreamer.trim() || undefined,
          online_alert_threshold: liveThreshold ? Number(liveThreshold) : 0,
          platform: "douyin",
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setLiveError(j.detail || "添加失败");
        return;
      }
      setLiveRoomUrl(""); setLiveStreamer(""); setLiveThreshold("");
      liveModal.onClose();
      await mutateLives();
    } finally {
      setLiveBusy(false);
    }
  };

  const deleteLive = async (id: number) => {
    const ok = await confirmDialog({
      title: "取消直播订阅",
      content: "取消该直播订阅？",
      confirmText: "取消订阅",
      cancelText: "保留",
      danger: true,
    });
    if (!ok) return;
    await fetch(API(`/lives/${id}`), { method: "DELETE", headers });
    await mutateLives();
  };

  const checkLive = async (id: number) => {
    const r = await fetch(API(`/lives/${id}/check`), { method: "POST", headers });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      toastErr(`抓取失败：${j.detail || "未知错误"}`);
      return;
    }
    const d = await r.json();
    toastOk(`当前在线：${d.state?.online ?? "—"}`);
    await mutateLives();
  };

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <PlatformSubNav platform="douyin" current="posts" />

      <div className="flex items-center justify-between">
        <Chip size="sm" color="primary" variant="flat">v1 - 详情抓取</Chip>
        <div className="flex gap-2">
          <Button size="sm" variant="flat"
            startContent={<RefreshCw size={15} className={checking ? "animate-spin" : ""} />}
            onPress={handleCheck} isLoading={checking}>
            立即检测
          </Button>
          <Button size="sm" color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
            添加抖音视频
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="text-sm text-default-500 flex-col items-start gap-1">
          <span>支持的链接形态：</span>
          <ul className="text-xs space-y-0.5 ml-3">
            <li>· 短链：<code>https://v.douyin.com/xxxxx/</code></li>
            <li>· 长链：<code>https://www.douyin.com/video/&#123;aweme_id&#125;</code></li>
            <li>· 移动分享：<code>https://www.iesdouyin.com/share/video/&#123;aweme_id&#125;/</code></li>
          </ul>
        </CardHeader>
        <CardBody className="p-0">
          {isLoading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="还没有添加抖音视频"
              hint="支持 v.douyin.com 短链 / www.douyin.com/video/{id} 长链 / iesdouyin 移动分享链。"
              action={
                <Button color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
                  添加抖音视频
                </Button>
              }
            />
          ) : (
          <Table aria-label="douyin-posts" removeWrapper>
            <TableHeader>
              <TableColumn>视频</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>评论</TableColumn>
              <TableColumn>分享</TableColumn>
              <TableColumn>最后检测</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {posts.map((p) => (
                <TableRow key={p.note_id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <a href={p.note_url} target="_blank" rel="noreferrer"
                        className="text-primary text-sm truncate max-w-md hover:underline">
                        {p.title || p.note_id}
                      </a>
                      <div className="flex items-center gap-1 flex-wrap">
                        {p.author && (
                          <span className="text-xs text-success">📢 {p.author}</span>
                        )}
                        {parseTags(p.tags).slice(0, 6).map((t, i) => (
                          <Chip key={i} size="sm" variant="flat" color="primary"
                            className="h-5 text-[10px] px-1">
                            #{t}
                          </Chip>
                        ))}
                      </div>
                      <span className="text-xs text-default-400">{p.note_id}</span>
                    </div>
                  </TableCell>
                  <TableCell>{statusChip(p)}</TableCell>
                  <TableCell>{p.liked_count ?? "—"}</TableCell>
                  <TableCell>{p.comment_count ?? "—"}</TableCell>
                  <TableCell>{p.collected_count ?? "—"}</TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">
                      {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tooltip content="下载无水印 mp4">
                        <Button isIconOnly size="sm" variant="light"
                          onPress={async () => {
                            const r = await fetch(API(`/posts/${p.note_id}/video?clean=true`), { headers });
                            if (!r.ok) {
                              let msg = "下载失败";
                              try { const j = await r.json(); msg = j.detail || msg; } catch {}
                              toastErr(msg);
                              return;
                            }
                            const blob = await r.blob();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `douyin_${p.note_id}.mp4`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}>
                          <Download size={15} />
                        </Button>
                      </Tooltip>
                      <Tooltip content="删除" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger"
                          onPress={() => handleDelete(p.note_id)}>
                          <Trash2 size={15} />
                        </Button>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </CardBody>
      </Card>

      {/* ── 直播订阅（抖音特有） ─────────────────────────── */}
      <Card>
        <CardHeader className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-danger" />
            <div>
              <p className="text-sm font-medium">直播订阅</p>
              <p className="text-xs text-default-400">已订阅 {lives.length} 个直播间，定时拉取在线人数与礼物榜</p>
            </div>
          </div>
          <Button size="sm" color="danger" variant="flat" startContent={<Plus size={14} />}
            onPress={() => { setLiveError(""); liveModal.onOpen(); }}>
            订阅直播间
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {livesLoading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : lives.length === 0 ? (
            <EmptyState
              icon={Radio}
              title="还没有订阅直播间"
              hint="支持 https://live.douyin.com/{room_id}，订阅后会定时拉取在线人数与礼物榜。"
              action={
                <Button color="danger" variant="flat" startContent={<Plus size={14} />}
                  onPress={() => { setLiveError(""); liveModal.onOpen(); }}>
                  订阅直播间
                </Button>
              }
            />
          ) : (
          <Table aria-label="douyin-lives" removeWrapper>
            <TableHeader>
              <TableColumn>主播 / 房间</TableColumn>
              <TableColumn>在线人数</TableColumn>
              <TableColumn>预警阈值</TableColumn>
              <TableColumn>最后检测</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {lives.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <a href={l.room_url} target="_blank" rel="noreferrer"
                        className="text-primary text-sm hover:underline truncate max-w-sm">
                        {l.streamer_name || l.room_id || l.room_url}
                      </a>
                      <span className="text-xs text-default-400">{l.room_url}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{l.last_online ?? "—"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">{l.online_alert_threshold || "—"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">
                      {l.last_check_at ? l.last_check_at.slice(0, 16) : "待检测"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tooltip content="立即拉取">
                        <Button isIconOnly size="sm" variant="light" onPress={() => checkLive(l.id)}>
                          <RefreshCw size={14} />
                        </Button>
                      </Tooltip>
                      <Tooltip content="取消订阅" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger"
                          onPress={() => deleteLive(l.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </CardBody>
      </Card>

      {/* Modal —— 懒加载 */}
      {isOpen && (
        <AddDouyinPostsModal
          isOpen={isOpen}
          onClose={onClose}
          links={links}
          setLinks={setLinks}
          results={results}
          adding={adding}
          onSubmit={handleAdd}
        />
      )}
      {liveModal.isOpen && (
        <SubscribeLiveModal
          isOpen={liveModal.isOpen}
          onClose={liveModal.onClose}
          liveRoomUrl={liveRoomUrl}
          setLiveRoomUrl={setLiveRoomUrl}
          liveStreamer={liveStreamer}
          setLiveStreamer={setLiveStreamer}
          liveThreshold={liveThreshold}
          setLiveThreshold={setLiveThreshold}
          liveError={liveError}
          liveBusy={liveBusy}
          onSubmit={submitLive}
        />
      )}
    </div>
  );
}
