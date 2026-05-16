"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Spinner } from "@nextui-org/spinner";
import { Chip } from "@nextui-org/chip";
import {
  Sparkles, Wand2, AlertCircle, Check, ChevronDown, ChevronUp, Download,
} from "lucide-react";
import { useMe } from "@/lib/useApi";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader, BetaBadge } from "@/components/ui";

import {
  IMAGE_API, SIZE_OPTIONS, proxyUrl,
} from "@/components/product-image/utils";
import { useImageConfig } from "@/components/product-image/useImageConfig";
import { ConfigStatusBar } from "@/components/product-image/ConfigStatusBar";
import { ImagePreviewModal } from "@/components/product-image/ImagePreviewModal";
import { HistoryGrid } from "@/components/product-image/HistoryGrid";
import { ReferenceImageUploader } from "@/components/product-image/ReferenceImageUploader";
import { ModelSelector } from "@/components/ModelSelector";
import { useAiModels } from "@/lib/useApi";

const COUNT_OPTIONS = [1, 2, 3, 4];

const SCENE_OPTIONS = [
  "白底/纯色", "简约渐变背景", "生活场景", "户外自然",
  "节日氛围", "科技感", "奢华高端", "极简北欧",
];

const STYLE_OPTIONS = [
  { key: "ecom",     label: "电商简洁" },
  { key: "lifestyle",label: "种草/小红书风" },
  { key: "luxury",   label: "奢华高端" },
  { key: "minimal",  label: "极简北欧" },
  { key: "natural",  label: "自然清新" },
  { key: "tech",     label: "科技感" },
];

const PLATFORM_OPTIONS = ["小红书", "抖音", "淘宝/天猫", "京东", "独立站"];

type GenItem = { b64?: string; url?: string };

