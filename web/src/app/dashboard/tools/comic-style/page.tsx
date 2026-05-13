"use client";

/**
 * 漫画风 — 上传图 + 选风格预设/自定义提示词 → 图生图 → 下载
 *
 * 跟商品图 / 仿写 / 文案换背景的区别：
 * - 主打"快速套漫画风"，UI 极简
 * - 不入飞书同步，结果只支持本地下载
 * - 8 个内置预设 + 自定义文字框
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Spinner } from "@nextui-org/spinner";
import { Chip } from "@nextui-org/chip";
import { Wand2, Upload, X, Download, ImageIcon, Sparkles } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { IMAGE_API, SIZE_OPTIONS, proxyUrl } from "@/components/product-image/utils";
import { ModelSelector } from "@/components/ModelSelector";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";

type Preset = { key: string; label: string; desc: string };
type GenItem = { b64?: string; url?: string; id?: number };
type HistoryItem = {
  batch_id: string;
  style_label: string;
  custom_prompt: string;
  size: string;
  model: string;
  created_at: string;
  count: number;
  images: { id: number; url: string }[];
};

const CUSTOM_KEY = "custom";

export default function ComicStylePage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  // 上传图
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [imgB64, setImgB64] = useState("");           // 纯 base64 不带前缀
  const [imgPreview, setImgPreview] = useState("");   // data:image/... 用于 <img>
  const [imgName, setImgName] = useState("");
  const [dragOver, setDragOver] = useState(false);    // 拖拽时高亮上传框

  // 预设
  const [presets, setPresets] = useState<Preset[]>([]);
  const [style, setStyle] = useState<string>("anime_jp");
  const [customPrompt, setCustomPrompt] = useState("");

  // 参数
  const [count, setCount] = useState(1);
  const [size, setSize] = useState("");
  const [imageModelId, setImageModelId] = useState<number | null>(null);

  // 结果
  const [generating, setGenerating] = useState(false);
  const [items, setItems] = useState<GenItem[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  // 历史
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const loadHistory = async () => {
    try {
      const r = await fetch(IMAGE_API("/comic-style/history?limit=20"), { headers });
      if (r.ok) {
        const d = await r.json();
        setHistory(d.history || []);
      }
    } catch {}
  };

  useEffect(() => {
    fetch(IMAGE_API("/comic-style/presets"), { headers })
      .then((r) => r.json())
      .then((d) => setPresets(d.presets || []))
      .catch(() => {});
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = async (f: File) => {
    if (!f.type.startsWith("image/")) { toastErr("请选图片"); return; }
    if (f.size > 50 * 1024 * 1024) { toastErr("文件超过 50MB"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const pure = dataUrl.split(",", 2)[1] || "";
      setImgB64(pure);
      setImgPreview(dataUrl);
      setImgName(f.name);
    };
    reader.readAsDataURL(f);
  };

  const clearImg = () => {
    setImgB64(""); setImgPreview(""); setImgName("");
    if (fileRef.current) fileRef.current.value = "";
    setItems([]);
  };

  const handleGenerate = async () => {
    if (!imgB64) { toastErr("请先上传图片"); return; }
    if (style === CUSTOM_KEY && !customPrompt.trim()) {
      toastErr("选了自定义请填提示词");
      return;
    }
    setGenerating(true);
    setItems([]);
    try {
      const r = await fetch(IMAGE_API("/comic-style/generate"), {
        method: "POST", headers,
        body: JSON.stringify({
          reference_image_b64: imgB64,
          style,
          custom_prompt: customPrompt.trim() || undefined,
          count,
          size: size || undefined,
          image_model_id: imageModelId,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toastErr(d.detail || d.error || `HTTP ${r.status}`); return; }
      setItems(d.images || []);
      toastOk(`已生成 ${d.count} 张`);
      loadHistory();  // 刷新历史区
    } catch (e: any) { toastErr(`生成失败：${e?.message || e}`); }
    finally { setGenerating(false); }
  };

  const downloadByUrl = async (url: string, fname: string) => {
    try {
      const r = await fetch(proxyUrl(url));
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u; a.download = fname; a.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    } catch (e: any) { toastErr(`下载失败：${e?.message || e}`); }
  };

  // 下载单张：兼容 b64 / url 两种源
  const downloadOne = async (it: GenItem, idx: number) => {
    try {
      let blob: Blob;
      if (it.b64) {
        const byteChars = atob(it.b64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        blob = new Blob([bytes], { type: "image/png" });
      } else if (it.url) {
        const r = await fetch(proxyUrl(it.url));
        blob = await r.blob();
      } else {
        toastErr("这张图没数据，无法下载"); return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const styleSlug = style.replace(/_/g, "-");
      a.download = `comic-${styleSlug}-${Date.now()}-${idx + 1}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { toastErr(`下载失败：${e?.message || e}`); }
  };

  const downloadAll = async () => {
    if (items.length === 0) return;
    for (let i = 0; i < items.length; i++) {
      await downloadOne(items[i], i);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  // 给一个 GenItem 算出可显示的 src（base64 内联 或 七牛 URL 通过 proxy）
  const itemSrc = (it: GenItem): string =>
    it.b64 ? `data:image/png;base64,${it.b64}` : (it.url ? proxyUrl(it.url) : "");

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      {/* 头 */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center">
          <Wand2 size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            漫画风
            <Chip size="sm" variant="flat" color="secondary">图生图</Chip>
          </h1>
          <p className="text-sm text-default-500 mt-1">
            上传一张图 → 选风格预设 / 自己写提示词 → AI 把它转成漫画风。
            结果只在本页生成 + 下载，不写历史 / 不同步飞书。
          </p>
        </div>
      </div>

      {/* 步骤 1：上传 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Upload size={16} />
            <span className="font-medium">① 上传原图</span>
            {imgName && <Chip size="sm" variant="flat">{imgName}</Chip>}
          </div>
        </CardHeader>
        <CardBody>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          {imgPreview ? (
            <div className="relative inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imgPreview} alt={imgName}
                className="max-h-64 rounded-md border border-divider cursor-pointer"
                onClick={() => setPreviewSrc(imgPreview)} />
              <button type="button" onClick={clearImg}
                className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-danger text-white flex items-center justify-center shadow-md hover:bg-danger-600"
                title="移除">
                <X size={14} />
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-divider hover:border-primary/40"
              }`}
            >
              <Upload size={28} className="mx-auto text-default-400 mb-2" />
              <p className="text-sm text-default-600">
                {dragOver ? "松开鼠标完成上传" : "点击或拖拽图片到这里"}
              </p>
              <p className="text-xs text-default-400 mt-1">PNG / JPG / WEBP，最大 50 MB（支持 4K）</p>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 步骤 2：选风格 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles size={16} />
            <span className="font-medium">② 选风格</span>
            <span className="text-xs text-default-400">— {presets.length} 个预设 + 自定义</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {presets.map((p) => (
              <button key={p.key} type="button" onClick={() => setStyle(p.key)}
                className={`text-left p-3 rounded-md border-2 transition-colors ${
                  style === p.key
                    ? "border-secondary bg-secondary/5"
                    : "border-default-200 hover:border-default-300"
                }`}>
                <div className="font-medium text-sm">{p.label}</div>
                <div className="text-[11px] text-default-500 mt-0.5 line-clamp-2">{p.desc}</div>
              </button>
            ))}
            <button type="button" onClick={() => setStyle(CUSTOM_KEY)}
              className={`text-left p-3 rounded-md border-2 transition-colors ${
                style === CUSTOM_KEY
                  ? "border-primary bg-primary/5"
                  : "border-default-200 hover:border-default-300"
              }`}>
              <div className="font-medium text-sm">✍️ 自定义</div>
              <div className="text-[11px] text-default-500 mt-0.5">手写一段风格描述</div>
            </button>
          </div>
          <div>
            <p className="text-xs text-default-500 mb-1">
              {style === CUSTOM_KEY
                ? "风格提示词（必填，越具体越好；可英文）"
                : "额外补充（可选，会叠加到预设上）"}
            </p>
            <textarea
              className="w-full border border-divider rounded-md p-2 text-sm bg-background min-h-[80px]"
              placeholder={style === CUSTOM_KEY
                ? "如：把这张图转成 90 年代赛博朋克漫画风，霓虹光，雨夜，紫粉色调"
                : "如：偏暗的氛围 / 加雨夜场景 / 主角戴墨镜（留空 = 仅用预设）"}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
            />
          </div>
        </CardBody>
      </Card>

      {/* 步骤 3：参数 + 生成 */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wand2 size={16} />
            <span className="font-medium">③ 生成</span>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <p className="text-xs text-default-500 mb-1">张数</p>
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((c) => (
                  <button key={c} type="button" onClick={() => setCount(c)}
                    className={`w-12 h-9 rounded-md text-sm border transition ${
                      count === c
                        ? "bg-secondary text-white border-secondary"
                        : "border-divider hover:bg-default-100"
                    }`}>{c}</button>
                ))}
              </div>
            </div>
            <div className="min-w-[180px]">
              <p className="text-xs text-default-500 mb-1">尺寸</p>
              <select className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={size} onChange={(e) => setSize(e.target.value)}>
                <option value="">模型默认</option>
                {SIZE_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <ModelSelector usage="image" value={imageModelId} onChange={setImageModelId}
              label="图像模型" className="min-w-[200px]" />
          </div>

          <Button color="secondary" size="lg" className="w-full"
            startContent={<Wand2 size={18} />}
            isLoading={generating}
            isDisabled={!imgB64 || generating || (style === CUSTOM_KEY && !customPrompt.trim())}
            onPress={handleGenerate}>
            {generating ? `生成中（${count} 张，约 ${count * 15} 秒）…` : `开始生成 ${count} 张`}
          </Button>
        </CardBody>
      </Card>

      {/* 结果 */}
      {(generating || items.length > 0) && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon size={16} />
              <span className="font-medium">结果</span>
              {items.length > 0 && <Chip size="sm" variant="flat">{items.length} 张</Chip>}
            </div>
            {items.length > 0 && (
              <Button size="sm" variant="flat" startContent={<Download size={13} />}
                onPress={downloadAll}>
                全部下载
              </Button>
            )}
          </CardHeader>
          <CardBody>
            {generating && items.length === 0 ? (
              <div className="flex flex-col items-center py-12">
                <Spinner size="lg" color="secondary" />
                <p className="text-sm text-default-500 mt-3">
                  生成中，约 {count * 15} 秒…
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {items.map((it, i) => {
                  const src = itemSrc(it);
                  return (
                    <div key={i} className="space-y-2">
                      <div className="aspect-square rounded-md overflow-hidden bg-default-100 cursor-pointer flex items-center justify-center"
                        onClick={() => src && setPreviewSrc(src)}>
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src} alt={`comic-${i + 1}`}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-xs text-default-400">图片加载失败</span>
                        )}
                      </div>
                      <Button size="sm" variant="flat" className="w-full"
                        startContent={<Download size={13} />}
                        isDisabled={!src}
                        onPress={() => downloadOne(it, i)}>
                        下载第 {i + 1} 张
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* 历史 */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon size={16} />
              <span className="font-medium">历史记录</span>
              <Chip size="sm" variant="flat">{history.length} 套</Chip>
            </div>
            <Button size="sm" variant="light" onPress={loadHistory}>刷新</Button>
          </CardHeader>
          <CardBody className="space-y-3">
            {history.map((h) => (
              <div key={h.batch_id} className="border border-default-200 rounded-md p-2">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                  <div className="flex items-center gap-2 text-xs">
                    <Chip size="sm" variant="flat" color="secondary">{h.style_label}</Chip>
                    <span className="text-default-500">{h.count} 张</span>
                    <span className="text-default-400">{h.created_at?.slice(0, 16)}</span>
                    {h.size && <span className="text-default-400">· {h.size}</span>}
                  </div>
                  <Button size="sm" variant="flat"
                    startContent={<Download size={12} />}
                    isDisabled={h.images.every((i) => !i.url)}
                    onPress={async () => {
                      for (let i = 0; i < h.images.length; i++) {
                        const u = h.images[i].url;
                        if (!u) continue;
                        const ext = (u.split(".").pop()?.split("?")[0] || "png").slice(0, 5);
                        await downloadByUrl(u, `comic-${h.batch_id.replace(":", "-")}-${i + 1}.${ext}`);
                        await new Promise((r) => setTimeout(r, 300));
                      }
                    }}>
                    下载本套
                  </Button>
                </div>
                {h.custom_prompt && (
                  <p className="text-[11px] text-default-500 mb-1 line-clamp-1">
                    补充：{h.custom_prompt}
                  </p>
                )}
                <div className="flex gap-2 overflow-x-auto">
                  {h.images.map((it) => (
                    <button key={it.id} type="button"
                      className="shrink-0 w-24 h-24 rounded overflow-hidden bg-default-100"
                      onClick={() => it.url && setPreviewSrc(it.url)}>
                      {it.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={proxyUrl(it.url)} alt={`#${it.id}`}
                          className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[10px] text-default-400">无图</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <ImagePreviewModal isOpen={!!previewSrc} src={previewSrc || ""} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
