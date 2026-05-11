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
import { Wand2, Link2, Image as ImageIcon, Upload, Trash2, Check, AlertCircle, Download, ZoomIn } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { IMAGE_API, proxyUrl } from "@/components/product-image/utils";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";
import { ModelSelector } from "@/components/ModelSelector";

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

  const handleFetch = async () => {
    const u = postUrl.trim();
    if (!u) { toastErr("请输入作品链接"); return; }
    setFetching(true);
    setPost(null);
    setExtractedText("");
    setResults([]);
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
      setPost({
        images: data.images || [],
        image_urls: data.image_urls || data.images || [],
        title: data.title || "",
        desc: data.desc || "",
        platform: data.platform || "",
        platform_label: data.platform_label || "",
        post_id: data.post_id || "",
        post_url: data.post_url || u,
      });
      setSourceImgIdxs([0]);
    } catch (e: any) { toastErr(`加载失败：${e?.message || e}`); }
    finally { setFetching(false); }
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
    if (file.size > 10 * 1024 * 1024) { toastErr("文件超过 10MB"); return; }
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

  // ── 步骤 4：生成 ──────────────────────────────────────────────────────
  const [count, setCount] = useState(1);
  const [styleHint, setStyleHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [imageModelId, setImageModelId] = useState<number | null>(null);
  const bgFileRef = useRef<HTMLInputElement | null>(null);

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
      if (Array.isArray(d.selectedBgIds)) setSelectedBgIds(d.selectedBgIds);
      if (typeof d.imageModelId === "number") setImageModelId(d.imageModelId);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [PERSIST_KEY]);
  useEffect(() => {
    if (_firstLoad.current) { _firstLoad.current = false; return; }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        postUrl, ocrTexts, sourceImgIdxs, ocrModelId, styleHint, count, selectedBgIds, imageModelId,
      }));
    } catch {}
  }, [postUrl, ocrTexts, sourceImgIdxs, ocrModelId, styleHint, count, selectedBgIds, PERSIST_KEY]);

  const handleGenerate = async () => {
    // 收集有效"文字源"（必须有提取出来的非空文字）
    const validSources = sourceImgIdxs.filter((idx) => (ocrTexts[idx] || "").trim());
    if (validSources.length === 0) { toastErr("没有可用的提取文字。请先 OCR 至少一张源图"); return; }
    if (selectedBgIds.length === 0) { toastErr("请至少选一张背景图"); return; }

    setGenerating(true);
    setResults([]);

    // 「几套」语义（对标 整体仿写）：
    //   每套 = 跑一遍「所有源文字 × 所有背景」的笛卡尔积，产出 N×M 张
    //   count 套 = 同一份输入跑 count 次，得到 count×N×M 张（不同 seed 的变体）
    type Job = { setIdx: number; srcIdx: number; bgId: number; bgName: string; text: string };
    const jobs: Job[] = [];
    for (let s = 1; s <= count; s++) {
      for (const srcIdx of validSources) {
        const text = (ocrTexts[srcIdx] || "").trim();
        for (const bgId of selectedBgIds) {
          const bg = backgrounds.find((b) => b.id === bgId);
          jobs.push({ setIdx: s, srcIdx, bgId, bgName: bg?.name || `背景 ${bgId}`, text });
        }
      }
    }

    // 限 3 并发跑（image edits 上游限流，太多会 fail）
    const concurrency = 3;
    const all: ResultItem[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const i = cursor++;
        const job = jobs[i];
        const label = `第${job.setIdx}套·源${job.srcIdx + 1}×${job.bgName}`;
        try {
          // 后端单次 count=1（套数由前端循环控制；套间循环放前端，方便流式展示进度）
          const r = await fetch(IMAGE_API("/text-remix/generate"), {
            method: "POST", headers,
            body: JSON.stringify({
              background_id: job.bgId,
              text_content: job.text,
              count: 1,
              style_hint: styleHint.trim(),
              image_model_id: imageModelId,
            }),
          });
          // 安全解析：返回 HTML/空文本时不能直接 .json()，否则前端只能看到
          // "Unexpected token '<'..." 这种没用的错误
          const ct = (r.headers.get("content-type") || "").toLowerCase();
          const txt = await r.text();
          let data: any = {};
          if (ct.includes("application/json")) {
            try { data = txt ? JSON.parse(txt) : {}; } catch { data = {}; }
          } else if (txt.trim().startsWith("<")) {
            data = { detail: `网关返回了 HTML 而非 JSON（HTTP ${r.status}），可能是上游超时/反代异常；首字符："${txt.slice(0, 80).replace(/\s+/g, " ")}…"` };
          } else {
            data = { detail: txt.slice(0, 200) || `HTTP ${r.status}` };
          }
          if (!r.ok) {
            all.push({
              image_url: "", error: data.detail || `HTTP ${r.status}`,
              bg_name: label, set_idx: job.setIdx, src_idx: job.srcIdx,
            });
          } else {
            const items: ResultItem[] = (data.results || []).map((x: any) => ({
              ...x, bg_name: label,
              set_idx: job.setIdx, src_idx: job.srcIdx,
            } as any));
            all.push(...items);
          }
        } catch (e: any) {
          all.push({
            image_url: "", error: e?.message || String(e),
            bg_name: label, set_idx: job.setIdx, src_idx: job.srcIdx,
          });
        }
        setResults([...all]);  // 流式更新
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
      const ok = all.filter((x) => x.image_url).length;
      toastOk(`生成完成：${ok}/${jobs.length} 张（${count} 套 × ${validSources.length} 源 × ${selectedBgIds.length} 背景）`);
    } finally { setGenerating(false); }
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
            文本仿写
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
          <div className="flex gap-2">
            <Input value={postUrl} onValueChange={setPostUrl}
              placeholder="粘贴小红书 / 抖音作品链接"
              size="sm" className="flex-1" />
            <Button color="primary" size="sm" startContent={<Link2 size={14} />}
              isLoading={fetching} onPress={handleFetch}>拉取</Button>
          </div>
        </CardBody>
      </Card>

      {/* 步骤 2：选图 + OCR */}
      {post && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <ImageIcon size={16} />
                <span className="font-medium">② 选源图，提取文字</span>
                <Chip size="sm" variant="flat">{post.images.length} 张</Chip>
              </div>
              <div className="flex items-end gap-2">
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
                <p className="text-xs text-default-700">
                  每张源图独立提取，可单独编辑/重试；生成时按每张文字配每张背景产出。
                </p>
                {sourceImgIdxs.map((idx) => {
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
              <span className="font-medium">③ 选择 / 上传背景图</span>
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
            <span className="font-medium">④ 生成</span>
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
            <div className="flex-1 min-w-[200px]">
              <Input size="sm" label="风格提示（可选）" labelPlacement="outside"
                placeholder="如：小红书风 / 简约清新 / 高级感"
                value={styleHint} onValueChange={setStyleHint} />
            </div>
          </div>
          <Button color="secondary" size="lg" className="w-full"
            startContent={<Wand2 size={18} />}
            isLoading={generating}
            isDisabled={
              sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length === 0
              || selectedBgIds.length === 0 || generating
            }
            onPress={handleGenerate}>
            {(() => {
              const valid = sourceImgIdxs.filter((i) => (ocrTexts[i] || "").trim()).length;
              const perSet = valid * selectedBgIds.length;
              const total = perSet * count;
              return generating ? "生成中…" : `生成 ${count} 套 × ${perSet} 张/套 = ${total} 张`;
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

      {/* 结果 */}
      {(results.length > 0 || generating) && (
        <Card>
          <CardHeader className="font-medium">生成结果</CardHeader>
          <CardBody>
            {generating && results.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Spinner color="secondary" />
                <span className="ml-3 text-sm text-default-500">AI 正在绘制（约 30s 一张）…</span>
              </div>
            ) : (
              // 按 set_idx 分组展示（对标整体仿写的"第 N 套"展示）
              <div className="space-y-4">
                {(() => {
                  const groups: Record<string, ResultItem[]> = {};
                  for (const r of results) {
                    const k = String(r.set_idx ?? 0);
                    (groups[k] ||= []).push(r);
                  }
                  const keys = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
                  return keys.map((k) => {
                    const list = groups[k];
                    const ok = list.filter((r) => r.image_url).length;
                    return (
                      <div key={k} className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">第 {k} 套</span>
                          <span className="text-default-400 text-xs">
                            {ok}/{list.length} 张
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                          {list.map((r, i) => (
                            <div key={i}
                              className="aspect-square rounded-md overflow-hidden bg-default-100 relative group">
                              {r.image_url ? (
                                <>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={proxyUrl(r.image_url)}
                                    className="w-full h-full object-cover cursor-pointer"
                                    onClick={() => setPreviewSrc(r.image_url)}
                                    alt={`结果 ${k}-${i + 1}`} />
                                  <a href={r.image_url} download target="_blank" rel="noopener noreferrer"
                                    className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-black/60 text-white p-1.5 rounded transition">
                                    <Download size={14} />
                                  </a>
                                  {r.bg_name && (
                                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1.5 py-0.5 truncate">
                                      {r.bg_name}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center text-xs text-danger px-2 text-center gap-1">
                                  <span>{r.error?.slice(0, 80) || "失败"}</span>
                                  {r.bg_name && (
                                    <span className="text-default-400 text-[10px]">{r.bg_name}</span>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <ImagePreviewModal isOpen={!!previewSrc} src={previewSrc || ""} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
