"use client";

/**
 * PageHeader — 每个页面顶部的统一标题区。
 *
 * 视觉：
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ [icon] 标题                                          [actions →] │
 *   │        副标题 / 一句话说明                                        │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   <PageHeader
 *     section="studio"
 *     icon={Presentation}
 *     title="AI PPT"
 *     hint="主题 → AI 生大纲 → python-pptx 渲染 .pptx"
 *     actions={<Button>新建</Button>}
 *   />
 */
import type { LucideIcon } from "lucide-react";
import type { SectionKey } from "@/lib/sections";
import { Chip } from "@nextui-org/chip";
import type { ReactNode } from "react";

type Props = {
  /** 当前页所属板块（决定 icon 背景色） */
  section?: SectionKey;
  /** 标题前面的大图标 */
  icon?: LucideIcon;
  title: string;
  /** 一句话副标题（说清楚这页是做啥的） */
  hint?: string;
  /** 标题旁边的小标签，比如 Beta / WIP */
  badge?: ReactNode;
  /** 右上角按钮组 */
  actions?: ReactNode;
};

const ICON_BG: Record<SectionKey | "neutral", string> = {
  monitor:  "bg-monitor-100  text-monitor-600  dark:bg-monitor-900/30  dark:text-monitor-500",
  studio:   "bg-studio-100   text-studio-600   dark:bg-studio-900/30   dark:text-studio-500",
  original: "bg-original-100 text-original-600 dark:bg-original-900/30 dark:text-original-500",
  remix:    "bg-remix-100    text-remix-600    dark:bg-remix-900/30    dark:text-remix-500",
  toolbox:  "bg-toolbox-100  text-toolbox-600  dark:bg-toolbox-900/30  dark:text-toolbox-500",
  hotnews:  "bg-hotnews-100  text-hotnews-600  dark:bg-hotnews-900/30  dark:text-hotnews-500",
  neutral:  "bg-primary-100  text-primary-600  dark:bg-primary-900/30  dark:text-primary-400",
};

export function PageHeader({ section, icon: Icon, title, hint, badge, actions }: Props) {
  const tone = section || "neutral";
  return (
    <header className="flex items-start gap-4 mb-6">
      {Icon && (
        <div className={`shrink-0 rounded-xl p-3 ${ICON_BG[tone]}`}>
          <Icon size={22} strokeWidth={2} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-display-sm text-foreground truncate">{title}</h1>
          {badge && <span>{badge}</span>}
        </div>
        {hint && (
          <p className="text-sm text-default-500 mt-1 max-w-2xl">{hint}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

/** 便捷标签：用作 `badge` 参数 */
export function BetaBadge() {
  return <Chip size="sm" variant="flat" color="secondary">Beta</Chip>;
}
export function WipBadge() {
  return <Chip size="sm" variant="flat" color="warning">开发中</Chip>;
}