export default function ProductImagePage() {
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const uid = me?.username || me?.id || "anon";
  const PERSIST_KEY = `pulse.product-image.${uid}`;

  const { cfg, loading: cfgLoading, reload: reloadConfig, headers } = useImageConfig();

  // ── Prompt 向导 ──────────────────────────────────────────────────────────
  const [wizardOpen, setWizardOpen] = useState(true);
  const [subject, setSubject] = useState("");
  const [scenes, setScenes] = useState<string[]>([]);
  const [style, setStyle] = useState("ecom");
  const [platform, setPlatform] = useState("小红书");
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [extras, setExtras] = useState("");
  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [selectedPromptIdx, setSelectedPromptIdx] = useState<number | null>(null);
  const [wizardError, setWizardError] = useState("");

  // ── 生成参数 ────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [count, setCount] = useState(1);
  const [genSize, setGenSize] = useState("");
  const effectiveSize = genSize || cfg.size;
  // P15: 用户选的 AI 模型（文本模型用于 prompt 向导，图像模型用于实际生图）
  const [textModelId, setTextModelId] = useState<number | null>(null);
  const [imageModelId, setImageModelId] = useState<number | null>(null);

  // 参考图（可选）
  const [refImageB64, setRefImageB64] = useState("");
  const [refImagePreview, setRefImagePreview] = useState("");
  const [refImageName, setRefImageName] = useState("");

  // 持久化
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.subject) setSubject(d.subject);
      if (d.scenes) setScenes(d.scenes);
      if (d.style) setStyle(d.style);
      if (d.platform) setPlatform(d.platform);
      if (d.language) setLanguage(d.language);
      if (d.extras) setExtras(d.extras);
      if (d.prompt) setPrompt(d.prompt);
      if (d.negativePrompt) setNegativePrompt(d.negativePrompt);
      if (typeof d.count === "number") setCount(d.count);
      if (d.genSize) setGenSize(d.genSize);
      if (Array.isArray(d.prompts)) setPrompts(d.prompts);
      if (typeof d.selectedPromptIdx === "number") setSelectedPromptIdx(d.selectedPromptIdx);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const _firstSave = useRef(true);
  useEffect(() => {
    if (_firstSave.current) { _firstSave.current = false; return; }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        subject, scenes, style, platform, language, extras,
        prompt, negativePrompt, count, genSize, prompts, selectedPromptIdx,
      }));
    } catch {}
  }, [subject, scenes, style, platform, language, extras,
      prompt, negativePrompt, count, genSize, prompts, selectedPromptIdx, PERSIST_KEY]);

  const toggleScene = (s: string) =>
    setScenes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);

  const handleGeneratePrompts = async () => {
    if (!subject.trim()) { toastErr("请填写商品主体"); return; }
    setGeneratingPrompts(true);
    setPrompts([]);
    setWizardError("");
    setSelectedPromptIdx(null);
    try {
      const r = await fetch(IMAGE_API("/generate-prompts"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          subject: subject.trim(),
          scenes,
          style: STYLE_OPTIONS.find((s) => s.key === style)?.label || style,
          platform,
          extras: extras.trim(),
          language,
          text_model_id: textModelId,  // P15
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data?.error) {
        setWizardError(data.error);
        toastErr(data.error);
        return;
      }
      const list: string[] = Array.isArray(data?.prompts) ? data.prompts : [];
      if (list.length === 0) {
        setWizardError("AI 未返回有效 Prompt，请重试");
        return;
      }
      setPrompts(list);
      toastOk(`已生成 ${list.length} 条 Prompt`);
    } catch (e: any) {
      setWizardError(e?.message || String(e));
      toastErr(`生成失败：${e?.message || e}`);
    } finally {
      setGeneratingPrompts(false);
    }
  };

  const usePrompt = (idx: number) => {
    setPrompt(prompts[idx]);
    setSelectedPromptIdx(idx);
    document.getElementById("gen-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ── 生成 ────────────────────────────────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  const [items, setItems] = useState<GenItem[]>([]);
  const [genError, setGenError] = useState("");

  // P15: 同时认老 cfg（image_api_*）和新 ai_models 表里的图像模型，任一可用即可生成
  const { models: availableImageModels } = useAiModels("image");
  const hasAnyImageModel = availableImageModels.length > 0 || (!!cfg.has_key && !!cfg.base_url && !!cfg.model);
  const canGenerate = hasAnyImageModel && !generating;

  const handleGenerate = async () => {
    if (!prompt.trim()) { toastErr("请填写 Prompt"); return; }
    if (!hasAnyImageModel) { toastErr("请先让管理员在「AI 模型配置」上架图像模型"); return; }
    setGenerating(true);
    setItems([]);
    setGenError("");
    try {
      const r = await fetch(IMAGE_API("/generate"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: prompt.trim(),
          negative_prompt: negativePrompt.trim(),
          n: count,
          size: effectiveSize,
          reference_image_b64: refImageB64 || undefined,
          image_model_id: imageModelId,  // P15
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data?.error && !data?.images?.length) {
        setGenError(data.error);
        toastErr(data.error);
        return;
      }
      const imgs: GenItem[] = data?.images || [];
      setItems(imgs);
      if (data?.partial) {
        toastErr(`部分成功：${imgs.length} / ${count}（${data.error || ""}）`);
      } else {
        toastOk(`已生成 ${imgs.length} 张`);
      }
    } catch (e: any) {
      setGenError(e?.message || String(e));
      toastErr(`生成失败：${e?.message || e}`);
    } finally {
      setGenerating(false);
    }
  };

  // 预览 + 下载
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
    } catch (e: any) {
      toastErr(`下载失败：${e?.message || e}`);
    }
  };
  const downloadItem = async (it: GenItem) => {
    if (it.b64) {
      const a = document.createElement("a");
      a.href = `data:image/png;base64,${it.b64}`;
      a.download = `image-${Date.now()}.png`;
      a.click();
    } else if (it.url) {
      await downloadFromUrl(it.url);
    }
  };

  const itemSrc = (it: GenItem) =>
    it.b64 ? `data:image/png;base64,${it.b64}` : proxyUrl(it.url || "");

  return (
    <div className="max-w-page mx-auto space-y-6 p-4 md:p-6">
      <PageHeader
        section="studio"
        icon={Wand2}
        title="AI 生图"
        badge={<BetaBadge />}
        hint="填商品 / 场景信息 → AI 生成 prompt → 一次出 1-4 张。可上传参考图（结构 / 风格保留）。"
      />

      <ConfigStatusBar
        cfg={cfg}
        loading={cfgLoading}
        isAdmin={!!isAdmin}
        onSaved={reloadConfig}
      />

      {/* Prompt 向导 */}
      <Card>
        <CardHeader
          className="flex items-center justify-between cursor-pointer select-none"
          onClick={() => setWizardOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-secondary" />
            <span className="font-semibold">Prompt 向导</span>
            <Chip size="sm" color="secondary" variant="flat">AI 生成</Chip>
          </div>
          {wizardOpen ? <ChevronUp size={18} className="text-default-400" /> : <ChevronDown size={18} className="text-default-400" />}
        </CardHeader>
        {wizardOpen && (
          <CardBody className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="商品主体"
                placeholder="例：口红、护肤精华、运动鞋"
                value={subject}
                onValueChange={setSubject}
                isRequired
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-default-700">目标平台</span>
                <div className="flex flex-wrap gap-2">
                  {PLATFORM_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPlatform(p)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        platform === p
                          ? "bg-primary text-white border-primary"
                          : "border-divider text-default-600 hover:bg-default-100"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm text-default-700">场景（可多选）</span>
              <div className="flex flex-wrap gap-2">
                {SCENE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleScene(s)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      scenes.includes(s)
                        ? "bg-secondary text-white border-secondary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm text-default-700">画面风格</span>
              <div className="flex flex-wrap gap-2">
                {STYLE_OPTIONS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStyle(s.key)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      style === s.key
                        ? "bg-primary text-white border-primary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <Input
              label="补充描述（可选）"
              placeholder="例：粉色包装、节日礼盒、蓝色配色"
              value={extras}
              onValueChange={setExtras}
            />

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-default-700">Prompt 语言</span>
              <div className="flex gap-2">
                {(["zh", "en"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setLanguage(lang)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      language === lang
                        ? "bg-primary text-white border-primary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {lang === "zh" ? "中文" : "English"}
                  </button>
                ))}
              </div>
              <p className="text-xs text-default-400">
                {language === "zh"
                  ? "中文 Prompt（部分图像模型对中文支持有限）"
                  : "英文 Prompt（推荐，兼容性最好）"}
              </p>
            </div>

            {/* P15: 文本模型选择 */}
            <ModelSelector
              usage="text"
              value={textModelId}
              onChange={setTextModelId}
              label="文本模型（用于生成 Prompt）"
            />

            <Button
              color="secondary"
              size="lg"
              className="w-full"
              startContent={<Sparkles size={18} />}
              onPress={handleGeneratePrompts}
              isLoading={generatingPrompts}
              isDisabled={!subject.trim() || generatingPrompts}
            >
              {generatingPrompts ? "AI 生成中…" : "一键生成 Prompt"}
            </Button>

            {wizardError && !generatingPrompts && (
              <div className="flex items-start gap-2 text-sm text-danger bg-danger/10 rounded-lg p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{wizardError}</span>
              </div>
            )}

            {prompts.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-default-500">点击「使用」将 Prompt 填入下方生成区</p>
                {prompts.map((p, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                      selectedPromptIdx === i
                        ? "border-primary bg-primary/5"
                        : "border-divider hover:border-primary/40 hover:bg-default-50"
                    }`}
                  >
                    <span className="shrink-0 w-5 h-5 rounded-full bg-default-100 text-default-500 text-xs flex items-center justify-center font-medium">
                      {i + 1}
                    </span>
                    <p className="flex-1 text-sm text-default-700 leading-relaxed">{p}</p>
                    <Button
                      size="sm"
                      color={selectedPromptIdx === i ? "primary" : "default"}
                      variant={selectedPromptIdx === i ? "solid" : "flat"}
                      startContent={selectedPromptIdx === i ? <Check size={13} /> : undefined}
                      onPress={() => usePrompt(i)}
                      className="shrink-0"
                    >
                      {selectedPromptIdx === i ? "已选" : "使用"}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        )}
      </Card>

      {/* 生成区 */}
      <div id="gen-section" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左：输入 */}
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Wand2 size={18} className="text-primary" />
            <span className="font-semibold">生成参数</span>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm text-default-700">Prompt</label>
              <textarea
                className="w-full min-h-[120px] border border-divider rounded-md p-2 text-sm bg-background"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="详细描述想要的画面，越具体越好"
              />
            </div>
            <Input
              label="Negative prompt（可选）"
              placeholder="例：低质量, 模糊, 文字水印"
              value={negativePrompt}
              onValueChange={setNegativePrompt}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-default-700">数量</span>
                <div className="flex gap-2">
                  {COUNT_OPTIONS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCount(c)}
                      className={`flex-1 px-3 py-1.5 rounded-md text-sm border transition-colors ${
                        count === c
                          ? "bg-primary text-white border-primary"
                          : "border-divider text-default-600 hover:bg-default-100"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-default-400">单次最多 4 张（同步生成，~10s/张）</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-default-700">尺寸</span>
                <select
                  className="border border-divider rounded-md px-2 py-1.5 text-sm bg-background"
                  value={genSize}
                  onChange={(e) => setGenSize(e.target.value)}
                >
                  <option value="">默认（{cfg.size}）</option>
                  {SIZE_OPTIONS.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* P15: 图像模型选择 */}
            <ModelSelector
              usage="image"
              value={imageModelId}
              onChange={setImageModelId}
              label="图像模型"
            />

            <Button
              color="primary"
              size="lg"
              className="w-full"
              startContent={refImageB64 ? <Wand2 size={18} /> : <Sparkles size={18} />}
              onPress={handleGenerate}
              isLoading={generating}
              isDisabled={!canGenerate || !prompt.trim()}
            >
              {generating
                ? "生成中…"
                : refImageB64
                  ? `以参考图生成 ${count} 张`
                  : `生成 ${count} 张`}
            </Button>

            {!cfg.has_key && !cfgLoading && (
              <p className="text-xs text-warning-600">
                {isAdmin
                  ? "尚未配置图像 API Key，请到「系统配置」→「商品图 API 配置」填写并保存。"
                  : "图像 API 尚未配置，请联系管理员。"}
              </p>
            )}

            {genError && !generating && items.length === 0 && (
              <div className="flex items-start gap-2 text-sm text-danger bg-danger/10 rounded-lg p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{genError}</span>
              </div>
            )}
          </CardBody>
        </Card>

        {/* 右：参考图 */}
        <ReferenceImageUploader
          b64={refImageB64}
          preview={refImagePreview}
          name={refImageName}
          onChange={(b64, preview, name) => {
            setRefImageB64(b64);
            setRefImagePreview(preview);
            setRefImageName(name);
          }}
          description="上传商品参考图，让 AI 保持商品主体一致地生成不同场景版本。"
        />
      </div>

      {/* 结果 */}
      {(items.length > 0 || generating) && (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="font-semibold">本次生成</span>
            {items.length > 0 && (
              <Chip size="sm" variant="flat">{items.length} 张</Chip>
            )}
          </CardHeader>
          <CardBody>
            {generating && items.length === 0 ? (
              <div className="flex flex-col items-center py-12">
                <Spinner size="lg" />
                <p className="text-sm text-default-500 mt-3">生成中，10-30 秒…</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {items.map((it, i) => (
                  <div
                    key={i}
                    className="relative aspect-square rounded-lg overflow-hidden border border-divider bg-default-100 group cursor-pointer"
                    onClick={() => setPreviewSrc(it.b64
                      ? `data:image/png;base64,${it.b64}`
                      : it.url || "")}
                  >
                    <img
                      src={itemSrc(it)}
                      alt={`#${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      onClick={(e) => { e.stopPropagation(); downloadItem(it); }}
                      className="absolute bottom-1 right-1 w-7 h-7 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                      title="下载"
                    >
                      <Download size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
