"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Slider } from "@nextui-org/slider";
import { Spinner } from "@nextui-org/spinner";
import { Chip } from "@nextui-org/chip";
import {
  Image as ImageIcon, Sparkles, Settings as SettingsIcon, Download,
  ChevronDown, ChevronRight, Wand2, AlertCircle,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";

const API = (path: string) => `/api/monitor/image${path}`;

const SIZE_OPTIONS = [
  { key: "512x512",   label: "512 x 512（小图，快）" },
  { key: "768x768",   label: "768 x 768" },
  { key: "1024x1024", label: "1024 x 1024（默认）" },
  { key: "1024x1792", label: "1024 x 1792（竖图）" },
  { key: "1792x1024", label: "1792 x 1024（横图）" },
];

type ConfigState = {
  base_url: string;
  api_key: string;     // 仅本地输入态，不展示后端值
  model: string;
  size: string;
  has_key: boolean;    // 后端是否已存有 key
};

const DEFAULT_CONFIG: ConfigState = {
  base_url: "",
  api_key: "",
  model: "",
  size: "1024x1024",
  has_key: false,
};

type GenItem = { b64?: string; url?: string };

export default function ProductImagePage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  // ── 配置区 ─────────────────────────────────────────────────────────────
  const [cfg, setCfg] = useState<ConfigState>(DEFAULT_CONFIG);
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false); // 折叠态

  const setCfgField = <K extends keyof ConfigState>(k: K, v: ConfigState[K]) =>
    setCfg((prev) => ({ ...prev, [k]: v }));

  const loadConfig = async () => {
    setCfgLoading(true);
    try {
      const r = await fetch(API("/config"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setCfg({
        base_url: data.base_url || "",
        api_key: "",
        model: data.model || "",
        size: data.size || "1024x1024",
        has_key: !!data.has_key,
      });
      // has_key=false 时默认展开配置卡
      setCfgOpen(!data.has_key);
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

  const saveConfig = async () => {
    if (!cfg.base_url.trim()) { toastErr("请填写 API base_url"); return; }
    if (!cfg.model.trim())    { toastErr("请填写 model"); return; }
    setCfgSaving(true);
    try {
      const body: Record<string, string> = {
        base_url: cfg.base_url.trim(),
        model: cfg.model.trim(),
        size: cfg.size,
      };
      // api_key 留空表示不覆盖
      if (cfg.api_key.trim()) body.api_key = cfg.api_key.trim();
      const r = await fetch(API("/config"), {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      toastOk("配置已保存");
      // 刷新 has_key
      await loadConfig();
    } catch (e: any) {
      toastErr(`保存失败：${e?.message || e}`);
    } finally {
      setCfgSaving(false);
    }
  };

  // ── 生成区 ─────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [count, setCount] = useState<number>(1);
  const [genSize, setGenSize] = useState<string>(""); // 空 = 用配置默认

  const [generating, setGenerating] = useState(false);
  const [items, setItems] = useState<GenItem[]>([]);
  const [genError, setGenError] = useState<string>("");

  const canGenerate = !!cfg.has_key && !!cfg.base_url && !!cfg.model && !generating;

  const handleGenerate = async () => {
    if (!prompt.trim()) { toastErr("请填写 prompt"); return; }
    if (!cfg.has_key) { toastErr("请先在上方配置并保存 API Key"); setCfgOpen(true); return; }
    setGenerating(true);
    setGenError("");
    setItems([]);
    try {
      const r = await fetch(API("/generate"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: prompt.trim(),
          negative_prompt: negativePrompt.trim(),
          n: count,
          size: genSize || undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.error || data?.detail || `HTTP ${r.status}`;
        setGenError(String(msg));
        toastErr(`生成失败：${msg}`);
        return;
      }
      // 后端把上游错误也作为 200 + {error,status} 返回
      if (data.error) {
        setGenError(String(data.error));
        toastErr(`生成失败：${data.error}`);
        return;
      }
      const list: GenItem[] = Array.isArray(data.images) ? data.images : [];
      if (list.length === 0) {
        setGenError("上游未返回图片");
        toastErr("上游未返回图片");
        return;
      }
      setItems(list);
      toastOk(`生成成功（${list.length} 张）`);
    } catch (e: any) {
      setGenError(e?.message || String(e));
      toastErr(`生成失败：${e?.message || e}`);
    } finally {
      setGenerating(false);
    }
  };

  const downloadItem = async (item: GenItem, idx: number) => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `product-image-${ts}-${idx + 1}.png`;
      if (item.b64) {
        const bin = atob(item.b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const blob = new Blob([buf], { type: "image/png" });
        const u = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = u; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      } else if (item.url) {
        // 直接走 a download；跨域时浏览器可能仍会打开新页签——属预期行为
        const a = document.createElement("a");
        a.href = item.url; a.download = filename;
        a.target = "_blank"; a.rel = "noopener";
        a.click();
      }
    } catch (e: any) {
      toastErr(`下载失败：${e?.message || e}`);
    }
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
            接入第三方图像 API（OpenAI 兼容）。可对接豆包 / 通义万相 / 即梦 / 智谱 CogView / Replicate 等。
          </p>
        </div>
      </div>

      {/* 配置卡 */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setCfgOpen((v) => !v)}
            className="flex items-center gap-2 text-left"
            aria-expanded={cfgOpen}
          >
            {cfgOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <SettingsIcon size={18} className="text-default-500" />
            <span className="font-semibold">API 配置</span>
            {cfg.has_key
              ? <Chip size="sm" variant="flat" color="success">已配置</Chip>
              : <Chip size="sm" variant="flat" color="warning">未配置</Chip>}
          </button>
          <span className="text-xs text-default-400">
            {cfg.has_key ? `model: ${cfg.model || "-"} · size: ${cfg.size}` : "请先填写并保存"}
          </span>
        </CardHeader>
        {cfgOpen && (
          <CardBody className="space-y-4">
            {cfgLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size="sm" />
                <span className="ml-2 text-sm text-default-500">加载配置中…</span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input
                    label="API base_url"
                    placeholder="https://api.openai.com/v1"
                    value={cfg.base_url}
                    onValueChange={(v) => setCfgField("base_url", v)}
                    description="OpenAI 兼容路径，会自动拼 /images/generations"
                  />
                  <Input
                    label="API Key"
                    type="password"
                    placeholder={cfg.has_key ? "（已保存，留空则不覆盖）" : "sk-..."}
                    value={cfg.api_key}
                    onValueChange={(v) => setCfgField("api_key", v)}
                    description={cfg.has_key ? "已存有 key，留空将保留旧值" : "首次保存请填写"}
                  />
                  <Input
                    label="Model"
                    placeholder="dall-e-3 / cogview-3 / wanx-v1 ..."
                    value={cfg.model}
                    onValueChange={(v) => setCfgField("model", v)}
                  />
                  <Select
                    label="默认尺寸"
                    selectedKeys={cfg.size ? [cfg.size] : []}
                    onSelectionChange={(keys) => {
                      const k = Array.from(keys as Set<string>)[0];
                      if (k) setCfgField("size", k);
                    }}
                  >
                    {SIZE_OPTIONS.map((o) => (
                      <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="flex justify-end">
                  <Button color="primary" onPress={saveConfig} isLoading={cfgSaving}>
                    保存配置
                  </Button>
                </div>
              </>
            )}
          </CardBody>
        )}
      </Card>

      {/* 主区域：左输入 / 右结果 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左：输入 */}
        <Card>
          <CardHeader className="flex items-center gap-2">
            <Sparkles size={18} className="text-primary" />
            <span className="font-semibold">提示词</span>
          </CardHeader>
          <CardBody className="space-y-4">
            <Textarea
              label="Prompt"
              placeholder="例：极简白底，一瓶护肤精华，柔光，正面构图，高清产品图，电商风格"
              minRows={6}
              value={prompt}
              onValueChange={setPrompt}
              isRequired
            />
            <Textarea
              label="Negative Prompt（可选）"
              placeholder="例：模糊, 水印, 文字, 多余手, 低质"
              minRows={2}
              value={negativePrompt}
              onValueChange={setNegativePrompt}
              description="部分模型不支持，会自动拼到 prompt 尾部"
            />
            <div>
              <Slider
                label="生成数量"
                size="sm"
                step={1}
                minValue={1}
                maxValue={4}
                value={count}
                onChange={(v) => setCount(Array.isArray(v) ? v[0] : v)}
                marks={[
                  { value: 1, label: "1" },
                  { value: 2, label: "2" },
                  { value: 3, label: "3" },
                  { value: 4, label: "4" },
                ]}
              />
            </div>
            <Select
              label="尺寸（覆盖默认）"
              placeholder={`使用配置默认：${cfg.size}`}
              selectedKeys={genSize ? [genSize] : []}
              onSelectionChange={(keys) => {
                const k = Array.from(keys as Set<string>)[0] || "";
                setGenSize(k);
              }}
            >
              {SIZE_OPTIONS.map((o) => (
                <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
              ))}
            </Select>
            <Button
              color="primary"
              size="lg"
              className="w-full"
              startContent={<Sparkles size={18} />}
              onPress={handleGenerate}
              isDisabled={!canGenerate}
              isLoading={generating}
            >
              {generating ? "生成中…" : "生成图片"}
            </Button>
            {!cfg.has_key && (
              <div className="flex items-start gap-2 text-xs text-warning bg-warning/10 rounded-lg p-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>尚未配置 API Key，请展开上方"API 配置"卡填写并保存。</span>
              </div>
            )}
          </CardBody>
        </Card>

        {/* 右：结果 */}
        <Card>
          <CardHeader className="flex items-center gap-2">
            <ImageIcon size={18} className="text-primary" />
            <span className="font-semibold">生成结果</span>
            {items.length > 0 && (
              <Chip size="sm" variant="flat">{items.length} 张</Chip>
            )}
          </CardHeader>
          <CardBody>
            {generating ? (
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: count }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-square rounded-lg bg-default-100 animate-pulse flex items-center justify-center"
                  >
                    <Spinner size="sm" />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              genError ? (
                <EmptyState
                  icon={AlertCircle}
                  title="生成失败"
                  hint={genError}
                />
              ) : (
                <EmptyState
                  icon={ImageIcon}
                  title="还没有图片"
                  hint="左侧填写 prompt 后点击「生成图片」，结果会显示在这里。"
                />
              )
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {items.map((it, idx) => (
                  <div
                    key={idx}
                    className="group relative rounded-lg overflow-hidden border border-divider bg-default-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={itemSrc(it)}
                      alt={`generated-${idx + 1}`}
                      className="w-full h-auto aspect-square object-cover"
                    />
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
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
