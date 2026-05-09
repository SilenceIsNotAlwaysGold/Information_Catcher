"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Spinner } from "@nextui-org/spinner";
import { Chip } from "@nextui-org/chip";
// 进度条用原生 div + Tailwind 实现，避开 @nextui-org/progress 子包的
// tree-shaking 边界问题（曾导致 Progress 组件运行时为 undefined → React #130）。
import {
  Wand2, AlertCircle, Link2, Check, Download, Copy, RefreshCcw, Trash2,
} from "lucide-react";
import { useMe } from "@/lib/useApi";
import { toastOk, toastErr } from "@/lib/toast";

import { IMAGE_API, proxyUrl } from "@/components/product-image/utils";
import { useImageConfig } from "@/components/product-image/useImageConfig";
import { ConfigStatusBar } from "@/components/product-image/ConfigStatusBar";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";
import { HistoryGrid } from "@/components/product-image/HistoryGrid";

const COUNT_PRESETS = [3, 5, 10, 20, 30];

type FetchedPost = {
  images: string[];        // 展示用：data:URL（首选）或原 CDN URL（兜底）
  image_urls: string[];    // 原 CDN URL：提交任务时回传给 worker
  title: string;
  desc: string;
  platform: string;
  platform_label: string;
  post_id: string;
  post_url: string;
};

type RemixSubImage = {
  image_url: string;
  error?: string;
};
type RemixItem = {
  idx: number;
  // v2：一套含多张图（每张参考图各换一次背景）
  images?: RemixSubImage[];
  // v1 兼容：单张
  image_url: string;
  title: string;
  body: string;
  error: string;
};

type RemixTask = {
  id: number;
  user_id?: number | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  post_url: string;
  post_title: string;
  post_desc: string;
  platform: string;
  ref_image_url: string;
  ref_image_idx: number;
  count: number;
  done_count: number;
  items_json: string;
  error: string;
  size: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
};

