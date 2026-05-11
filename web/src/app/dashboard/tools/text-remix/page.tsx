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
import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Wand2, Link2, Image as ImageIcon, Upload, Trash2, Check, AlertCircle, Download } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { IMAGE_API, proxyUrl } from "@/components/product-image/utils";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";

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

type ResultItem = { image_url: string; error: string };

export default function TextRemixPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // ── 步骤 1：拉作品 ────────────────────────────────────────────────────
  const [postUrl, setPostUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [post, setPost] = useState<FetchedPost | null>(null);
  const [sourceImgIdx, setSourceImgIdx] = useState(0);

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
      setSourceImgIdx(0);
    } catch (e: any) { toastErr(`加载失败：${e?.message || e}`); }
    finally { setFetching(false); }
  };

  // ── 步骤 2：OCR ───────────────────────────────────────────────────────
  const [ocring, setOcring] = useState(false);
  const [extractedText, setExtractedText] = useState("");

  const handleExtract = async () => {
    if (!post) return;
    const imgUrl = post.image_urls[sourceImgIdx] || post.images[sourceImgIdx];
    if (!imgUrl) { toastErr("请选一张源图"); return; }
    setOcring(true);
    try {
      const r = await fetch(IMAGE_API("/text-remix/extract-text"), {
        method: "POST", headers,
        body: JSON.stringify({ image_url: imgUrl }),
      });
      const data = await r.json();
      if (!r.ok) {
        toastErr(data.detail || "OCR 失败");
        return;
      }
      setExtractedText((data.text || "").trim());
      toastOk("文字提取完成，请确认后再生成");
    } catch (e: any) { toastErr(`OCR 失败：${e?.message || e}`); }
    finally { setOcring(false); }
  };

  // ── 步骤 3：背景图管理 ────────────────────────────────────────────────
  const [backgrounds, setBackgrounds] = useState<Background[]>([]);
  const [bgLoading, setBgLoading] = useState(false);
  const [selectedBgId, setSelectedBgId] = useState<number | null>(null);

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

  const handleUploadBg = async (file: File) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toastErr("文件超过 10MB"); return; }
    const name = window.prompt("命名这张背景图（可选）：", file.name) || file.name;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);
    try {
      const r = await fetch(IMAGE_API("/text-remix/backgrounds"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },  // 不带 Content-Type 让浏览器自己设 multipart boundary
        body: fd,
      });
      const data = await r.json();
      if (!r.ok) { toastErr(data.detail || "上传失败"); return; }
      toastOk(`背景图已上传：${name}`);
      setSelectedBgId(data.id);
      await loadBackgrounds();
    } catch (e: any) { toastErr(`上传失败：${e?.message || e}`); }
  };

  const handleDeleteBg = async (id: number) => {
    if (!confirm("确认删除这张背景图模板？")) return;
    const r = await fetch(IMAGE_API(`/text-remix/backgrounds/${id}`), {
      method: "DELETE", headers,
    });
    if (r.ok) {
      if (selectedBgId === id) setSelectedBgId(null);
      await loadBackgrounds();
    }
  };

  // ── 步骤 4：生成 ──────────────────────────────────────────────────────
  const [count, setCount] = useState(1);
  const [styleHint, setStyleHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!extractedText.trim()) { toastErr("请先提取并确认文字"); return; }
    if (!selectedBgId) { toastErr("请选择或上传一张背景图"); return; }
    setGenerating(true);
    setResults([]);
    try {
      const r = await fetch(IMAGE_API("/text-remix/generate"), {
        method: "POST", headers,
        body: JSON.stringify({
          background_id: selectedBgId,
          text_content: extractedText,
          count,
          style_hint: styleHint.trim(),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        toastErr(data.detail || "生成失败");
        return;
      }
      setResults(data.results || []);
      const ok = (data.results || []).filter((x: ResultItem) => x.image_url).length;
      toastOk(`生成完成：${ok}/${count} 张成功`);
    } catch (e: any) { toastErr(`生成失败：${e?.message || e}`); }
    finally { setGenerating(false); }
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
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2">
                <ImageIcon size={16} />
                <span className="font-medium">② 选源图，提取文字</span>
                <Chip size="sm" variant="flat">{post.images.length} 张</Chip>
              </div>
              <Button color="secondary" size="sm" isLoading={ocring}
                onPress={handleExtract}
                isDisabled={!post.images.length}>
                提取文字（OCR）
              </Button>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
              {post.images.map((u, i) => (
                <button key={i} type="button"
                  onClick={() => setSourceImgIdx(i)}
                  className={`relative aspect-square rounded-md overflow-hidden border-2 transition ${
                    i === sourceImgIdx ? "border-secondary" : "border-transparent hover:border-default-300"
                  }`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u.startsWith("data:") ? u : proxyUrl(u)} alt={`图 ${i + 1}`}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover" />
                  <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 rounded">
                    {i + 1}
                  </span>
                  {i === sourceImgIdx && (
                    <span className="absolute top-1 right-1 bg-secondary text-white text-[10px] px-1.5 rounded flex items-center gap-0.5">
                      <Check size={10} />选中
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* OCR 结果：可编辑 */}
            <div>
              <p className="text-xs text-default-700 mb-1">
                提取的文字（可编辑确认，生成时按此文字渲染）
              </p>
              <textarea
                className="w-full border border-divider rounded-md p-2 text-sm bg-background min-h-[120px]"
                placeholder={ocring ? "OCR 中…" : "未提取。点上方「提取文字 OCR」按钮"}
                value={extractedText}
                onChange={(e) => setExtractedText(e.target.value)}
              />
              <p className="text-[11px] text-default-400 mt-1">
                生成时会把这段文字"印"到背景图上，保持换行结构。
              </p>
            </div>
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
            <label className="cursor-pointer">
              <input type="file" accept="image/*" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUploadBg(f);
                  e.target.value = "";  // 允许重复选择同一个文件
                }} />
              <span className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <Upload size={14} />上传新背景
              </span>
            </label>
          </div>
        </CardHeader>
        <CardBody>
          {bgLoading ? (
            <div className="text-default-400 text-sm">加载中…</div>
          ) : backgrounds.length === 0 ? (
            <div className="text-center py-6 text-default-400 text-sm">
              <ImageIcon size={28} className="mx-auto mb-2 opacity-30" />
              还没上传过背景图。点右上「上传新背景」开始。
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
              {backgrounds.map((bg) => (
                <div key={bg.id}
                  className={`relative aspect-square rounded-md overflow-hidden border-2 transition cursor-pointer group ${
                    selectedBgId === bg.id ? "border-secondary" : "border-transparent hover:border-default-300"
                  }`}
                  onClick={() => setSelectedBgId(bg.id)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={proxyUrl(bg.image_url)} alt={bg.name}
                    className="w-full h-full object-cover" />
                  <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate">
                    {bg.name}
                  </span>
                  {selectedBgId === bg.id && (
                    <span className="absolute top-1 right-1 bg-secondary text-white text-[10px] px-1.5 rounded flex items-center gap-0.5">
                      <Check size={10} />选中
                    </span>
                  )}
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeleteBg(bg.id); }}
                    className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 bg-danger text-white p-1 rounded transition">
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
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
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <p className="text-xs text-default-500 mb-1">数量</p>
              <div className="flex gap-1">
                {[1, 2, 3].map((c) => (
                  <button key={c} type="button"
                    onClick={() => setCount(c)}
                    className={`px-3 py-1.5 text-xs rounded border transition ${
                      count === c
                        ? "border-secondary bg-secondary/10 text-secondary font-medium"
                        : "border-divider text-default-500 hover:border-secondary/50"
                    }`}>{c} 张</button>
                ))}
              </div>
            </div>
            <div className="flex-1 min-w-[200px]">
              <Input size="sm" label="风格提示（可选）" labelPlacement="outside"
                placeholder="如：小红书风 / 简约清新 / 高级感"
                value={styleHint} onValueChange={setStyleHint} />
            </div>
          </div>
          <p className="text-[11px] text-default-400">
            MVP 上限 3 张同步生成；超过会比较慢，建议先 1 张试效果，再放量。
          </p>
          <Button color="secondary" size="lg" className="w-full"
            startContent={<Wand2 size={18} />}
            isLoading={generating}
            isDisabled={!extractedText.trim() || !selectedBgId || generating}
            onPress={handleGenerate}>
            {generating ? "生成中…" : `生成 ${count} 张`}
          </Button>
          {!extractedText.trim() && (
            <p className="text-xs text-warning-600 flex items-center gap-1">
              <AlertCircle size={12} />请先在上方提取并确认文字
            </p>
          )}
          {extractedText.trim() && !selectedBgId && (
            <p className="text-xs text-warning-600 flex items-center gap-1">
              <AlertCircle size={12} />请选择一张背景图
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
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {results.map((r, i) => (
                  <div key={i}
                    className="aspect-square rounded-md overflow-hidden bg-default-100 relative group">
                    {r.image_url ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={proxyUrl(r.image_url)}
                          className="w-full h-full object-cover cursor-pointer"
                          onClick={() => setPreviewSrc(r.image_url)} alt={`结果 ${i + 1}`} />
                        <a href={r.image_url} download target="_blank" rel="noopener noreferrer"
                          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-black/60 text-white p-1.5 rounded transition">
                          <Download size={14} />
                        </a>
                      </>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-danger px-2 text-center">
                        {r.error?.slice(0, 80) || "失败"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <ImagePreviewModal isOpen={!!previewSrc} src={previewSrc || ""} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
