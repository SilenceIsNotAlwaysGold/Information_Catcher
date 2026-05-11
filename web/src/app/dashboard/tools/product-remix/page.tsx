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
import { confirmDialog } from "@/components/ConfirmDialog";

import { IMAGE_API, proxyUrl } from "@/components/product-image/utils";
import { useImageConfig } from "@/components/product-image/useImageConfig";
import { ConfigStatusBar } from "@/components/product-image/ConfigStatusBar";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";
import { HistoryGrid } from "@/components/product-image/HistoryGrid";

const COUNT_PRESETS = [3, 5, 10, 20, 30];

// 默认 prompt 硬编码 fallback（与后端 remix_worker.REMIX_PROMPT_EN /
// CAPTION_PROMPT_TEMPLATE 保持一致）。拉默认接口失败时也能点"填入默认"。
const DEFAULT_IMAGE_PROMPT =
  "Recreate the same visual style, composition, color palette and mood as the reference image. " +
  "CRITICAL: keep ALL Chinese text in the image EXACTLY as in the reference — same content, " +
  "same font, same size, same color, same position. Do not modify, translate, or remove any text. " +
  "Generate a fresh variation of the rest of the image: change the background, decorative props, " +
  "secondary colors, lighting, and ambient details so this version looks like a sibling of the reference, " +
  "not a copy. High quality, 8k, professional product photography, sharp focus.";

const DEFAULT_CAPTION_PROMPT =
  "你是专业的小红书爆款笔记仿写者。用户给你一篇原作品的标题和正文，" +
  "你要写一份新版本（这是 {n_total} 个版本中的第 {set_idx} 个）。\n\n" +
  "**核心要求**：\n" +
  "1. 保留原作品的核心卖点、商品信息、关键数字（如尺码、价格、用法）\n" +
  "2. 标题：18 字内，换一个完全不同的钩子句（数字 / 反问 / 反差 / 提醒），不要照抄\n" +
  "3. 正文：200-300 字，3-5 段，每段开头 emoji,关键词用 ** 加粗\n" +
  "4. 第一人称视角，给生活场景细节（地点 / 心情 / 对比）\n" +
  "5. 结尾给 3-5 个话题标签 #xxx#\n" +
  "6. 多个版本之间要明显不同：换不同的切入角度、不同的故事场景、不同的情绪基调\n\n" +
  '严格按 JSON 输出，不要任何解释：{{"title": "...", "body": "..."}}';