export default function ProductRemixPage() {
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const uid = me?.username || me?.id || "anon";
  const PERSIST_KEY = `pulse.product-remix.${uid}`;

  const { cfg, loading: cfgLoading, reload: reloadConfig, headers } = useImageConfig();

  // ── 步骤 1：链接 + 拉文案 ────────────────────────────────────────────────
  const [postUrl, setPostUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [post, setPost] = useState<FetchedPost | null>(null);
  // v2：参考图多选（默认选第 1 张）
  const [refIdxs, setRefIdxs] = useState<number[]>([0]);

  // ── 步骤 2：提交参数 ────────────────────────────────────────────────────
  const [count, setCount] = useState(5);

  // 切换勾选某一张图作参考；保持点击顺序作为生成顺序
  const toggleRef = (i: number) => {
    setRefIdxs((prev) => {
      const has = prev.includes(i);
      if (has) {
        // 取消最后一张要兜底回 [0]
        const next = prev.filter((x) => x !== i);
        return next.length ? next : [0];
      }
      return [...prev, i];
    });
  };

  // ── 持久化 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.postUrl) setPostUrl(d.postUrl);
      if (typeof d.count === "number") setCount(d.count);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const _firstSave = useRef(true);
  useEffect(() => {
    if (_firstSave.current) { _firstSave.current = false; return; }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ postUrl, count }));
    } catch {}
  }, [postUrl, count, PERSIST_KEY]);

  const handleFetch = async () => {
    const url = postUrl.trim();
    if (!url) { toastErr("请粘贴小红书或抖音作品链接"); return; }
    setFetching(true);
    setPost(null);
    setRefIdxs([0]);
    try {
      const r = await fetch(IMAGE_API("/fetch-post-cover"), {
        method: "POST",
        headers,
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (data?.error) {
        toastErr(data.error);
        return;
      }
      const images: string[] = Array.isArray(data?.images) ? data.images : [];
      const imageUrls: string[] = Array.isArray(data?.image_urls) ? data.image_urls : images;
      if (!images.length) {
        toastErr("作品没有可用图片");
        return;
      }
      setPost({
        images,
        image_urls: imageUrls,
        title: data.title || "",
        desc: data.desc || "",
        platform: data.platform || "",
        platform_label: data.platform_label || "",
        post_id: data.post_id || "",
        post_url: data.post_url || url,
      });
      toastOk(`已加载：${(data.title || data.post_id || "").slice(0, 30)}（${images.length} 张图）`);
    } catch (e: any) {
      toastErr(`加载失败：${e?.message || e}`);
    } finally {
      setFetching(false);
    }
  };

  // ── 步骤 3：提交任务 + 轮询 ──────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [activeTask, setActiveTask] = useState<RemixTask | null>(null);

  const handleSubmit = async () => {
    if (!post) { toastErr("请先加载作品"); return; }
    if (!cfg.has_key) { toastErr("请先在「系统配置」配置图像 API"); return; }
    setSubmitting(true);
    try {
      const r = await fetch(IMAGE_API("/remix-tasks"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          post_url: post.post_url,
          ref_image_idxs: refIdxs,
          // 兼容字段：第一张作为旧 ref_image_idx
          ref_image_idx: refIdxs[0] ?? 0,
          count,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.detail) {
        toastErr(`提交失败：${data?.detail || `HTTP ${r.status}`}`);
        return;
      }
      const tid = data.task_id;
      toastOk(`已提交任务 #${tid}（${count} 套），后台开始处理…`);
      setActiveTaskId(tid);
      // 立刻拉一次以显示 pending 状态
      pollTask(tid);
    } catch (e: any) {
      toastErr(`提交异常：${e?.message || e}`);
    } finally { setSubmitting(false); }
  };

  const pollTask = useCallback(async (taskId: number) => {
    try {
      const r = await fetch(IMAGE_API(`/remix-tasks/${taskId}`), { headers });
      if (!r.ok) return;
      const data: RemixTask = await r.json();
      setActiveTask(data);
    } catch {}
  }, [headers]);

  // 轮询：active task 存在且未完成 → 每 4 秒拉一次
  useEffect(() => {
    if (!activeTaskId) return;
    pollTask(activeTaskId);
    const id = setInterval(() => {
      pollTask(activeTaskId);
    }, 4000);
    return () => clearInterval(id);
  }, [activeTaskId, pollTask]);

  // 任务完成自动停轮询（前端逻辑：done/error 时清掉 interval 没必要——但避免无意义请求）
  useEffect(() => {
    if (!activeTask) return;
    if (activeTask.status === "done" || activeTask.status === "error") {
      // 不自动清，让用户主动关闭/新建
    }
  }, [activeTask]);

  const activeItems: RemixItem[] = useMemo(() => {
    if (!activeTask?.items_json) return [];
    try {
      const parsed = JSON.parse(activeTask.items_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [activeTask]);

  const closeActive = () => {
    setActiveTaskId(null);
    setActiveTask(null);
  };

  // ── 历史任务列表（侧栏） ─────────────────────────────────────────────────
  const [tasks, setTasks] = useState<RemixTask[]>([]);
  const reloadTasks = useCallback(async () => {
    try {
      const r = await fetch(IMAGE_API("/remix-tasks?limit=20"), { headers });
      const data = await r.json().catch(() => ({}));
      if (Array.isArray(data?.tasks)) setTasks(data.tasks);
    } catch {}
  }, [headers]);
  useEffect(() => { reloadTasks(); }, [reloadTasks]);
  // 有 active task 时定时刷新任务列表
  useEffect(() => {
    if (!activeTaskId) return;
    const id = setInterval(reloadTasks, 6000);
    return () => clearInterval(id);
  }, [activeTaskId, reloadTasks]);

  const deleteTask = async (id: number) => {
    if (!confirm(`确认删除任务 #${id}？历史图不会被删，仅删任务记录。`)) return;
    try {
      const r = await fetch(IMAGE_API(`/remix-tasks/${id}`), {
        method: "DELETE", headers,
      });
      const data = await r.json().catch(() => ({}));
      if (data?.ok) {
        toastOk("已删除");
        setTasks((prev) => prev.filter((t) => t.id !== id));
        if (activeTaskId === id) closeActive();
      } else {
        toastErr(`删除失败：${data?.error || "未知"}`);
      }
    } catch (e: any) { toastErr(`删除异常：${e?.message || e}`); }
  };

  // 预览
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const downloadFromUrl = async (url: string) => {
    try {
      const res = await fetch(proxyUrl(url));
      const blob = await res.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      const fname = url.split("/").pop()?.split("?")[0] || `image-${Date.now()}.png`;
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    } catch (e: any) { toastErr(`下载失败：${e?.message || e}`); }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastOk("已复制");
    } catch { toastErr("复制失败"); }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-secondary/10 text-secondary p-3">
          <Wand2 size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            作品仿写
            <Chip size="sm" variant="flat" color="secondary">Beta</Chip>
          </h1>
          <p className="text-sm text-default-500 mt-1">
            粘贴小红书 / 抖音作品链接 → 选参考图 → AI 仿照风格批量出 N 套（图上文字保持不变 + 重写文案）。
          </p>
        </div>
        <a
          href="/dashboard/tools/product-image"
          className="text-sm text-primary hover:underline self-center"
        >
          ← 商品图（自创）
        </a>
      </div>

      <ConfigStatusBar
        cfg={cfg}
        loading={cfgLoading}
        isAdmin={!!isAdmin}
        onSaved={reloadConfig}
      />

      {/* 步骤 1：粘贴链接 */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <Link2 size={18} className="text-secondary" />
          <span className="font-semibold">第 1 步 · 粘贴作品链接</span>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="例：https://www.xiaohongshu.com/explore/xxx 或 https://v.douyin.com/xxx"
              value={postUrl}
              onValueChange={setPostUrl}
              startContent={<Link2 size={14} className="text-default-400" />}
              className="flex-1"
            />
            <Button
              color="secondary"
              onPress={handleFetch}
              isLoading={fetching}
              isDisabled={!postUrl.trim() || fetching}
            >
              加载作品
            </Button>
          </div>
          <p className="text-xs text-default-400">
            支持小红书的「分享」短链 (xhslink.com) / 完整链接，以及抖音的 v.douyin.com 短链 / video / note URL。
          </p>
        </CardBody>
      </Card>

      {/* 步骤 2：参考图 + 文案预览 */}
      {post && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-semibold">第 2 步 · 选参考图 + 确认文案</span>
              <Chip size="sm" variant="flat">{post.platform_label}</Chip>
              <Chip size="sm" variant="flat">{post.images.length} 张</Chip>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            {/* 缩略图条：多选作参考 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-default-700">
                  选哪几张作参考（每张都会单独换风格）
                </p>
                <div className="flex gap-2 text-xs">
                  <button type="button"
                    className="text-secondary hover:underline"
                    onClick={() => setRefIdxs(post.images.map((_, i) => i))}>
                    全选
                  </button>
                  <span className="text-default-300">·</span>
                  <button type="button"
                    className="text-default-500 hover:underline"
                    onClick={() => setRefIdxs([0])}>
                    只选封面
                  </button>
                </div>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {post.images.map((u, i) => {
                  const order = refIdxs.indexOf(i); // -1 = 未选
                  const selected = order >= 0;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleRef(i)}
                      className={`relative shrink-0 w-24 aspect-[3/4] rounded-md overflow-hidden border-2 transition-all ${
                        selected
                          ? "border-secondary ring-2 ring-secondary/30"
                          : "border-divider hover:border-secondary/50 opacity-70"
                      }`}
                    >
                      <img
                        src={u.startsWith("data:") ? u : proxyUrl(u)}
                        alt={`图 ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                      {selected && (
                        <span className="absolute top-1 right-1 bg-secondary text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center shadow">
                          {order + 1}
                        </span>
                      )}
                      <span className="absolute bottom-0 left-0 right-0 bg-black/40 text-white text-[10px] py-0.5 text-center">
                        图 {i + 1}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-default-400">
                已选 <b className="text-secondary">{refIdxs.length}</b> 张作主体图。每张图都会被 AI 单独换风格生成新版本。
              </p>
            </div>

            {/* 原文案预览 */}
            <div className="space-y-2 border border-divider rounded-lg p-3 bg-default-50">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-default-700">原作品文案</span>
                <Button
                  size="sm"
                  variant="light"
                  startContent={<Copy size={13} />}
                  onPress={() => copyText(`${post.title}\n\n${post.desc}`)}
                >
                  复制
                </Button>
              </div>
              {post.title && (
                <p className="text-sm font-medium text-default-800">{post.title}</p>
              )}
              {post.desc && (
                <p className="text-xs text-default-600 whitespace-pre-wrap line-clamp-6">
                  {post.desc}
                </p>
              )}
            </div>

            {/* 套数 */}
            <div className="space-y-2">
              <p className="text-sm text-default-700">
                想要几套？（每套 = <b className="text-secondary">{refIdxs.length}</b> 张换风格图 + 1 篇新文案）
              </p>
              <div className="flex flex-wrap gap-2">
                {COUNT_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCount(c)}
                    className={`px-4 py-1.5 rounded-md text-sm border transition-colors ${
                      count === c
                        ? "bg-secondary text-white border-secondary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {c} 套
                  </button>
                ))}
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={String(count)}
                  onValueChange={(v) => {
                    const n = parseInt(v, 10);
                    if (!isNaN(n)) setCount(Math.max(1, Math.min(30, n)));
                  }}
                  className="w-24"
                  size="sm"
                />
              </div>
              <p className="text-xs text-default-400">
                上限 30 套。每套约 10 秒，{count} 套预计耗时 ~{Math.ceil(count * 10 / 60)} 分钟。
              </p>
            </div>

            <Button
              color="secondary"
              size="lg"
              className="w-full"
              startContent={<Wand2 size={18} />}
              onPress={handleSubmit}
              isLoading={submitting}
              isDisabled={!cfg.has_key || submitting || !!activeTaskId}
            >
              {activeTaskId
                ? "已有任务进行中，请先关闭"
                : `提交：仿写 ${count} 套`}
            </Button>
          </CardBody>
        </Card>
      )}

      {/* 步骤 3：进度 + 结果 */}
      {activeTask && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-semibold">任务 #{activeTask.id}</span>
              {activeTask.status === "pending" && <Chip size="sm" variant="flat">排队中</Chip>}
              {activeTask.status === "running" && <Chip size="sm" color="primary" variant="flat">处理中</Chip>}
              {activeTask.status === "done" && <Chip size="sm" color="success" variant="flat">已完成</Chip>}
              {activeTask.status === "error" && <Chip size="sm" color="danger" variant="flat">失败</Chip>}
              <span className="text-xs text-default-400">
                {activeTask.done_count} / {activeTask.count}
              </span>
            </div>
            <Button size="sm" variant="flat" onPress={closeActive}>关闭</Button>
          </CardHeader>
          <CardBody className="space-y-4">
            {/* 进度条（原生实现，避免 NextUI Progress 子包打包问题） */}
            <div>
              <div className="flex justify-between text-xs text-default-600 mb-1">
                <span>
                  {activeTask.status === "done"
                    ? "全部完成"
                    : activeTask.status === "error"
                      ? "任务失败"
                      : "生成中…"}
                </span>
                <span>
                  {activeTask.count > 0
                    ? Math.round(activeTask.done_count * 100 / activeTask.count)
                    : 0}%
                </span>
              </div>
              <div className="w-full h-2 bg-default-200 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    activeTask.status === "error"
                      ? "bg-danger"
                      : activeTask.status === "done"
                        ? "bg-success"
                        : "bg-secondary"
                  }`}
                  style={{
                    width: `${activeTask.count > 0
                      ? Math.min(100, activeTask.done_count * 100 / activeTask.count)
                      : 0}%`,
                  }}
                />
              </div>
            </div>
            {activeTask.error && (
              <div className="flex items-start gap-2 text-sm text-danger bg-danger/10 rounded-lg p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{activeTask.error}</span>
              </div>
            )}
            {activeItems.length > 0 && (
              <div className="space-y-3">
                {activeItems.map((it) => {
                  // v2：images[] 多张；v1 兼容：单张 image_url 包成单元素数组
                  const subImages = (it.images && it.images.length > 0)
                    ? it.images
                    : (it.image_url ? [{ image_url: it.image_url }] : []);
                  const okImgs = subImages.filter((s) => s.image_url);
                  return (
                  <div
                    key={it.idx}
                    className="border border-divider rounded-lg p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        第 {it.idx} 套 <span className="text-default-400 text-xs">· {okImgs.length}/{subImages.length} 张</span>
                      </span>
                      {it.error && okImgs.length === 0 && (
                        <Chip size="sm" color="danger" variant="flat">失败</Chip>
                      )}
                      {it.error && okImgs.length > 0 && (
                        <Chip size="sm" color="warning" variant="flat">部分失败</Chip>
                      )}
                    </div>
                    {subImages.length > 0 ? (
                      <div className={`grid gap-2 ${
                        subImages.length === 1 ? "grid-cols-1"
                        : subImages.length === 2 ? "grid-cols-2"
                        : "grid-cols-3"
                      }`}>
                        {subImages.map((sub, si) => sub.image_url ? (
                          <div
                            key={si}
                            className="aspect-square rounded-md overflow-hidden bg-default-100 cursor-pointer relative group"
                            onClick={() => setPreviewSrc(sub.image_url)}
                          >
                            <img
                              src={proxyUrl(sub.image_url)}
                              alt={`套 ${it.idx} 图 ${si + 1}`}
                              className="w-full h-full object-cover"
                            />
                            <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">
                              {si + 1}
                            </span>
                          </div>
                        ) : (
                          <div key={si} className="aspect-square rounded-md bg-default-100 flex items-center justify-center">
                            <span className="text-[10px] text-danger text-center px-1">
                              {sub.error?.slice(0, 30) || "失败"}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="aspect-square rounded-md bg-default-100 flex items-center justify-center">
                        <span className="text-xs text-default-400">{it.error || "等待中"}</span>
                      </div>
                    )}
                    {it.title && (
                      <p className="text-sm font-medium text-default-800">{it.title}</p>
                    )}
                    {it.body && (
                      <p className="text-xs text-default-600 whitespace-pre-wrap line-clamp-5">
                        {it.body}
                      </p>
                    )}
                    {(it.title || it.body || okImgs.length > 0) && (
                      <div className="flex gap-2 flex-wrap">
                        {(it.title || it.body) && (
                          <Button
                            size="sm"
                            variant="light"
                            startContent={<Copy size={13} />}
                            onPress={() => copyText(`${it.title}\n\n${it.body}`)}
                          >
                            复制文案
                          </Button>
                        )}
                        {okImgs.map((sub, si) => (
                          <Button
                            key={si}
                            size="sm"
                            variant="light"
                            startContent={<Download size={13} />}
                            onPress={() => downloadFromUrl(sub.image_url)}
                          >
                            下载图 {okImgs.length > 1 ? si + 1 : ""}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* 任务列表 */}
      {tasks.length > 0 && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="font-semibold">我的任务</span>
            <Button size="sm" variant="flat" startContent={<RefreshCcw size={13} />} onPress={reloadTasks}>
              刷新
            </Button>
          </CardHeader>
          <CardBody>
            <div className="space-y-2">
              {tasks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 border border-divider rounded-lg p-3 hover:bg-default-50 transition-colors"
                >
                  <div className="w-12 h-12 rounded-md overflow-hidden bg-default-100 shrink-0">
                    {t.ref_image_url && (
                      <img
                        src={proxyUrl(t.ref_image_url)}
                        alt="ref"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">#{t.id}</span>
                      {t.status === "pending" && <Chip size="sm" variant="flat">排队</Chip>}
                      {t.status === "running" && <Chip size="sm" color="primary" variant="flat">处理中</Chip>}
                      {t.status === "done" && <Chip size="sm" color="success" variant="flat">已完成</Chip>}
                      {t.status === "error" && <Chip size="sm" color="danger" variant="flat">失败</Chip>}
                      <span className="text-xs text-default-400">
                        {t.done_count}/{t.count} · {t.created_at}
                      </span>
                    </div>
                    <p className="text-xs text-default-600 truncate mt-0.5">
                      {t.post_title || t.post_url}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => setActiveTaskId(t.id)}
                    isDisabled={activeTaskId === t.id}
                  >
                    {activeTaskId === t.id ? "查看中" : "查看"}
                  </Button>
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    isIconOnly
                    onPress={() => deleteTask(t.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {/* 历史 */}
      <HistoryGrid
        isAdmin={!!isAdmin}
        onPreview={(url) => setPreviewSrc(url)}
      />

      {/* 大图预览 */}
      <ImagePreviewModal
        isOpen={!!previewSrc}
        onClose={() => setPreviewSrc(null)}
        src={previewSrc || ""}
        onDownload={previewSrc ? () => {
          if (previewSrc.startsWith("data:")) {
            const a = document.createElement("a");
            a.href = previewSrc;
            a.download = `image-${Date.now()}.png`;
            a.click();
          } else {
            downloadFromUrl(previewSrc);
          }
        } : undefined}
      />
    </div>
  );
}
