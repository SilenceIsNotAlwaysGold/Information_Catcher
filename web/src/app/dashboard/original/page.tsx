"use client";

/**
 * 原创板块 —— 用户写底稿，AI 按平台风格改写。
 *
 * 单页内 3 个平台 tab：小红书 / 抖音 / 公众号。
 * 切平台只是改 system prompt + 占位符 + 字数预期，调用同一个 /api/original/rewrite。
 *
 * 计费：cross_rewrite，0.5 点 / 次。
 */
import { useMemo, useState } from "react";
import { Tabs, Tab } from "@nextui-org/tabs";
import { Button } from "@nextui-org/button";
import { Textarea, Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import {
  PenLine, Wand2, Copy, RotateCcw, Coins, FileText,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ModelSelector } from "@/components/ModelSelector";
import { PageHeader, SectionCard, EmptyState } from "@/components/ui";
import { toastOk, toastErr, toastInsufficientCredits } from "@/lib/toast";

type Platform = "xhs" | "douyin" | "mp";

const PLATFORMS: { key: Platform; label: string; emoji: string;
  placeholder: string; tip: string; expectedLen: string }[] = [
  {
    key: "xhs", label: "小红书", emoji: "🌸",
    placeholder: "如：今天在宜家买了个抽屉收纳盒，9.9，原本只想装袜子，结果发现把化妆台、首饰盒、旅行装行李箱都能整理一遍，太香了。想推荐给所有姐妹。",
    tip: "AI 会改写成首句钩子 + 短分段 + emoji + 个人口吻 + 引导互动；200-400 字。",
    expectedLen: "200-400 字",
  },
  {
    key: "douyin", label: "抖音", emoji: "🎵",
    placeholder: "如：分享一个 5 块钱解决卧室收纳的小神器：可挂式真空袋。羽绒服、被子、过季衣服塞进去抽真空，体积少 70%。我家衣柜终于不爆了。",
    tip: "AI 会改写成 5 秒钩子 + 口语化 + 镜头说明 + 结尾 CTA 的口播脚本；30-60 秒。",
    expectedLen: "30-60 秒口播",
  },
  {
    key: "mp", label: "公众号", emoji: "📰",
    placeholder: "如：聊一下我对 AI 工具替代设计师这个话题的看法。我做了 5 年设计，最近用了一段时间 Figma + AI 插件 + Midjourney，确实有些环节被替代了，但核心创意工作还在……",
    tip: "AI 会改写成大标题 + 导语 + 3-5 个小标题分段 + 例子支撑 + 金句结尾的长文；1200-2000 字。",
    expectedLen: "1200-2000 字",
  },
];

export default function OriginalPage() {
  const { token } = useAuth();
  const [platform, setPlatform] = useState<Platform>("xhs");
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [textModelId, setTextModelId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  const meta = useMemo(() => PLATFORMS.find((p) => p.key === platform)!, [platform]);

  const handleRewrite = async () => {
    const src = text.trim();
    if (src.length < 10) { toastErr("底稿太短，至少写 10 个字让 AI 有发挥余地"); return; }
    if (!token) return;
    setBusy(true); setResult("");
    try {
      const r = await fetch("/api/original/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          platform, source_text: src, extra_hint: hint.trim(),
          text_model_id: textModelId,
        }),
      });
      const d = await r.json();
      if (r.status === 402) { toastInsufficientCredits(d.detail); return; }
      if (!r.ok) { toastErr(d.detail || "改写失败"); return; }
      setResult(d.result || "");
      toastOk(`已改写完成（${d.result_length} 字）`);
    } catch (e: any) {
      toastErr(`改写异常：${e?.message || e}`);
    } finally { setBusy(false); }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      toastOk("已复制到剪贴板");
    } catch {
      toastErr("复制失败");
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="original"
        icon={PenLine}
        title="原创"
        hint="你写一段粗糙的底稿（一句话也行），AI 按目标平台的风格、节奏、句式重写成完整成品。每次扣 cross_rewrite 0.5 点。"
      />

      {/* 平台切换 */}
      <SectionCard>
        <Tabs
          selectedKey={platform}
          onSelectionChange={(k) => setPlatform(String(k) as Platform)}
          color="success"
          variant="solid"
          classNames={{ tabList: "bg-original-50 dark:bg-original-900/20" }}
        >
          {PLATFORMS.map((p) => (
            <Tab key={p.key} title={
              <span className="flex items-center gap-1.5">
                <span>{p.emoji}</span>
                <span>{p.label}</span>
              </span>
            } />
          ))}
        </Tabs>
        <div className="mt-3 p-3 rounded-md bg-default-50 dark:bg-default-100/30 border border-default-200/60">
          <p className="text-xs text-default-600">
            <span className="font-medium text-original-600 dark:text-original-500">{meta.emoji} {meta.label}风格：</span>
            {meta.tip}
          </p>
        </div>
      </SectionCard>

      {/* 输入 */}
      <SectionCard
        icon={FileText}
        title="你的底稿"
        hint="一句话、几段话都行；越具体 AI 改写得越准。"
        actions={
          <span className="text-xs text-default-400">{text.length} / 8000</span>
        }
      >
        <div className="space-y-3">
          <Textarea
            minRows={6} maxRows={20}
            value={text} onValueChange={setText}
            placeholder={meta.placeholder}
            classNames={{ input: "text-sm leading-relaxed" }}
          />
          <div className="flex flex-wrap gap-2 items-end">
            <Input
              label="额外要求（可选）" labelPlacement="outside" size="sm"
              className="flex-1 min-w-[260px]"
              placeholder="如：偏稳重 / 给宝妈群 / 突出性价比 / 结尾别留 CTA"
              value={hint} onValueChange={setHint}
            />
            <ModelSelector usage="text" value={textModelId} onChange={setTextModelId}
              label="文本模型" className="min-w-[220px]" />
          </div>
          <div className="flex items-center gap-2">
            <Button
              color="success" startContent={<Wand2 size={14} />}
              isLoading={busy} isDisabled={text.trim().length < 10}
              onPress={handleRewrite}
            >
              生成 {meta.label}风格成品
            </Button>
            {text && (
              <Button variant="light" size="sm" startContent={<RotateCcw size={13} />}
                onPress={() => { setText(""); setResult(""); setHint(""); }}>
                清空
              </Button>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-default-400">
              <Coins size={11} /> 扣 cross_rewrite 0.5 点 · 预期 {meta.expectedLen}
            </span>
          </div>
        </div>
      </SectionCard>

      {/* 结果 */}
      <SectionCard
        icon={Wand2}
        title={`${meta.label}风格成品`}
        actions={
          result ? (
            <Button size="sm" variant="flat" color="success"
              startContent={<Copy size={14} />} onPress={handleCopy}>
              复制
            </Button>
          ) : null
        }
      >
        {!result ? (
          <EmptyState
            icon={Wand2} compact
            title="还没生成成品"
            hint={busy ? "AI 正在写…" : "上方填好底稿点「生成」开始"}
          />
        ) : (
          <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans p-4 rounded-md bg-default-50 dark:bg-default-100/30 border border-default-200/60 max-h-[60vh] overflow-y-auto">
            {result}
          </pre>
        )}
      </SectionCard>
    </div>
  );
}