// 内置模板（id="builtin:default"）；用户自定义模板存 localStorage
type PromptTemplate = {
  id: string;
  name: string;
  image_prompt: string;
  caption_prompt: string;
  builtin?: boolean;
};
const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "builtin:default",
    name: "默认模板（小红书爆款）",
    image_prompt: DEFAULT_IMAGE_PROMPT,
    caption_prompt: DEFAULT_CAPTION_PROMPT,
    builtin: true,
  },
  {
    id: "builtin:minimal",
    name: "极简留白风",
    image_prompt:
      DEFAULT_IMAGE_PROMPT +
      "\n\nAesthetic preference: minimal, lots of negative space, off-white or soft pastel background, " +
      "very few props, single soft light source.",
    caption_prompt: DEFAULT_CAPTION_PROMPT,
    builtin: true,
  },
  {
    id: "builtin:cyberpunk",
    name: "赛博朋克霓虹",
    image_prompt:
      DEFAULT_IMAGE_PROMPT +
      "\n\nAesthetic preference: cyberpunk, neon lights (cyan/magenta/violet), rainy reflective surfaces, " +
      "moody dark background, futuristic vibe.",
    caption_prompt: DEFAULT_CAPTION_PROMPT,
    builtin: true,
  },
];
const TEMPLATES_LS_KEY = "remix_prompt_templates_v1";

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
  const [styleKeywords, setStyleKeywords] = useState("");
  // 高级：用户自定义 prompt（留空则用默认）
  const [imagePrompt, setImagePrompt] = useState("");
  const [captionPrompt, setCaptionPrompt] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 模板：内置 + 用户自定义（localStorage）
  const [userTemplates, setUserTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTplId, setSelectedTplId] = useState<string>("builtin:default");
  const allTemplates = useMemo(
    () => [...BUILTIN_TEMPLATES, ...userTemplates],
    [userTemplates],
  );

  // 初始化：localStorage 读自定义模板
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TEMPLATES_LS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setUserTemplates(arr);
      }
    } catch {}
  }, []);
  const persistTemplates = useCallback((arr: PromptTemplate[]) => {
    setUserTemplates(arr);
    try { localStorage.setItem(TEMPLATES_LS_KEY, JSON.stringify(arr)); } catch {}
  }, []);

  // 切换模板时填充两个 textarea
  const applyTemplate = useCallback((tplId: string) => {
    setSelectedTplId(tplId);
    const tpl = [...BUILTIN_TEMPLATES, ...userTemplates].find((t) => t.id === tplId);
    if (!tpl) return;
    setImagePrompt(tpl.image_prompt);
    setCaptionPrompt(tpl.caption_prompt);
  }, [userTemplates]);

  // 保存当前 textarea 内容为新模板（用户填名字）
  const saveAsTemplate = useCallback(() => {
    const name = window.prompt("命名这个模板：", "我的模板 " + (userTemplates.length + 1));
    if (!name || !name.trim()) return;
    const id = "user:" + Date.now();
    const tpl: PromptTemplate = {
      id, name: name.trim(),
      image_prompt: imagePrompt || DEFAULT_IMAGE_PROMPT,
      caption_prompt: captionPrompt || DEFAULT_CAPTION_PROMPT,
    };
    persistTemplates([...userTemplates, tpl]);
    setSelectedTplId(id);
    toastOk(`已保存模板「${tpl.name}」`);
  }, [imagePrompt, captionPrompt, userTemplates, persistTemplates]);

  const deleteTemplate = useCallback((id: string) => {
    if (!id.startsWith("user:")) return;
    persistTemplates(userTemplates.filter((t) => t.id !== id));
    if (selectedTplId === id) setSelectedTplId("builtin:default");
  }, [userTemplates, persistTemplates, selectedTplId]);

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
      if (typeof d.styleKeywords === "string") setStyleKeywords(d.styleKeywords);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const _firstSave = useRef(true);
  useEffect(() => {
    if (_firstSave.current) { _firstSave.current = false; return; }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ postUrl, count, styleKeywords }));
    } catch {}
  }, [postUrl, count, styleKeywords, PERSIST_KEY]);

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
          ref_image_idx: refIdxs[0] ?? 0,
          count,
          style_keywords: styleKeywords.trim(),
          image_prompt: imagePrompt.trim(),
          caption_prompt: captionPrompt.trim(),
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
                上限 30 套。一套内 {refIdxs.length} 张图并发生成，预计单套 ~30 秒，
                {count} 套总计 ~{Math.ceil(count * 30 / 60)} 分钟。
              </p>
            </div>

            {/* 风格关键词（可选） */}
            <div className="space-y-2">
              <p className="text-sm text-default-700">
                风格关键词（可选）<span className="text-xs text-default-400 ml-2">追加在 image prompt 末尾，影响每套图风格</span>
              </p>
              <Input
                placeholder="如：日系简约 / 莫兰迪色调 / 赛博朋克霓虹 / 极简白底"
                value={styleKeywords}
                onValueChange={setStyleKeywords}
                size="sm"
                description="留空则只走默认 prompt + 文案主题"
              />
              <div className="flex flex-wrap gap-1.5">
                {[
                  "日系简约", "莫兰迪色调", "极简白底", "复古胶片",
                  "ins 风", "高端质感", "暖色调暖光", "赛博朋克霓虹",
                ].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setStyleKeywords(preset)}
                    className="px-2 py-0.5 text-xs rounded border border-divider text-default-500 hover:bg-secondary/10 hover:border-secondary hover:text-secondary"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            {/* 高级：自定义 prompt（图片 + 文案） */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="text-sm text-default-600 hover:text-default-900 flex items-center gap-1"
              >
                <span>{advancedOpen ? "▾" : "▸"}</span>
                高级：自定义 Prompt
                {!advancedOpen && (imagePrompt || captionPrompt) && (
                  <span className="text-xs text-secondary ml-2">（已修改）</span>
                )}
              </button>
              {advancedOpen && (
                <div className="space-y-3 p-3 rounded-md bg-default-50 border border-default-200">
                  {/* 模板下拉：内置 + 用户自定义 */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-default-700">模板：</span>
                    <select
                      className="border border-divider rounded-md px-2 h-8 text-xs bg-background"
                      value={selectedTplId}
                      onChange={(e) => applyTemplate(e.target.value)}
                    >
                      <optgroup label="内置">
                        {BUILTIN_TEMPLATES.map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </optgroup>
                      {userTemplates.length > 0 && (
                        <optgroup label="我的模板">
                          {userTemplates.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <button
                      type="button"
                      className="text-xs px-2 h-8 border border-divider rounded-md hover:border-primary hover:text-primary"
                      onClick={saveAsTemplate}
                    >
                      保存当前为新模板
                    </button>
                    {selectedTplId.startsWith("user:") && (
                      <button
                        type="button"
                        className="text-xs px-2 h-8 border border-divider rounded-md hover:border-danger hover:text-danger"
                        onClick={() => deleteTemplate(selectedTplId)}
                      >
                        删除当前模板
                      </button>
                    )}
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <p className="text-xs text-default-700">图片仿写 Prompt（追加文案主题 + 风格关键词后传给图模型）</p>
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => setImagePrompt(DEFAULT_IMAGE_PROMPT)}
                      >
                        填入默认
                      </button>
                    </div>
                    <textarea
                      className="w-full border border-divider rounded-md p-2 text-xs font-mono bg-background min-h-[100px]"
                      placeholder="留空则用默认模板"
                      value={imagePrompt}
                      onChange={(e) => setImagePrompt(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <p className="text-xs text-default-700">
                        文案改写 System Prompt
                        <span className="text-default-400 ml-1">（占位符 <code className="text-rose-500">{`{n_total}`}</code> / <code className="text-rose-500">{`{set_idx}`}</code> 会被替换）</span>
                      </p>
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => setCaptionPrompt(DEFAULT_CAPTION_PROMPT)}
                      >
                        填入默认
                      </button>
                    </div>
                    <textarea
                      className="w-full border border-divider rounded-md p-2 text-xs font-mono bg-background min-h-[160px]"
                      placeholder="留空则用默认模板"
                      value={captionPrompt}
                      onChange={(e) => setCaptionPrompt(e.target.value)}
                    />
                  </div>
                  <p className="text-[11px] text-default-400">
                    留空 = 用默认模板；修改后会覆盖默认逻辑。「保存当前为新模板」会把当前两个 textarea 内容存到浏览器本地（按用户隔离）下次使用直接切换。
                  </p>
                </div>
              )}
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
      {activeTask && (() => {
        // 加权进度：文案 0.1 unit + 每张图 1 unit。比"按套数"细 10×
        const refsPerSet = Math.max(
          ...activeItems.map((it) => (it.images?.length || (it.image_url ? 1 : 0))),
          1,
        );
        const perSetTotal = 0.1 + refsPerSet * 1.0;
        const taskTotal = perSetTotal * Math.max(activeTask.count, 1);
        const taskDone = activeItems.reduce((sum, it) => {
          const captionUnit = (it.title || it.body) ? 0.1 : 0;
          const imgs = it.images && it.images.length
            ? it.images
            : (it.image_url ? [{ image_url: it.image_url }] : []);
          const imageUnit = imgs.filter((x) => x.image_url).length;
          return sum + captionUnit + imageUnit;
        }, 0);
        const pct = taskTotal > 0 ? Math.min(100, Math.round(taskDone / taskTotal * 100)) : 0;
        const cancellable = activeTask.status === "pending" || activeTask.status === "running";

        const handleCancel = async () => {
          const ok = await confirmDialog({
            title: "取消任务",
            content: `确认取消任务 #${activeTask.id}？已生成的图会保留，未完成的套会停止。`,
            confirmText: "取消任务", cancelText: "继续等", danger: true,
          });
          if (!ok) return;
          const r = await fetch(IMAGE_API(`/remix-tasks/${activeTask.id}/cancel`), {
            method: "POST", headers,
          });
          if (r.ok) {
            toastOk("已请求取消，worker 会在跑完当前一套后停止");
            await reloadTasks();
            await pollTask(activeTask.id);
          } else {
            const j = await r.json().catch(() => ({}));
            toastErr(`取消失败：${j.detail || `HTTP ${r.status}`}`);
          }
        };

        const handleClone = async () => {
          const r = await fetch(IMAGE_API(`/remix-tasks/${activeTask.id}/clone`), {
            method: "POST", headers,
          });
          if (r.ok) {
            const d = await r.json();
            toastOk(`已重新提交，新任务 #${d.task_id}`);
            setActiveTaskId(d.task_id);
            await reloadTasks();
          } else {
            const j = await r.json().catch(() => ({}));
            toastErr(`重新生成失败：${j.detail || `HTTP ${r.status}`}`);
          }
        };

        return (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-semibold">任务 #{activeTask.id}</span>
              {activeTask.status === "pending" && <Chip size="sm" variant="flat">排队中</Chip>}
              {activeTask.status === "running" && <Chip size="sm" color="primary" variant="flat">处理中</Chip>}
              {activeTask.status === "done" && <Chip size="sm" color="success" variant="flat">已完成</Chip>}
              {activeTask.status === "error" && <Chip size="sm" color="danger" variant="flat">失败</Chip>}
              {activeTask.status === "cancelled" && <Chip size="sm" color="default" variant="flat">已取消</Chip>}
              <span className="text-xs text-default-400">
                {activeTask.done_count} / {activeTask.count} 套
              </span>
            </div>
            <div className="flex gap-2">
              {cancellable && (
                <Button size="sm" variant="flat" color="danger" onPress={handleCancel}>
                  取消任务
                </Button>
              )}
              {!cancellable && activeTask.status !== "done" && (
                <Button size="sm" variant="flat" color="secondary" onPress={handleClone}>
                  重新生成
                </Button>
              )}
              <Button size="sm" variant="flat" onPress={closeActive}>关闭</Button>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            {/* 加权进度条 */}
            <div>
              <div className="flex justify-between text-xs text-default-600 mb-1">
                <span>
                  {activeTask.status === "done" ? "全部完成"
                  : activeTask.status === "error" ? "任务失败"
                  : activeTask.status === "cancelled" ? "已取消"
                  : "生成中…"}
                </span>
                <span>{pct}%</span>
              </div>
              <div className="w-full h-2 bg-default-200 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    activeTask.status === "error" ? "bg-danger"
                    : activeTask.status === "done" ? "bg-success"
                    : activeTask.status === "cancelled" ? "bg-default-400"
                    : "bg-secondary"
                  }`}
                  style={{ width: `${pct}%` }}
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
        );
      })()}

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
