"use client";

/**
 * 文本仿写：扒原图文字 + 换背景图重绘
 *
 * 流程：
 *  1. 粘贴作品 URL → 拉所有图（fetch-post-cover，复用 product-remix 同款）
 *  2. 选某张图作"文字源" → 点 OCR 按钮提取文字（用户可编辑确认）
 *  3. 上传/选择背景图模板（保存到云端可复用）
 *  4. 提交生成 → 同步返回 N 张结果（MVP count≤3）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMe } from "@/lib/useApi";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Wand2, Link2, Image as ImageIcon, Upload, Trash2, Check, AlertCircle, Download, ZoomIn, ChevronDown, ChevronRight, FileText, Sparkles, Copy } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { IMAGE_API, proxyUrl, SIZE_OPTIONS } from "@/components/product-image/utils";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";
import { ModelSelector } from "@/components/ModelSelector";
import { BitablePushToggle } from "@/components/BitablePushToggle";

type FetchedPost = {
  images: string[];
  image_urls: string[];
  title: string;
  desc: string;
  platform: string;
  platform_label: string;
  post_id: string;
  post_url: string;
};

type Background = {
  id: number;
  name: string;
  image_url: string;
  width?: number;
  height?: number;
  created_at: string;
};

type ResultItem = {
  image_url: string;
  error: string;
  bg_name?: string;
  set_idx?: number;
  src_idx?: number;
};

// 任务详情：后端返回 _enrich_task 后的形态（JSON 字段已展开）
type TaskCell = {
  src_idx: number;
  bg_id: number;
  bg_name: string;
  image_url: string;
  error: string;
};
type TaskSet = { idx: number; items: TaskCell[] };
type TextRemixTask = {
  id: number;
  user_id: number;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  post_url: string;
  post_title: string;
  platform: string;
  count: number;
  done_count: number;
  size: string;
  style_hint: string;
  error: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  text_sources: { src_idx: number; text: string }[];
  background_ids: number[];
  backgrounds_meta: { id: number; name: string; image_url: string }[];
  items: TaskSet[];
};

export default function TextRemixPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  const { data: me } = useMe();
  const uid = me?.username || me?.id || "anon";
  const PERSIST_KEY = `pulse.text-remix.${uid}`;

  // ── 步骤 1：拉作品 ────────────────────────────────────────────────────
  const [postUrl, setPostUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [post, setPost] = useState<FetchedPost | null>(null);
  // 多选：用户可勾多张源图，OCR 时合并文字
  const [sourceImgIdxs, setSourceImgIdxs] = useState<number[]>([0]);
  // OCR 结果区折叠（提取后默认折叠，避免占屏）
  const [ocrPanelExpanded, setOcrPanelExpanded] = useState(true);

  // ── 笔记正文 + AI 改写 ───────────────────────────────────────────────
  const [noteText, setNoteText] = useState("");          // 用户可编辑的正文（拉作品后用 desc 初始化）
  const [noteCardExpanded, setNoteCardExpanded] = useState(true);
  const [noteRewriting, setNoteRewriting] = useState(false);
  const [noteRewriteVariants, setNoteRewriteVariants] = useState<string[]>([]);
  const [noteRewriteHint, setNoteRewriteHint] = useState("");

  const handleFetch = async () => {
    const u = postUrl.trim();
    if (!u) { toastErr("请输入作品链接"); return; }
    setFetching(true);
    setPost(null);
    setExtractedText("");
    try {
      const r = await fetch(IMAGE_API("/fetch-post-cover"), {
        method: "POST", headers,
        body: JSON.stringify({ url: u }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        toastErr(data.error || data.detail || "拉取失败");
        return;
      }
      const fetched = {
        images: data.images || [],
        image_urls: data.image_urls || data.images || [],
        title: data.title || "",
        desc: data.desc || "",
        platform: data.platform || "",
        platform_label: data.platform_label || "",
        post_id: data.post_id || "",
        post_url: data.post_url || u,
      };
      setPost(fetched);
      setSourceImgIdxs([0]);
      // 笔记正文初始化：标题 + 正文（用户可编辑/改写）
      const composed = [fetched.title, fetched.desc].filter(Boolean).join("\n\n");
      setNoteText(composed);
      setNoteRewriteVariants([]);
    } catch (e: any) { toastErr(`加载失败：${e?.message || e}`); }
    finally { setFetching(false); }
  };

  // ── 一键提取：拉作品 → 全选源图 → 自动 OCR 所有 ────────────────────────
  const handleOneClickExtract = async () => {
    const u = postUrl.trim();
    if (!u) { toastErr("请输入作品链接"); return; }
    setFetching(true);
    setPost(null);
    setExtractedText("");
    setOcrTexts({});
    setOcrStatus({});
    setOcrErrors({});
    try {
      const r = await fetch(IMAGE_API("/fetch-post-cover"), {
        method: "POST", headers, body: JSON.stringify({ url: u }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        toastErr(data.error || data.detail || "拉取失败"); return;
      }
      const fetched = {
        images: data.images || [],
        image_urls: data.image_urls || data.images || [],
        title: data.title || "", desc: data.desc || "",
        platform: data.platform || "", platform_label: data.platform_label || "",
        post_id: data.post_id || "", post_url: data.post_url || u,
      };
      setPost(fetched);
      const composed = [fetched.title, fetched.desc].filter(Boolean).join("\n\n");
      setNoteText(composed);
      setNoteRewriteVariants([]);
      // 默认勾选全部源图
      const allIdxs = fetched.images.map((_, i) => i);
      setSourceImgIdxs(allIdxs);
      // 提取完后正文 + OCR 都默认折叠（用户按需展开）
      setNoteCardExpanded(false);
      // 立刻并发 OCR 所有图（绕过 state 还没更新的 sourceImgIdxs，直接用 allIdxs）
      setOcring(true);
      try {
        await Promise.allSettled(allIdxs.map(async (idx) => {
          const imgUrl = fetched.image_urls[idx] || fetched.images[idx];
          if (!imgUrl) return;
          setOcrStatus((s) => ({ ...s, [idx]: "running" }));
          try {
            const r2 = await fetch(IMAGE_API("/text-remix/extract-text"), {
              method: "POST", headers,
              body: JSON.stringify({ image_url: imgUrl, model_id: ocrModelId }),
            });
            const d = await r2.json();
            if (!r2.ok) {
              setOcrStatus((s) => ({ ...s, [idx]: "error" }));
              setOcrErrors((s) => ({ ...s, [idx]: d.detail || "未知错误" })); return;
            }
            setOcrTexts((s) => ({ ...s, [idx]: (d.text || "").trim() }));
            setOcrStatus((s) => ({ ...s, [idx]: "done" }));
          } catch (e: any) {
            setOcrStatus((s) => ({ ...s, [idx]: "error" }));
            setOcrErrors((s) => ({ ...s, [idx]: e?.message || String(e) }));
          }
        }));
        toastOk(`一键提取完成：${allIdxs.length} 张图 OCR 已并发跑完`);
        // OCR 跑完默认折叠展开方便预览，但用户可点收起
        setOcrPanelExpanded(true);
      } finally { setOcring(false); }
    } catch (e: any) { toastErr(`一键提取失败：${e?.message || e}`); }
    finally { setFetching(false); }
  };

  // AI 改写正文
  const handleRewriteNote = async () => {
    const t = noteText.trim();
    if (!t) { toastErr("正文为空，无可改写"); return; }
    setNoteRewriting(true);
    setNoteRewriteVariants([]);
    try {
      const r = await fetch(IMAGE_API("/text-remix/rewrite-text"), {
        method: "POST", headers,
        body: JSON.stringify({
          text: t,
          model_id: ocrModelId,   // 复用 OCR 选的文本/视觉模型（实际用文本能力）
          style_hint: noteRewriteHint,
          n_variants: 3,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toastErr(`改写失败：${d.detail || "未知错误"}`); return; }
      setNoteRewriteVariants(d.variants || []);
      toastOk(`生成 ${(d.variants || []).length} 个改写版本`);
    } catch (e: any) { toastErr(`改写失败：${e?.message || e}`); }
    finally { setNoteRewriting(false); }
  };

  // ── 步骤 2：OCR ───────────────────────────────────────────────────────
  // ocrTexts[idx] = 该源图的提取文字（用户可编辑）；ocrStatus[idx]: idle/running/done/error
  const [ocrTexts, setOcrTexts] = useState<Record<number, string>>({});
  const [ocrStatus, setOcrStatus] = useState<Record<number, "idle" | "running" | "done" | "error">>({});
  const [ocrErrors, setOcrErrors] = useState<Record<number, string>>({});
  const [ocring, setOcring] = useState(false);
  const [ocrModelId, setOcrModelId] = useState<number | null>(null);

  // 兼容旧缓存：把合并的 extractedText 拆到 ocrTexts[0]
  const [extractedText, setExtractedText] = useState("");  // 仅用于 localStorage 兼容
  useEffect(() => {
    if (extractedText && Object.keys(ocrTexts).length === 0) {
      setOcrTexts({ 0: extractedText });
      setExtractedText("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractedText]);

  const _ocrOne = async (idx: number): Promise<void> => {
    if (!post) return;
    const imgUrl = post.image_urls[idx] || post.images[idx];
    if (!imgUrl) return;
    setOcrStatus((s) => ({ ...s, [idx]: "running" }));
    setOcrErrors((s) => ({ ...s, [idx]: "" }));
    try {
      const r = await fetch(IMAGE_API("/text-remix/extract-text"), {
        method: "POST", headers,
        body: JSON.stringify({ image_url: imgUrl, model_id: ocrModelId }),
      });
      const data = await r.json();
      if (!r.ok) {
        setOcrStatus((s) => ({ ...s, [idx]: "error" }));
        setOcrErrors((s) => ({ ...s, [idx]: data.detail || "未知错误" }));
        return;
      }
      setOcrTexts((s) => ({ ...s, [idx]: (data.text || "").trim() }));
      setOcrStatus((s) => ({ ...s, [idx]: "done" }));
    } catch (e: any) {
      setOcrStatus((s) => ({ ...s, [idx]: "error" }));
      setOcrErrors((s) => ({ ...s, [idx]: e?.message || String(e) }));
    }
  };

  const handleExtract = async () => {
    if (!post || sourceImgIdxs.length === 0) { toastErr("请至少选一张源图"); return; }
    setOcring(true);
    try {
      // 并发跑所有选中的源图（Promise.allSettled 不会因单张失败中断其他）
      await Promise.allSettled(sourceImgIdxs.map((idx) => _ocrOne(idx)));
      // 统计
      const ok = sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length;
      toastOk(`OCR 完成（具体看每张下方文字框）`);
    } finally { setOcring(false); }
  };

  const toggleSourceImg = (i: number) => {
    setSourceImgIdxs((prev) => {
      const has = prev.includes(i);
      if (has) {
        const next = prev.filter((x) => x !== i);
        return next.length ? next : [i];  // 至少留 1 张
      }
      return [...prev, i].sort((a, b) => a - b);
    });
  };

  // ── 步骤 3：背景图管理 ────────────────────────────────────────────────
  const [backgrounds, setBackgrounds] = useState<Background[]>([]);
  const [bgLoading, setBgLoading] = useState(false);
  // 多选背景图：每张都按 count 数量生成
  const [selectedBgIds, setSelectedBgIds] = useState<number[]>([]);

  const loadBackgrounds = useCallback(async () => {
    setBgLoading(true);
    try {
      const r = await fetch(IMAGE_API("/text-remix/backgrounds"), { headers });
      if (r.ok) {
        const d = await r.json();
        setBackgrounds(d.backgrounds || []);
      }
    } finally { setBgLoading(false); }
  }, [headers]);

  useEffect(() => { loadBackgrounds(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // 上传进度：null=未开始；0-100=上传中；"processing"=已传完等后端
  // 用 XHR 而非 fetch，浏览器不支持 fetch 上传进度回调
  const [uploadProgress, setUploadProgress] = useState<number | "processing" | null>(null);
  const [uploadingName, setUploadingName] = useState<string>("");
  const [uploadPreview, setUploadPreview] = useState<string>("");

  const handleUploadBg = async (file: File) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { toastErr("文件超过 50MB"); return; }
    const name = window.prompt("命名这张背景图（可选）：", file.name) || file.name;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);

    setUploadingName(name);
    setUploadProgress(0);
    // 本地预览，先放一张占位图在网格里
    const localUrl = URL.createObjectURL(file);
    setUploadPreview(localUrl);

    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", IMAGE_API("/text-remix/backgrounds"));
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
          }
        };
        xhr.upload.onload = () => setUploadProgress("processing");
        xhr.onerror = () => reject(new Error("网络错误"));
        xhr.onload = () => {
          try {
            const data = JSON.parse(xhr.responseText || "{}");
            if (xhr.status >= 200 && xhr.status < 300) {
              toastOk(`背景图已上传：${name}`);
              setSelectedBgIds((prev) => [...prev, data.id]);
              loadBackgrounds().then(() => resolve());
            } else {
              reject(new Error(data.detail || `HTTP ${xhr.status}`));
            }
          } catch (e: any) {
            reject(new Error(e?.message || "解析响应失败"));
          }
        };
        xhr.send(fd);
      });
    } catch (e: any) {
      toastErr(`上传失败：${e?.message || e}`);
    } finally {
      setUploadProgress(null);
      setUploadingName("");
      URL.revokeObjectURL(localUrl);
      setUploadPreview("");
    }
  };

  const handleDeleteBg = async (id: number) => {
    if (!confirm("确认删除这张背景图模板？")) return;
    const r = await fetch(IMAGE_API(`/text-remix/backgrounds/${id}`), {
      method: "DELETE", headers,
    });
    if (r.ok) {
      setSelectedBgIds((prev) => prev.filter((x) => x !== id));
      await loadBackgrounds();
    }
  };

  const toggleBg = (id: number) => {
    setSelectedBgIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // ── 步骤 4：生成（异步任务，对标 整体仿写） ─────────────────────────────
  const [count, setCount] = useState(3);          // 默认一次生成 3 套
  const [genSize, setGenSize] = useState("");     // 自定义图片尺寸；空 = 用模型默认
  const [styleHint, setStyleHint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [imageModelId, setImageModelId] = useState<number | null>(null);
  const bgFileRef = useRef<HTMLInputElement | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [activeTask, setActiveTask] = useState<TextRemixTask | null>(null);
  const [tasks, setTasks] = useState<TextRemixTask[]>([]);
  // 同步飞书状态：taskId+setIdx → "syncing"|"done"|"error"
  const [syncStatus, setSyncStatus] = useState<Record<string, string>>({});
  // 当前活动任务里勾选的 set idx 集合（用于"批量同步飞书"）
  const [selectedSetIdxs, setSelectedSetIdxs] = useState<number[]>([]);
  const [batchSyncing, setBatchSyncing] = useState(false);

  // ── localStorage 缓存：刷新页面后状态不丢 ─────────────────────────────
  const _firstLoad = useRef(true);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.postUrl) setPostUrl(d.postUrl);
      if (typeof d.extractedText === "string" && d.extractedText) setExtractedText(d.extractedText);  // 老版本兼容
      if (d.ocrTexts && typeof d.ocrTexts === "object") setOcrTexts(d.ocrTexts);
      if (Array.isArray(d.sourceImgIdxs) && d.sourceImgIdxs.length > 0) setSourceImgIdxs(d.sourceImgIdxs);
      if (typeof d.ocrModelId === "number") setOcrModelId(d.ocrModelId);
      if (typeof d.styleHint === "string") setStyleHint(d.styleHint);
      if (typeof d.count === "number") setCount(d.count);
      if (typeof d.genSize === "string") setGenSize(d.genSize);
      if (Array.isArray(d.selectedBgIds)) setSelectedBgIds(d.selectedBgIds);
      if (typeof d.imageModelId === "number") setImageModelId(d.imageModelId);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [PERSIST_KEY]);
  useEffect(() => {
    if (_firstLoad.current) { _firstLoad.current = false; return; }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        postUrl, ocrTexts, sourceImgIdxs, ocrModelId, styleHint, count, genSize, selectedBgIds, imageModelId,
      }));
    } catch {}
  }, [postUrl, ocrTexts, sourceImgIdxs, ocrModelId, styleHint, count, genSize, selectedBgIds, PERSIST_KEY]);

  // 提交异步任务：POST /text-remix-tasks → 拿 task_id → 轮询
  const handleSubmit = async () => {
    const validSources = sourceImgIdxs.filter((idx) => (ocrTexts[idx] || "").trim());
    if (validSources.length === 0) { toastErr("没有可用的提取文字。请先 OCR 至少一张源图"); return; }
    if (selectedBgIds.length === 0) { toastErr("请至少选一张背景图"); return; }
    setSubmitting(true);
    try {
      const r = await fetch(IMAGE_API("/text-remix-tasks"), {
        method: "POST", headers,
        body: JSON.stringify({
          post_url: post?.post_url || "",
          post_title: post?.title || "",
          platform: post?.platform || "",
          text_sources: validSources.map((idx) => ({
            src_idx: idx, text: (ocrTexts[idx] || "").trim(),
          })),
          background_ids: selectedBgIds,
          count,
          size: genSize || undefined,
          style_hint: styleHint.trim(),
          image_model_id: imageModelId,
        }),
      });
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const txt = await r.text();
      let data: any = {};
      if (ct.includes("application/json")) {
        try { data = txt ? JSON.parse(txt) : {}; } catch { data = {}; }
      } else if (txt.trim().startsWith("<")) {
        data = { detail: `网关返回 HTML（HTTP ${r.status}），${txt.slice(0, 60)}…` };
      } else {
        data = { detail: txt.slice(0, 200) || `HTTP ${r.status}` };
      }
      if (!r.ok || !data.task_id) {
        toastErr(`提交失败：${data.detail || `HTTP ${r.status}`}`);
        return;
      }
      const tid = data.task_id as number;
      const totalImgs = count * validSources.length * selectedBgIds.length;
      toastOk(`已提交任务 #${tid}（${count} 套 / ${totalImgs} 张），worker 开始处理…`);
      setActiveTaskId(tid);
      pollActive(tid);
      reloadTasks();
    } catch (e: any) {
      toastErr(`提交异常：${e?.message || e}`);
    } finally { setSubmitting(false); }
  };

  // 拉单条任务（进度 + 结果）
  const pollActive = useCallback(async (tid: number) => {
    try {
      const r = await fetch(IMAGE_API(`/text-remix-tasks/${tid}`), { headers });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.task) setActiveTask(d.task as TextRemixTask);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // 轮询 active task：4s 一次，done/error/cancelled 自动停
  useEffect(() => {
    if (!activeTaskId) return;
    pollActive(activeTaskId);
    const id = setInterval(() => {
      if (activeTask && ["done", "error", "cancelled"].includes(activeTask.status)) return;
      pollActive(activeTaskId);
    }, 4000);
    return () => clearInterval(id);
  }, [activeTaskId, pollActive, activeTask]);

  // 历史任务列表
  const reloadTasks = useCallback(async () => {
    try {
      const r = await fetch(IMAGE_API("/text-remix-tasks?limit=30"), { headers });
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d?.tasks)) setTasks(d.tasks as TextRemixTask[]);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { reloadTasks(); }, [reloadTasks]);
  // 有 active task 时定时刷新历史（看新一条进度）
  useEffect(() => {
    if (!activeTaskId) return;
    const id = setInterval(reloadTasks, 6000);
    return () => clearInterval(id);
  }, [activeTaskId, reloadTasks]);

  const cancelTask = async (tid: number) => {
    if (!confirm(`确认取消任务 #${tid}？已生成的图保留，未跑的套停止。`)) return;
    const r = await fetch(IMAGE_API(`/text-remix-tasks/${tid}/cancel`), {
      method: "POST", headers,
    });
    if (r.ok) {
      toastOk("已请求取消，worker 跑完当前套后停");
      pollActive(tid);
      reloadTasks();
    } else { toastErr("取消失败"); }
  };
  const cloneTask = async (tid: number) => {
    const r = await fetch(IMAGE_API(`/text-remix-tasks/${tid}/clone`), {
      method: "POST", headers,
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.task_id) {
      toastOk(`已克隆为新任务 #${d.task_id}`);
      setActiveTaskId(d.task_id);
      pollActive(d.task_id);
      reloadTasks();
    } else { toastErr(`克隆失败：${d.detail || "未知"}`); }
  };
  const deleteTask = async (tid: number) => {
    if (!confirm(`确认删除任务 #${tid}？图片记录不会被删，只删任务条目。`)) return;
    const r = await fetch(IMAGE_API(`/text-remix-tasks/${tid}`), {
      method: "DELETE", headers,
    });
    if (r.ok) {
      toastOk("已删除");
      if (activeTaskId === tid) { setActiveTaskId(null); setActiveTask(null); }
      reloadTasks();
    } else {
      const d = await r.json().catch(() => ({}));
      toastErr(`删除失败：${d.detail || "未知"}`);
    }
  };

  // 单套整套下载：依次触发浏览器下载（命名 text_remix_task{ID}_set{N}_img{K}.png）
  const downloadFromUrl = async (url: string, fname: string) => {
    try {
      const res = await fetch(proxyUrl(url));
      const blob = await res.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = fname; a.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    } catch (e: any) { toastErr(`下载失败：${e?.message || e}`); }
  };
  const downloadSet = async (task: TextRemixTask, setIdx: number, items: TaskCell[]) => {
    const ok = items.filter((c) => c.image_url);
    if (ok.length === 0) { toastErr("这套没有可下载的图片"); return; }
    toastOk(`开始下载第 ${setIdx} 套（共 ${ok.length} 张）`);
    for (let i = 0; i < ok.length; i++) {
      const ext = (ok[i].image_url.split(".").pop()?.split("?")[0] || "png").slice(0, 5);
      const fname = `text_remix_task${task.id}_set${setIdx}_img${i + 1}.${ext}`;
      await downloadFromUrl(ok[i].image_url, fname);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  // 套切换 / 全选 / 反选
  const toggleSetSelected = (setIdx: number) => {
    setSelectedSetIdxs((prev) => prev.includes(setIdx)
      ? prev.filter((x) => x !== setIdx)
      : [...prev, setIdx].sort((a, b) => a - b));
  };
  const selectAllReadySets = (task: TextRemixTask) => {
    const ready = task.items.filter((s) => s.items.some((c) => c.image_url)).map((s) => s.idx);
    setSelectedSetIdxs(ready);
  };

  // 批量同步选中的多套到飞书（串行，避免飞书 rate limit + sync-bitable 内部加锁竞争）
  const batchSyncSelectedToFeishu = async (task: TextRemixTask) => {
    if (selectedSetIdxs.length === 0) { toastErr("请先勾选要同步的套"); return; }
    setBatchSyncing(true);
    let ok = 0, fail = 0;
    try {
      for (const sidx of selectedSetIdxs) {
        try {
          await syncSetToFeishu(task, sidx);
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      toastOk(`批量同步完成：成功 ${ok}，失败 ${fail}`);
    } finally { setBatchSyncing(false); }
  };

  // 把一套结果同步到飞书：复用 /history/sync-bitable（按 image_gen_history.id）
  // 后端按 (batch_id, set_idx) 自动聚合一行；text-remix worker 用 batch_id=text_remix:{tid}
  const syncSetToFeishu = async (task: TextRemixTask, setIdx: number) => {
    const key = `${task.id}:${setIdx}`;
    setSyncStatus((s) => ({ ...s, [key]: "syncing" }));
    try {
      // 找到这套对应的 image_gen_history.id 列表：拉一下用户最近的历史，匹配 batch_id+set_idx
      const r1 = await fetch(IMAGE_API(`/history?limit=300`), { headers });
      const h = await r1.json().catch(() => ({}));
      const all: any[] = h?.records || h?.history || [];
      const myIds: number[] = all
        .filter((x) => x.batch_id === `text_remix:${task.id}` && Number(x.set_idx) === setIdx)
        .map((x) => x.id);
      if (myIds.length === 0) {
        setSyncStatus((s) => ({ ...s, [key]: "error" }));
        toastErr(`第 ${setIdx} 套没找到可同步的历史记录（图片可能还在上传中）`);
        return;
      }
      const r2 = await fetch(IMAGE_API("/history/sync-bitable"), {
        method: "POST", headers,
        body: JSON.stringify({ record_ids: myIds }),
      });
      const d = await r2.json().catch(() => ({}));
      if (!r2.ok || d?.error) {
        setSyncStatus((s) => ({ ...s, [key]: "error" }));
        toastErr(`同步失败：${d?.error || d?.detail || `HTTP ${r2.status}`}`);
        return;
      }
      setSyncStatus((s) => ({ ...s, [key]: "done" }));
      toastOk(`第 ${setIdx} 套已同步到飞书（${myIds.length} 张）`);
    } catch (e: any) {
      setSyncStatus((s) => ({ ...s, [key]: "error" }));
      toastErr(`同步异常：${e?.message || e}`);
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* 头 */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center">
          <Wand2 size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            文案换背景
            <Chip size="sm" variant="flat" color="secondary">MVP</Chip>
          </h1>
          <p className="text-sm text-default-500 mt-1">
            扒原作品图里的文字（OCR） + 用户上传/选择背景图 → AI 把文字按背景风格重绘出新图。
          </p>
        </div>
      </div>

      {/* 步骤 1：链接 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Link2 size={16} />
            <span className="font-medium">① 输入作品链接</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-2">
          <div className="flex gap-2 flex-wrap">
            <Input value={postUrl} onValueChange={setPostUrl}
              placeholder="粘贴小红书 / 抖音作品链接"
              size="sm" className="flex-1 min-w-[260px]" />
            <Button color="default" variant="flat" size="sm" startContent={<Link2 size={14} />}
              isLoading={fetching && !ocring} onPress={handleFetch}>仅拉取</Button>
            <Button color="primary" size="sm" startContent={<Sparkles size={14} />}
              isLoading={fetching || ocring} onPress={handleOneClickExtract}>
              一键提取（拉取 + 全图 OCR）
            </Button>
          </div>
          <p className="text-[11px] text-default-400">
            一键提取：自动选中所有图片并并发 OCR，省去逐张点击。
          </p>
        </CardBody>
      </Card>

      {/* 步骤 2：笔记原文（图文笔记的文章） */}
      {post && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full gap-3 flex-wrap">
              <button type="button"
                onClick={() => setNoteCardExpanded((v) => !v)}
                className="flex items-center gap-2 hover:opacity-80">
                {noteCardExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <FileText size={16} />
                <span className="font-medium">② 笔记原文</span>
                <Chip size="sm" variant="flat">
                  {noteText ? `${noteText.length} 字` : "空"}
                </Chip>
                {noteRewriteVariants.length > 0 && (
                  <Chip size="sm" color="success" variant="flat">{noteRewriteVariants.length} 个改写</Chip>
                )}
              </button>
              {noteCardExpanded && (
                <div className="flex items-end gap-2">
                  <Input size="sm" labelPlacement="outside" label="改写额外提示（可选）"
                    placeholder="如：更口语化 / 加 emoji / 分点"
                    value={noteRewriteHint} onValueChange={setNoteRewriteHint}
                    className="min-w-[220px]" />
                  <Button color="secondary" size="sm" isLoading={noteRewriting}
                    startContent={<Sparkles size={14} />}
                    isDisabled={!noteText.trim() || noteRewriting}
                    onPress={handleRewriteNote}>
                    AI 改写（3 个版本）
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          {noteCardExpanded && (
            <CardBody className="space-y-3">
              <div>
                <p className="text-xs text-default-500 mb-1">原文（可编辑，作为改写输入）</p>
                <textarea
                  className="w-full border border-divider rounded-md p-2 text-sm bg-background min-h-[100px]"
                  placeholder="拉取后自动填充。可手动编辑后再改写。"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
              </div>
              {noteRewriteVariants.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-default-700 font-medium">改写结果</p>
                  {noteRewriteVariants.map((v, i) => (
                    <div key={i} className="rounded-md border border-default-200 p-2 bg-content1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] text-default-500">版本 {i + 1}</span>
                        <div className="flex gap-1">
                          <Button size="sm" variant="light" startContent={<Copy size={12} />}
                            onPress={() => {
                              navigator.clipboard.writeText(v).then(
                                () => toastOk("已复制到剪贴板"),
                                () => toastErr("复制失败"),
                              );
                            }}>复制</Button>
                          <Button size="sm" variant="flat" color="primary"
                            onPress={() => { setNoteText(v); toastOk(`已采用版本 ${i + 1}`); }}>
                            采用
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs whitespace-pre-wrap text-default-700">{v}</p>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-default-400">
                提示：改写出的文案可"复制"或"采用"覆盖原文，或手动粘贴到下面任一图片的文字框作为生图素材。
              </p>
            </CardBody>
          )}
        </Card>
      )}

      {/* 步骤 3：选图 + OCR */}
      {post && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <ImageIcon size={16} />
                <span className="font-medium">③ 选源图，提取文字</span>
                <Chip size="sm" variant="flat">{post.images.length} 张</Chip>
                <Chip size="sm" variant="flat" color="primary">已选 {sourceImgIdxs.length}</Chip>
              </div>
              <div className="flex items-end gap-2 flex-wrap">
                <Button size="sm" variant="flat"
                  onPress={() => setSourceImgIdxs(post.images.map((_, i) => i))}
                  isDisabled={sourceImgIdxs.length === post.images.length}>
                  全选
                </Button>
                <Button size="sm" variant="flat"
                  onPress={() => {
                    const all = post.images.map((_, i) => i);
                    const next = all.filter((i) => !sourceImgIdxs.includes(i));
                    setSourceImgIdxs(next.length ? next : [0]);
                  }}>反选</Button>
                <Button size="sm" variant="light"
                  onPress={() => setSourceImgIdxs([0])}>清空（保留 1）</Button>
                <ModelSelector
                  usage="text"
                  value={ocrModelId}
                  onChange={setOcrModelId}
                  label="OCR 模型（需支持视觉）"
                  className="min-w-[200px]"
                />
                <Button color="secondary" size="sm" isLoading={ocring}
                  onPress={handleExtract}
                  isDisabled={!post.images.length || sourceImgIdxs.length === 0}>
                  并发提取所有选中（{sourceImgIdxs.length} 张）
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
              {post.images.map((u, i) => {
                const on = sourceImgIdxs.includes(i);
                const src = u.startsWith("data:") ? u : proxyUrl(u);
                return (
                  <div key={i}
                    className={`relative aspect-square rounded-md overflow-hidden border-2 transition group cursor-pointer ${
                      on ? "border-secondary" : "border-transparent hover:border-default-300"
                    }`}
                    onClick={() => toggleSourceImg(i)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`图 ${i + 1}`}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover" />
                    <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 rounded">
                      {i + 1}
                    </span>
                    {on && (
                      <span className="absolute top-1 right-1 bg-secondary text-white text-[10px] px-1.5 rounded flex items-center gap-0.5">
                        <Check size={10} />
                      </span>
                    )}
                    {/* 放大查看（独立按钮，不触发勾选） */}
                    <button type="button"
                      onClick={(e) => { e.stopPropagation(); setPreviewSrc(u.startsWith("data:") ? u : proxyUrl(u)); }}
                      title="查看大图"
                      className="absolute bottom-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded opacity-0 group-hover:opacity-100 transition">
                      <ZoomIn size={12} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* OCR 结果：每张选中图独立一行（小预览 + 文字框 + 状态 + 重试） */}
            {sourceImgIdxs.length > 0 && (
              <div className="space-y-2">
                <button type="button"
                  onClick={() => setOcrPanelExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-xs text-default-700 hover:opacity-80">
                  {ocrPanelExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>
                    OCR 结果（{sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length} / {sourceImgIdxs.length} 已提取）
                  </span>
                  <span className="text-default-400">— 点击{ocrPanelExpanded ? "折叠" : "展开"}</span>
                </button>
                {ocrPanelExpanded && (
                  <p className="text-xs text-default-500">
                    每张源图独立提取，可单独编辑/重试；生成时按每张文字配每张背景产出。
                  </p>
                )}
                {ocrPanelExpanded && sourceImgIdxs.map((idx) => {
                  const u = post.images[idx];
                  const txt = ocrTexts[idx] || "";
                  const st = ocrStatus[idx] || "idle";
                  const err = ocrErrors[idx] || "";
                  return (
                    <div key={idx} className="flex gap-2 items-start p-2 rounded-md border border-default-200 bg-content1">
                      <button type="button"
                        onClick={() => setPreviewSrc(u?.startsWith("data:") ? u : proxyUrl(u || ""))}
                        title="点击看大图，方便对照文字"
                        className="relative w-20 h-20 shrink-0 rounded overflow-hidden bg-default-100 group">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={u?.startsWith("data:") ? u : proxyUrl(u || "")}
                          referrerPolicy="no-referrer" alt={`图 ${idx + 1}`}
                          className="w-full h-full object-cover transition group-hover:scale-105" />
                        <span className="absolute top-0.5 left-0.5 bg-black/60 text-white text-[9px] px-1 rounded">
                          {idx + 1}
                        </span>
                        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition">
                          <ZoomIn size={16} className="text-white" />
                        </span>
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] text-default-500">
                            第 {idx + 1} 张
                            {st === "running" && <span className="ml-2 text-secondary">提取中…</span>}
                            {st === "done" && <span className="ml-2 text-success-600">✓ 已提取（可编辑）</span>}
                            {st === "error" && <span className="ml-2 text-danger">提取失败</span>}
                          </span>
                          <button type="button"
                            disabled={st === "running"}
                            onClick={() => _ocrOne(idx)}
                            className="text-[11px] text-primary hover:underline disabled:opacity-40">
                            {st === "done" || st === "error" ? "重新提取" : "提取"}
                          </button>
                        </div>
                        <textarea
                          className="w-full border border-divider rounded-md p-2 text-xs bg-background min-h-[70px]"
                          placeholder={st === "running" ? "提取中…" : "（空 / 点右上「提取」按钮）"}
                          value={txt}
                          onChange={(e) => setOcrTexts((s) => ({ ...s, [idx]: e.target.value }))}
                        />
                        {err && (
                          <p className="text-[10px] text-danger mt-0.5">{err.slice(0, 200)}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* 步骤 3：背景图选择 / 上传 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              <ImageIcon size={16} />
              <span className="font-medium">④ 选择 / 上传背景图</span>
              <Chip size="sm" variant="flat">{backgrounds.length}</Chip>
            </div>
            {/* 显式 ref 触发 file picker：避免 label+hidden input 在某些浏览器/扩展下不响应 */}
            <input ref={bgFileRef} type="file" accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUploadBg(f);
                e.target.value = "";  // 允许重复选择同一个文件
              }} />
            <Button size="sm" variant="flat" color="primary"
              startContent={uploadProgress === null ? <Upload size={14} /> : undefined}
              isLoading={uploadProgress !== null}
              isDisabled={uploadProgress !== null}
              onPress={() => bgFileRef.current?.click()}>
              {uploadProgress === null
                ? "上传新背景"
                : uploadProgress === "processing"
                  ? "服务器处理中…"
                  : `上传中 ${uploadProgress}%`}
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {bgLoading ? (
            <div className="text-default-400 text-sm">加载中…</div>
          ) : backgrounds.length === 0 && uploadProgress === null ? (
            <div className="text-center py-6 text-default-400 text-sm space-y-2">
              <ImageIcon size={28} className="mx-auto opacity-30" />
              <p>还没上传过背景图</p>
              <Button size="sm" color="primary" variant="flat"
                startContent={<Upload size={14} />}
                onPress={() => bgFileRef.current?.click()}>
                上传第一张背景图
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
              {/* 上传中占位卡片：放最前面，跟用户的眼神先一致 */}
              {uploadProgress !== null && (
                <div className="relative aspect-square rounded-md overflow-hidden border-2 border-primary/60 bg-default-50">
                  {uploadPreview ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={uploadPreview} alt="上传预览"
                      className="w-full h-full object-cover opacity-60" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon size={24} className="opacity-30" />
                    </div>
                  )}
                  {/* 中间半透明遮罩 + 状态文字 */}
                  <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center text-white text-[11px] gap-1">
                    <Spinner size="sm" color="white" />
                    <span className="font-medium">
                      {uploadProgress === "processing"
                        ? "处理中…"
                        : `${uploadProgress}%`}
                    </span>
                  </div>
                  {/* 底部进度条 */}
                  {typeof uploadProgress === "number" && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-default-200">
                      <div className="h-full bg-primary transition-all"
                        style={{ width: `${uploadProgress}%` }} />
                    </div>
                  )}
                  <span className="absolute top-0 left-0 right-0 bg-primary/80 text-white text-[10px] px-1 py-0.5 truncate">
                    {uploadingName || "上传中"}
                  </span>
                </div>
              )}
              {backgrounds.map((bg) => {
                const on = selectedBgIds.includes(bg.id);
                return (
                <div key={bg.id}
                  className={`relative aspect-square rounded-md overflow-hidden border-2 transition cursor-pointer group ${
                    on ? "border-secondary" : "border-transparent hover:border-default-300"
                  }`}
                  onClick={() => toggleBg(bg.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={proxyUrl(bg.image_url)} alt={bg.name}
                    className="w-full h-full object-cover" />
                  <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate">
                    {bg.name}
                  </span>
                  {on && (
                    <span className="absolute top-1 right-1 bg-secondary text-white text-[10px] px-1.5 rounded flex items-center gap-0.5">
                      <Check size={10} />
                    </span>
                  )}
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeleteBg(bg.id); }}
                    className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 bg-danger text-white p-1 rounded transition">
                    <Trash2 size={10} />
                  </button>
                </div>
              );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 步骤 4：生成参数 + 触发 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wand2 size={16} />
            <span className="font-medium">⑤ 生成</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          {/* 套数（对标整体仿写）：每套 = 全部源 × 全部背景 各跑一次 */}
          <div className="space-y-2">
            <p className="text-sm text-default-700">
              想要几套？（每套 = <b className="text-secondary">
                {sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length || "?"}
              </b> 源文字 × <b className="text-secondary">
                {selectedBgIds.length || "?"}
              </b> 背景 = <b className="text-secondary">
                {(sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length || 0) * (selectedBgIds.length || 0)}
              </b> 张图）
            </p>
            <div className="flex flex-wrap gap-2 items-center">
              {[1, 2, 3, 5, 10].map((c) => (
                <button key={c} type="button"
                  onClick={() => setCount(c)}
                  className={`px-4 py-1.5 rounded-md text-sm border transition-colors ${
                    count === c
                      ? "bg-secondary text-white border-secondary"
                      : "border-divider text-default-600 hover:bg-default-100"
                  }`}>{c} 套</button>
              ))}
              <Input type="number" min={1} max={30} size="sm" className="w-24"
                value={String(count)}
                onValueChange={(v) => {
                  const n = parseInt(v, 10);
                  if (!isNaN(n)) setCount(Math.max(1, Math.min(30, n)));
                }} />
            </div>
            <p className="text-[11px] text-default-400">
              上限 30 套。前端限 3 并发跑上游图像 API，单张约 30s。
            </p>
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            <ModelSelector
              usage="image"
              value={imageModelId}
              onChange={setImageModelId}
              label="图像生成模型"
              className="min-w-[220px]"
            />
            <div className="min-w-[200px]">
              <p className="text-xs text-default-500 mb-1">图片尺寸（留空 = 模型默认）</p>
              <select
                className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={genSize}
                onChange={(e) => setGenSize(e.target.value)}>
                <option value="">使用模型默认尺寸</option>
                {SIZE_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <Input size="sm" label="风格提示（可选）" labelPlacement="outside"
                placeholder="如：小红书风 / 简约清新 / 高级感"
                value={styleHint} onValueChange={setStyleHint} />
            </div>
          </div>
          <Button color="secondary" size="lg" className="w-full"
            startContent={<Wand2 size={18} />}
            isLoading={submitting}
            isDisabled={
              sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length === 0
              || selectedBgIds.length === 0 || submitting
            }
            onPress={handleSubmit}>
            {(() => {
              const valid = sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length;
              const perSet = valid * selectedBgIds.length;
              const total = perSet * count;
              return submitting ? "提交中…" : `提交任务：${count} 套 × ${perSet} 张/套 = ${total} 张`;
            })()}
          </Button>
          {sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length === 0 && (
            <p className="text-xs text-warning-600 flex items-center gap-1">
              <AlertCircle size={12} />请先 OCR 至少一张源图（点上方每行的「提取」）
            </p>
          )}
          {sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length > 0 && selectedBgIds.length === 0 && (
            <p className="text-xs text-warning-600 flex items-center gap-1">
              <AlertCircle size={12} />请至少选一张背景图（可多选）
            </p>
          )}
        </CardBody>
      </Card>

      {/* 活动任务（提交后展开 + 实时进度） */}
      {activeTask && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="font-medium">任务 #{activeTask.id}</span>
                <Chip size="sm" variant="flat"
                  color={
                    activeTask.status === "done" ? "success" :
                    activeTask.status === "running" ? "primary" :
                    activeTask.status === "pending" ? "default" :
                    activeTask.status === "cancelled" ? "warning" : "danger"
                  }>
                  {activeTask.status === "pending" ? "排队中" :
                    activeTask.status === "running" ? "生成中" :
                    activeTask.status === "done" ? "已完成" :
                    activeTask.status === "cancelled" ? "已取消" : "失败"}
                </Chip>
                <span className="text-xs text-default-500">
                  {activeTask.done_count} / {activeTask.count} 套
                </span>
              </div>
              <div className="flex gap-1">
                {["pending", "running"].includes(activeTask.status) && (
                  <Button size="sm" variant="flat" color="warning"
                    onPress={() => cancelTask(activeTask.id)}>取消</Button>
                )}
                {["done", "error", "cancelled"].includes(activeTask.status) && (
                  <>
                    <Button size="sm" variant="flat"
                      onPress={() => cloneTask(activeTask.id)}>用相同参数重跑</Button>
                    <Button size="sm" variant="flat" color="danger"
                      startContent={<Trash2 size={12} />}
                      onPress={() => deleteTask(activeTask.id)}>删除</Button>
                  </>
                )}
                <Button size="sm" variant="light"
                  onPress={() => { setActiveTaskId(null); setActiveTask(null); setSelectedSetIdxs([]); }}>
                  收起
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            {activeTask.error && (
              <p className="text-xs text-danger p-2 rounded bg-danger/5">
                <AlertCircle size={12} className="inline mr-1" />{activeTask.error}
              </p>
            )}
            {/* 飞书批量同步工具栏 */}
            {activeTask.items.length > 0 && (
              <div className="space-y-2">
                <BitablePushToggle />
                <div className="flex items-center justify-between gap-2 flex-wrap p-2 rounded-md bg-default-50 border border-default-200">
                  <div className="flex items-center gap-2 text-xs text-default-600">
                    <span>已勾选 <b className="text-primary">{selectedSetIdxs.length}</b> 套</span>
                    <Button size="sm" variant="flat"
                      onPress={() => selectAllReadySets(activeTask)}>
                      全选有图的
                    </Button>
                    <Button size="sm" variant="light"
                      onPress={() => setSelectedSetIdxs([])}
                      isDisabled={selectedSetIdxs.length === 0}>清空</Button>
                  </div>
                  <Button size="sm" color="primary"
                    isLoading={batchSyncing}
                    isDisabled={selectedSetIdxs.length === 0 || batchSyncing}
                    onPress={() => batchSyncSelectedToFeishu(activeTask)}>
                    批量同步到飞书（{selectedSetIdxs.length} 套）
                  </Button>
                </div>
              </div>
            )}
            {activeTask.items.length === 0 && (
              <div className="flex items-center justify-center py-8 text-default-500 text-sm">
                <Spinner size="sm" color="secondary" className="mr-2" />
                worker 排队中（每 10 秒扫一次）…
              </div>
            )}
            {activeTask.items.map((set) => {
              const okCount = set.items.filter((c) => c.image_url).length;
              const totalCount = set.items.length;
              const syncKey = `${activeTask.id}:${set.idx}`;
              const sync = syncStatus[syncKey] || "";
              return (
                <div key={set.idx} className="space-y-2 p-3 rounded-md border border-default-200">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <input type="checkbox"
                        checked={selectedSetIdxs.includes(set.idx)}
                        disabled={okCount === 0}
                        onChange={() => toggleSetSelected(set.idx)}
                        title={okCount === 0 ? "本套还没有图，无法选中" : "勾选用于批量同步飞书"}
                        className="cursor-pointer disabled:cursor-not-allowed" />
                      <span className="font-medium text-sm">第 {set.idx} 套</span>
                      <span className="text-default-400 text-xs">
                        {okCount}/{totalCount} 张
                      </span>
                      {okCount < totalCount && activeTask.status === "running" && (
                        <Spinner size="sm" color="secondary" />
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="flat" isDisabled={okCount === 0}
                        startContent={<Download size={12} />}
                        onPress={() => downloadSet(activeTask, set.idx, set.items)}>
                        下载本套
                      </Button>
                      <Button size="sm" variant="flat" color={sync === "done" ? "success" : "primary"}
                        isLoading={sync === "syncing"}
                        isDisabled={okCount === 0 || sync === "syncing"}
                        onPress={() => syncSetToFeishu(activeTask, set.idx)}>
                        {sync === "done" ? "✓ 已同步飞书" : "同步飞书"}
                      </Button>
                    </div>
                  </div>
                  {/* 一行展示一套：所有图横向排列，超出可横向滚动 */}
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {set.items.map((cell, ci) => (
                      <div key={ci}
                        className="shrink-0 w-32 sm:w-36 md:w-40 aspect-square rounded-md overflow-hidden bg-default-100 relative group">
                        {cell.image_url ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={proxyUrl(cell.image_url)}
                              alt={`set${set.idx}-${ci + 1}`}
                              className="w-full h-full object-cover cursor-pointer"
                              onClick={() => setPreviewSrc(cell.image_url)} />
                            <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1.5 py-0.5 truncate">
                              源{cell.src_idx + 1}×{cell.bg_name}
                            </span>
                          </>
                        ) : cell.error ? (
                          <div className="w-full h-full flex flex-col items-center justify-center text-xs text-danger px-2 text-center gap-1">
                            <span>{cell.error.slice(0, 80)}</span>
                            <span className="text-default-400 text-[10px]">
                              源{cell.src_idx + 1}×{cell.bg_name}
                            </span>
                          </div>
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center text-xs text-default-400 gap-1">
                            <Spinner size="sm" color="secondary" />
                            <span className="text-[10px]">源{cell.src_idx + 1}×{cell.bg_name}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}

      {/* 历史任务列表 */}
      {tasks.length > 0 && (
        <Card>
          <CardHeader className="font-medium flex items-center justify-between w-full">
            <span>历史任务</span>
            <span className="text-xs text-default-400">{tasks.length} 条</span>
          </CardHeader>
          <CardBody className="space-y-2">
            {tasks.filter((t) => t.id !== activeTaskId).map((t) => {
              const total = t.count * (t.text_sources?.length || 0) * (t.background_ids?.length || 0);
              const doneImgs = (t.items || []).reduce(
                (acc, s) => acc + s.items.filter((c) => c.image_url).length, 0);
              return (
                <div key={t.id}
                  className="flex items-center justify-between p-2 rounded-md border border-default-200 hover:bg-default-50 cursor-pointer gap-2"
                  onClick={() => { setActiveTaskId(t.id); pollActive(t.id); }}>
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-sm font-medium shrink-0">#{t.id}</span>
                    <Chip size="sm" variant="flat"
                      color={
                        t.status === "done" ? "success" :
                        t.status === "running" ? "primary" :
                        t.status === "pending" ? "default" :
                        t.status === "cancelled" ? "warning" : "danger"
                      }>
                      {t.status === "pending" ? "排队中" :
                        t.status === "running" ? "生成中" :
                        t.status === "done" ? "已完成" :
                        t.status === "cancelled" ? "已取消" : "失败"}
                    </Chip>
                    <span className="text-xs text-default-500 truncate">
                      {t.count} 套 · {doneImgs}/{total} 张 · {t.created_at?.slice(5, 16)}
                    </span>
                    {t.post_title && (
                      <span className="text-xs text-default-400 truncate">
                        · {t.post_title.slice(0, 30)}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {["pending", "running"].includes(t.status) && (
                      <Button size="sm" variant="flat" color="warning"
                        onPress={() => cancelTask(t.id)}>取消</Button>
                    )}
                    {["done", "error", "cancelled"].includes(t.status) && (
                      <Button size="sm" variant="flat" color="danger" isIconOnly
                        onPress={() => deleteTask(t.id)}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}

      <ImagePreviewModal isOpen={!!previewSrc} src={previewSrc || ""} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
