"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Spinner } from "@nextui-org/spinner";
import { Chip } from "@nextui-org/chip";
import {
  Image as ImageIcon, Sparkles, Settings as SettingsIcon, Download,
  Wand2, AlertCircle, Upload, X, ChevronDown, ChevronUp, Check, Link2,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import { toastOk, toastErr } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";

const API = (path: string) => `/api/monitor/image${path}`;

const SIZE_OPTIONS = [
  { key: "864x1152",  label: "小红书 3:4（864 × 1152）" },
  { key: "720x1280",  label: "抖音 9:16（720 × 1280）" },
  { key: "1024x1024", label: "正方形 1:1（1024 × 1024）" },
  { key: "512x512",   label: "正方形 1:1 小图（512 × 512，快）" },
  { key: "768x768",   label: "正方形 1:1（768 × 768）" },
  { key: "1024x1792", label: "竖图 9:16 高清（1024 × 1792）" },
  { key: "1792x1024", label: "横图 16:9（1792 × 1024）" },
];

// 套数预设（每套 = 1 个账号要发的内容）
const SETS_PRESETS = [1, 5, 10, 20];
// 每套张数预设（小红书 1 篇笔记最多 9 张轮播；抖音通常 1）
const IMAGES_PER_SET_PRESETS = [1, 3, 6, 9];

// 总张数硬上限：与后端 _MAX_TOTAL 对齐。超过会拒绝。
const MAX_TOTAL = 60;

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

type ConfigState = {
  base_url: string;
  model: string;
  size: string;
  has_key: boolean;
};

const DEFAULT_CONFIG: ConfigState = { base_url: "", model: "", size: "1024x1024", has_key: false };
type GenItem = { b64?: string; url?: string };

// 模块级缓存：按用户隔离，同 Tab 内导航不丢失，刷新才清空
const _imageCache = new Map<string, { items: GenItem[]; error: string }>();

export default function ProductImagePage() {
  const { token } = useAuth();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const uid = me?.username || me?.id || "anon";

  // 用户级 localStorage key 和内存缓存
  const PERSIST_KEY = `pulse.product-image.wizard.${uid}`;
  const userCache = _imageCache.get(uid) ?? { items: [], error: "" };
  if (!_imageCache.has(uid)) _imageCache.set(uid, userCache);
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  // ── 配置 ────────────────────────────────────────────────────────────────
  const [cfg, setCfg] = useState<ConfigState>(DEFAULT_CONFIG);
  const [cfgLoading, setCfgLoading] = useState(true);

  const loadConfig = async () => {
    setCfgLoading(true);
    try {
      const r = await fetch(API("/config"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setCfg({
        base_url: data.base_url || "",
        model: data.model || "",
        size: data.size || "1024x1024",
        has_key: !!data.has_key,
      });
    } catch (e: any) {
      toastErr(`读取配置失败：${e?.message || e}`);
    } finally {
      setCfgLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Prompt 向导 + 生成状态（集中声明，方便持久化） ──────────────────────

  const [wizardOpen, setWizardOpen] = useState(true);
  const [subject, setSubject] = useState("");
  const [selectedScenes, setSelectedScenes] = useState<string[]>([]);
  const [selectedStyle, setSelectedStyle] = useState("ecom");
  const [selectedPlatform, setSelectedPlatform] = useState("小红书");
  const [promptLanguage, setPromptLanguage] = useState<"zh" | "en">("zh");
  const [wizardExtras, setWizardExtras] = useState("");
  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [wizardPrompts, setWizardPrompts] = useState<string[]>([]);
  const [selectedPromptIdx, setSelectedPromptIdx] = useState<number | null>(null);
  const [wizardError, setWizardError] = useState("");

  // prompt / negativePrompt 提前声明，恢复 effect 可引用
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");

  // 数量：套数（账号数）× 每套张数（每篇笔记的轮播图数）
  const [sets, setSets] = useState<number>(1);
  const [imagesPerSet, setImagesPerSet] = useState<number>(1);

  // 恢复：组件挂载时从 localStorage 读回上次状态
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.subject)          setSubject(d.subject);
      if (d.selectedScenes)   setSelectedScenes(d.selectedScenes);
      if (d.selectedStyle)    setSelectedStyle(d.selectedStyle);
      if (d.selectedPlatform) setSelectedPlatform(d.selectedPlatform);
      if (d.promptLanguage)   setPromptLanguage(d.promptLanguage);
      if (d.wizardExtras)     setWizardExtras(d.wizardExtras);
      if (d.wizardPrompts?.length) setWizardPrompts(d.wizardPrompts);
      if (d.prompt)           setPrompt(d.prompt);
      if (d.negativePrompt)   setNegativePrompt(d.negativePrompt);
      if (d.selectedPromptIdx != null) setSelectedPromptIdx(d.selectedPromptIdx);
      if (typeof d.sets === "number" && d.sets >= 1) setSets(d.sets);
      if (typeof d.imagesPerSet === "number" && d.imagesPerSet >= 1) setImagesPerSet(d.imagesPerSet);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存：state 变化时写入 localStorage；跳过首次执行（避免覆盖恢复中的旧值）
  const _firstSave = useRef(true);
  useEffect(() => {
    if (_firstSave.current) { _firstSave.current = false; return; }
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({
        subject, selectedScenes, selectedStyle, selectedPlatform,
        promptLanguage, wizardExtras, wizardPrompts, prompt, negativePrompt, selectedPromptIdx,
        sets, imagesPerSet,
      }));
    } catch {}
  }, [subject, selectedScenes, selectedStyle, selectedPlatform,
      promptLanguage, wizardExtras, wizardPrompts, prompt, negativePrompt, selectedPromptIdx,
      sets, imagesPerSet]);

  const toggleScene = (s: string) =>
    setSelectedScenes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );

  const handleGeneratePrompts = async () => {
    if (!subject.trim()) { toastErr("请填写商品主体"); return; }
    setGeneratingPrompts(true);
    setWizardPrompts([]);
    setWizardError("");
    setSelectedPromptIdx(null);
    try {
      const r = await fetch(API("/generate-prompts"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          subject: subject.trim(),
          scenes: selectedScenes,
          style: STYLE_OPTIONS.find((s) => s.key === selectedStyle)?.label || selectedStyle,
          platform: selectedPlatform,
          extras: wizardExtras.trim(),
          language: promptLanguage,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.error) {
        setWizardError(data.error);
        toastErr(data.error);
        return;
      }
      const list: string[] = Array.isArray(data.prompts) ? data.prompts : [];
      if (list.length === 0) {
        setWizardError("AI 未返回有效 Prompt，请重试");
        return;
      }
      setWizardPrompts(list);
      toastOk(`已生成 ${list.length} 条 Prompt`);
    } catch (e: any) {
      setWizardError(e?.message || String(e));
      toastErr(`生成失败：${e?.message || e}`);
    } finally {
      setGeneratingPrompts(false);
    }
  };

  const usePrompt = (idx: number) => {
    setPrompt(wizardPrompts[idx]);
    setSelectedPromptIdx(idx);
    // 滚动到生成区
    document.getElementById("gen-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // ── 参考图 ──────────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refImageB64, setRefImageB64] = useState<string>("");
  const [refImagePreview, setRefImagePreview] = useState<string>("");
  const [refImageName, setRefImageName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [postUrlInput, setPostUrlInput] = useState("");
  const [fetchingCover, setFetchingCover] = useState(false);

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toastErr("请上传图片文件（PNG / JPG / WEBP）");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toastErr("图片不能超过 10 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      // result = "data:image/png;base64,XXXX"
      const b64 = result.split(",")[1] || "";
      setRefImageB64(b64);
      setRefImagePreview(result);
      setRefImageName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const clearRefImage = () => {
    setRefImageB64("");
    setRefImagePreview("");
    setRefImageName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // 从小红书/抖音作品 URL 拉取标题+正文，填入 Prompt 区作为生成依据
  // （不强制把封面图作为参考图，用户如果需要可以单独上传）
  const handleFetchPostContent = async () => {
    const url = postUrlInput.trim();
    if (!url) { toastErr("请粘贴小红书或抖音作品链接"); return; }
    setFetchingCover(true);
    try {
      const r = await fetch(API("/fetch-post-cover"), {
        method: "POST",
        headers,
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) {
        toastErr(`抓取失败：${data?.error || `HTTP ${r.status}`}`);
        return;
      }
      const title = (data.title || "").trim();
      const desc = (data.desc || "").trim();
      if (!title && !desc) {
        toastErr("作品文案为空（可能被风控或无正文），请换一篇");
        return;
      }

      // 把文案拼成给图像模型用的中文 brief：标题作为主旨，正文截一段做场景描述
      const brief = [
        title && `主旨：${title}`,
        desc && `内容/场景：${desc.slice(0, 280)}`,  // 截 280 字够 prompt 用，太长 token 浪费
        "",
        "请基于上述笔记的内容主旨，生成一张匹配该笔记调性的商品图：商品作为画面主体，",
        "光线、构图、背景与正文场景一致；高质量，专业商品摄影。",
      ].filter(Boolean).join("\n");
      setPrompt(brief);

      // 默认按平台预选尺寸，让生成出来的图直接能发同平台
      if (!genSize && data.platform === "xhs") setGenSize("864x1152");
      else if (!genSize && data.platform === "douyin") setGenSize("720x1280");

      toastOk(`已加载文案：${title.slice(0, 24) || data.post_id}`);
    } catch (e: any) {
      toastErr(`抓取异常：${e?.message || e}`);
    } finally {
      setFetchingCover(false);
    }
  };

  // ── 生成 ────────────────────────────────────────────────────────────────
  // 二维数量：派生总张数（封顶 MAX_TOTAL，避免误填超大数字打爆上游）。
  // 例 10 个账号每个发 6 张轮播 → sets=10, imagesPerSet=6, 共 60 张。
  const count = Math.min(Math.max(1, sets * imagesPerSet), MAX_TOTAL);

  const [genSize, setGenSize] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [items, setItems] = useState<GenItem[]>(userCache.items);
  const [genError, setGenError] = useState<string>(userCache.error);

  // 同步图片结果到模块缓存（按用户隔离）
  const setItemsAndCache = (v: GenItem[]) => { userCache.items = v; setItems(v); };
  const setGenErrorAndCache = (v: string) => { userCache.error = v; setGenError(v); };

  const canGenerate = !!cfg.has_key && !!cfg.base_url && !!cfg.model && !generating;

  // 前端分批：count > 4 时拆成多次请求，每批 4 张，增量追加显示。
  // 单次请求耗时 ~30-60s，10 张分 3 批比一次等 3 分钟体验好得多。
  const BATCH_SIZE = 4;

  const handleGenerate = async () => {
    if (!prompt.trim()) { toastErr("请填写 Prompt 或通过向导生成"); return; }
    if (!cfg.has_key) { toastErr("请先在「系统配置」页配置商品图 API Key"); return; }
    setGenerating(true);
    setGenErrorAndCache("");
    setItemsAndCache([]);

    const accumulated: GenItem[] = [];
    let remaining = count;

    try {
      while (remaining > 0) {
        const take = Math.min(remaining, BATCH_SIZE);
        const body: Record<string, any> = {
          prompt: prompt.trim(),
          negative_prompt: negativePrompt.trim(),
          n: take,
          size: genSize || undefined,
        };
        if (refImageB64) body.reference_image_b64 = refImageB64;

        const r = await fetch(API("/generate"), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        const batchImgs: GenItem[] = Array.isArray(data?.images) ? data.images : [];

        if (!r.ok || data?.error) {
          const msg = data?.error || data?.detail || `HTTP ${r.status}`;
          if (accumulated.length > 0) {
            // 部分成功：保留已生成的，并提示剩余失败
            setGenErrorAndCache(`已生成 ${accumulated.length}/${count} 张，剩余失败：${msg}`);
            toastErr(`部分成功（${accumulated.length}/${count}）：${msg}`);
            return;
          }
          setGenErrorAndCache(String(msg));
          toastErr(`生成失败：${msg}`);
          return;
        }
        if (batchImgs.length === 0) {
          if (accumulated.length > 0) {
            setGenErrorAndCache(`已生成 ${accumulated.length}/${count} 张，剩余批次未返回图片`);
            toastErr(`部分成功（${accumulated.length}/${count}）`);
            return;
          }
          setGenErrorAndCache("上游未返回图片");
          toastErr("上游未返回图片");
          return;
        }

        accumulated.push(...batchImgs);
        // 立刻刷新到 UI，让用户能看到进度
        setItemsAndCache([...accumulated]);
        remaining -= take;
      }
      toastOk(`生成成功（${accumulated.length} 张）`);
    } catch (e: any) {
      if (accumulated.length > 0) {
        setGenErrorAndCache(`已生成 ${accumulated.length}/${count} 张，中断：${e?.message || e}`);
        toastErr(`部分成功（${accumulated.length}/${count}）：${e?.message || e}`);
      } else {
        setGenErrorAndCache(e?.message || String(e));
        toastErr(`生成失败：${e?.message || e}`);
      }
    } finally {
      setGenerating(false);
    }
  };

  // 把全局 idx (0..count-1) 拆成 (套号, 套内序号)
  // 例 imagesPerSet=6, idx=7 → set 2, image 2 (第 2 套的第 2 张)
  const itemLabel = (idx: number) => {
    if (imagesPerSet <= 1) return `${idx + 1}`;
    const setIdx = Math.floor(idx / imagesPerSet) + 1;
    const inSetIdx = (idx % imagesPerSet) + 1;
    return `${setIdx}-${inSetIdx}`;
  };

  const downloadItem = async (item: GenItem, idx: number) => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `product-image-${ts}-${itemLabel(idx)}.png`;
      if (item.b64) {
        const bin = atob(item.b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: "image/png" });
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = u; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      } else if (item.url) {
        const a = document.createElement("a");
        a.href = item.url; a.download = filename; a.target = "_blank"; a.rel = "noopener"; a.click();
      }
    } catch (e: any) {
      toastErr(`下载失败：${e?.message || e}`);
    }
  };

  // 全部下载（多套图分发场景）：依次触发每张的 download，浏览器会自动排队
  const downloadAll = async () => {
    if (!items.length) return;
    for (let i = 0; i < items.length; i++) {
      await downloadItem(items[i], i);
      // 浏览器对连续 download 有节流，间隔 200ms 避免被合并/丢失
      await new Promise((r) => setTimeout(r, 200));
    }
    toastOk(`已触发 ${items.length} 张下载`);
  };

  const itemSrc = (item: GenItem) =>
    item.b64 ? `data:image/png;base64,${item.b64}` : (item.url || "");

  return (
    <div className="max-w-5xl mx-auto space-y-6 p-4 md:p-6">
      {/* 标题 */}
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 text-primary p-3">
          <Wand2 size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            商品图工具
            <Chip size="sm" variant="flat" color="secondary">Beta</Chip>
          </h1>
          <p className="text-sm text-default-500 mt-1">
            Prompt 向导一键生成描述词，支持上传商品主体图进行参考图生成。
          </p>
        </div>
      </div>

      {/* 配置状态 */}
      <Card className={cfg.has_key ? "border-success/30" : "border-warning/30"}>
        <CardBody className="flex flex-row items-center gap-3 py-3">
          <SettingsIcon size={18} className="text-default-400 shrink-0" />
          <div className="flex-1 min-w-0">
            {cfgLoading ? (
              <span className="text-sm text-default-500">加载配置中…</span>
            ) : cfg.has_key ? (
              <span className="text-sm text-default-600">
                图像 API 已配置
                {cfg.model && <span className="text-default-400 ml-2">model: {cfg.model} · size: {cfg.size}</span>}
              </span>
            ) : (
              <span className="text-sm text-warning-600">
                {isAdmin ? "图像 API 尚未配置，请在「系统配置」中填写" : "图像 API 尚未配置，请联系管理员开启"}
              </span>
            )}
          </div>
          {isAdmin && (
            <Chip
              as="a"
              href="/dashboard/monitor/settings"
              size="sm"
              variant="flat"
              color={cfg.has_key ? "default" : "warning"}
              className="cursor-pointer shrink-0"
            >
              {cfg.has_key ? "修改配置" : "去设置（管理员）"}
            </Chip>
          )}
        </CardBody>
      </Card>

      {/* ── Prompt 向导 ─────────────────────────────────────────────────── */}
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
              {/* 商品主体 */}
              <Input
                label="商品主体"
                placeholder="例：口红、护肤精华、运动鞋、咖啡机"
                value={subject}
                onValueChange={setSubject}
                isRequired
                description="描述你的商品是什么"
              />
              {/* 目标平台 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-default-700">目标平台</span>
                <div className="flex flex-wrap gap-2">
                  {PLATFORM_OPTIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setSelectedPlatform(p)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        selectedPlatform === p
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

            {/* 场景（多选） */}
            <div className="flex flex-col gap-2">
              <span className="text-sm text-default-700">场景（可多选）</span>
              <div className="flex flex-wrap gap-2">
                {SCENE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleScene(s)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      selectedScenes.includes(s)
                        ? "bg-secondary text-white border-secondary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* 风格（单选） */}
            <div className="flex flex-col gap-2">
              <span className="text-sm text-default-700">画面风格</span>
              <div className="flex flex-wrap gap-2">
                {STYLE_OPTIONS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSelectedStyle(s.key)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      selectedStyle === s.key
                        ? "bg-primary text-white border-primary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 额外描述 */}
            <Input
              label="补充描述（可选）"
              placeholder="例：粉色包装、节日礼盒、蓝色配色"
              value={wizardExtras}
              onValueChange={setWizardExtras}
            />

            {/* Prompt 语言 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-default-700">Prompt 语言</span>
              <div className="flex gap-2">
                {(["zh", "en"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setPromptLanguage(lang)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      promptLanguage === lang
                        ? "bg-primary text-white border-primary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {lang === "zh" ? "中文" : "English"}
                  </button>
                ))}
              </div>
              <p className="text-xs text-default-400">
                {promptLanguage === "zh" ? "生成中文 Prompt（部分图像模型可能对中文支持有限）" : "生成英文 Prompt（推荐，兼容性最好）"}
              </p>
            </div>

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

            {/* Prompt 结果列表 */}
            {wizardError && !generatingPrompts && (
              <div className="flex items-start gap-2 text-sm text-danger bg-danger/10 rounded-lg p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{wizardError}</span>
              </div>
            )}

            {wizardPrompts.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-default-500">点击「使用」将 Prompt 填入下方生成区</p>
                {wizardPrompts.map((p, i) => (
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

      {/* ── 主区域 ──────────────────────────────────────────────────────── */}
      <div id="gen-section" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左：输入 + 参考图 */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex items-center gap-2">
              <ImageIcon size={18} className="text-primary" />
              <span className="font-semibold">生成参数</span>
            </CardHeader>
            <CardBody className="space-y-4">
              {/* 从小红书/抖音作品 URL 加载文案：拉到的标题+正文会填入 Prompt 区，
                  让 AI 基于这篇笔记的调性生成对应的商品图 */}
              <div className="flex flex-col gap-2 rounded-lg bg-default-50 p-3">
                <div className="flex items-center gap-2 text-xs text-default-600">
                  <Link2 size={14} className="text-primary" />
                  <span>从小红书 / 抖音作品 URL 加载文案</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    placeholder="粘贴作品链接（xhslink.com、xiaohongshu.com、douyin.com）"
                    value={postUrlInput}
                    onValueChange={setPostUrlInput}
                    isDisabled={fetchingCover}
                  />
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    onPress={handleFetchPostContent}
                    isLoading={fetchingCover}
                    isDisabled={!postUrlInput.trim() || fetchingCover}
                  >
                    {fetchingCover ? "拉取中" : "加载文案"}
                  </Button>
                </div>
                <p className="text-xs text-default-400">
                  场景：找一篇爆款笔记 → 粘贴链接 → 自动把标题/正文填入 Prompt → 生成对应调性的商品图。
                  如要保持商品主体一致，可在下方再上传商品参考图。
                </p>
              </div>

              <Textarea
                label="Prompt"
                placeholder="在上方向导点「使用」自动填入，或粘贴作品链接「加载文案」自动填充，也可手动输入"
                minRows={5}
                value={prompt}
                onValueChange={setPrompt}
                isRequired
              />
              <Textarea
                label="Negative Prompt（可选）"
                placeholder="例：模糊, 水印, 文字, 低质量"
                minRows={2}
                value={negativePrompt}
                onValueChange={setNegativePrompt}
                description="部分模型不支持，会自动拼到 prompt 尾部"
              />
              {/* 数量：套数（账号数）× 每套张数（轮播张数）。总张数 = 套×张 */}
              <div className="flex flex-col gap-3 rounded-lg border border-divider p-3 bg-default-50/40">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-default-700">数量</span>
                  <span className="text-xs text-default-500">
                    共 <span className="font-semibold text-primary">{count}</span> 张
                    <span className="text-default-400"> = {sets} 套 × {imagesPerSet} 张/套</span>
                  </span>
                </div>

                {/* 套数 */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-default-500">套数（账号数）</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {SETS_PRESETS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setSets(v)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                          sets === v
                            ? "bg-primary text-white border-primary"
                            : "border-divider text-default-600 hover:bg-default-100"
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      max={MAX_TOTAL}
                      aria-label="自定义套数"
                      placeholder="自定义"
                      value={SETS_PRESETS.includes(sets) ? "" : String(sets)}
                      onValueChange={(v) => {
                        const n = parseInt(v || "0", 10);
                        if (!Number.isNaN(n) && n >= 1) setSets(Math.min(n, MAX_TOTAL));
                      }}
                      className="w-24"
                    />
                  </div>
                </div>

                {/* 每套张数 */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-default-500">每套张数（轮播图数）</span>
                  <div className="flex flex-wrap items-center gap-2">
                    {IMAGES_PER_SET_PRESETS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setImagesPerSet(v)}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                          imagesPerSet === v
                            ? "bg-secondary text-white border-secondary"
                            : "border-divider text-default-600 hover:bg-default-100"
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                    <Input
                      size="sm"
                      type="number"
                      min={1}
                      max={9}
                      aria-label="自定义每套张数"
                      placeholder="自定义"
                      value={IMAGES_PER_SET_PRESETS.includes(imagesPerSet) ? "" : String(imagesPerSet)}
                      onValueChange={(v) => {
                        const n = parseInt(v || "0", 10);
                        // 小红书最多 9 张轮播
                        if (!Number.isNaN(n) && n >= 1) setImagesPerSet(Math.min(n, 9));
                      }}
                      className="w-24"
                    />
                  </div>
                </div>

                {/* 总数提示 */}
                {count >= 10 && (
                  <p className="text-xs text-default-400 leading-relaxed">
                    分批顺序生成（每批 4 张），约需 {Math.ceil(count / 4)} × 30-60 秒
                    （≈ {Math.ceil(count / 4 / 2)}-{Math.ceil(count / 4)} 分钟）。
                    上传参考图可保持各套商品主体一致。
                  </p>
                )}
                {count >= MAX_TOTAL && sets * imagesPerSet > MAX_TOTAL && (
                  <p className="text-xs text-warning-600 leading-relaxed">
                    总数已达上限 {MAX_TOTAL} 张（请求 {sets * imagesPerSet} 张被裁剪）。
                  </p>
                )}
              </div>

              {/* 尺寸：用按钮组突出小红书 3:4 / 抖音 9:16 两个常用预设 */}
              <div className="flex flex-col gap-2">
                <span className="text-sm text-default-700">尺寸</span>
                <div className="flex flex-wrap gap-2">
                  {SIZE_OPTIONS.slice(0, 3).map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => setGenSize(o.key)}
                      className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                        genSize === o.key
                          ? "bg-primary text-white border-primary"
                          : "border-divider text-default-600 hover:bg-default-100"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <Select
                  size="sm"
                  aria-label="更多尺寸"
                  placeholder={genSize ? "更多尺寸…" : `使用配置默认：${cfg.size}`}
                  selectedKeys={genSize && !["864x1152", "720x1280", "1024x1024"].includes(genSize) ? [genSize] : []}
                  onSelectionChange={(keys) => {
                    const k = Array.from(keys as Set<string>)[0] || "";
                    setGenSize(k);
                  }}
                >
                  {SIZE_OPTIONS.slice(3).map((o) => (
                    <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                  ))}
                </Select>
              </div>
            </CardBody>
          </Card>

          {/* 参考图上传 */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <Upload size={18} className="text-primary" />
              <span className="font-semibold">参考图（可选）</span>
              <Chip size="sm" variant="flat" color="default">图生图</Chip>
            </CardHeader>
            <CardBody className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImageFile(file);
                }}
              />
              {refImagePreview ? (
                <div className="space-y-3">
                  <div className="relative rounded-lg overflow-hidden border border-divider">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={refImagePreview}
                      alt="reference"
                      className="w-full max-h-48 object-contain bg-default-50"
                    />
                    <button
                      type="button"
                      onClick={clearRefImage}
                      className="absolute top-2 right-2 rounded-full bg-black/50 text-white p-1 hover:bg-black/70"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <p className="text-xs text-default-400 truncate">{refImageName}</p>
                  <p className="text-xs text-warning-600 bg-warning/10 rounded p-2">
                    参考图生成调用 <code>/images/edits</code> 端点，需要你使用的模型支持图片编辑（如 gpt-image-1）。
                  </p>
                </div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) handleImageFile(file);
                  }}
                  className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-lg p-8 cursor-pointer transition-colors ${
                    dragOver
                      ? "border-primary bg-primary/5"
                      : "border-divider hover:border-primary/50 hover:bg-default-50"
                  }`}
                >
                  <Upload size={24} className="text-default-400" />
                  <p className="text-sm text-default-500">点击或拖拽上传商品主体图</p>
                  <p className="text-xs text-default-400">PNG / JPG / WEBP，最大 10 MB</p>
                </div>
              )}
            </CardBody>
          </Card>

          <Button
            color="primary"
            size="lg"
            className="w-full"
            startContent={<Sparkles size={18} />}
            onPress={handleGenerate}
            isDisabled={!canGenerate}
            isLoading={generating}
          >
            {generating
              ? `生成中… 约 ${Math.ceil(count / 4) * 30}-${Math.ceil(count / 4) * 60} 秒`
              : (() => {
                  const suffix = imagesPerSet > 1
                    ? `${count} 张（${sets} 套 × ${imagesPerSet}）`
                    : `${count} 张`;
                  return refImageB64 ? `以参考图生成 ${suffix}` : `生成 ${suffix}`;
                })()}
          </Button>
          {!cfg.has_key && (
            <div className="flex items-start gap-2 text-xs text-warning bg-warning/10 rounded-lg p-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                {isAdmin
                  ? "尚未配置图像 API Key，请到「系统配置」→「商品图 API 配置」填写并保存。"
                  : "图像 API 尚未开启，请联系管理员配置。"}
              </span>
            </div>
          )}
        </div>

        {/* 右：结果 */}
        <Card>
          <CardHeader className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ImageIcon size={18} className="text-primary" />
              <span className="font-semibold">生成结果</span>
              {generating && count > 1 ? (
                <Chip size="sm" color="primary" variant="flat">
                  {items.length} / {count} 张
                </Chip>
              ) : items.length > 0 ? (
                <Chip size="sm" variant="flat">{items.length} 张</Chip>
              ) : null}
            </div>
            {items.length > 1 && !generating && (
              <Button
                size="sm"
                variant="flat"
                color="primary"
                startContent={<Download size={14} />}
                onPress={downloadAll}
              >
                全部下载
              </Button>
            )}
          </CardHeader>
          <CardBody>
            {/* 生成中且还没出图 → 全骨架；生成中已出部分 → 已出图 + 剩余骨架 */}
            {generating && items.length === 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {Array.from({ length: Math.min(count, 12) }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-[3/4] rounded-lg bg-default-100 animate-pulse flex items-center justify-center"
                  >
                    <Spinner size="sm" />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              genError ? (
                <EmptyState icon={AlertCircle} title="生成失败" hint={genError} />
              ) : (
                <EmptyState
                  icon={ImageIcon}
                  title="还没有图片"
                  hint="通过左侧向导生成 Prompt，或手动填写后点击「生成图片」。"
                />
              )
            ) : (
              <div className={`grid gap-3 ${
                items.length <= 4 && !generating ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"
              }`}>
                {items.map((it, idx) => (
                  <div
                    key={idx}
                    className="group relative rounded-lg overflow-hidden border border-divider bg-default-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={itemSrc(it)}
                      alt={`generated-${idx + 1}`}
                      className="w-full h-auto aspect-[3/4] object-cover"
                    />
                    {/* 序号角标：套数=1 显示 #N；多套时显示 套-张（如 1-1, 2-3） */}
                    <span className="absolute top-1.5 left-1.5 rounded-full bg-black/60 text-white text-[10px] px-1.5 py-0.5">
                      {imagesPerSet > 1 ? itemLabel(idx) : `#${idx + 1}`}
                    </span>
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-end justify-end p-2 opacity-0 group-hover:opacity-100">
                      <Button
                        size="sm"
                        variant="solid"
                        color="primary"
                        startContent={<Download size={14} />}
                        onPress={() => downloadItem(it, idx)}
                      >
                        下载
                      </Button>
                    </div>
                  </div>
                ))}
                {/* 生成中：尾部追加剩余张数的占位骨架（最多展示 6 个，避免太长） */}
                {generating && count > items.length && Array.from({
                  length: Math.min(count - items.length, 6),
                }).map((_, i) => (
                  <div
                    key={`skeleton-${i}`}
                    className="aspect-[3/4] rounded-lg bg-default-100 animate-pulse flex items-center justify-center"
                  >
                    <Spinner size="sm" />
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
