"use client";

/**
 * EmptyState — 列表/卡片空状态统一组件。
 *
 *      ┌──────────────────────────────────┐
 *      │              [icon]               │
 *      │            标题文本               │
 *      │       hint 一句话引导            │
 *      │           [操作按钮]              │
 *      └──────────────────────────────────┘
 *
 * 区别于已有的 components/EmptyState.tsx（业务页用过），这里是新版"宽松、暗色友好"版。
 * 暂时与旧版并存；阶段 5 适配时统一切到本版。
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type Props = {
  icon?: LucideIcon;
  title: string;
  hint?: ReactNode;
  /** CTA 按钮 / 操作组 */
  action?: ReactNode;
  /** 紧凑模式（用在小卡片里） */
  compact?: boolean;
};

export function EmptyState({ icon: Icon, title, hint, action, compact = false }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? "py-6 px-3" : "py-10 px-4"}`}>
      {Icon && (
        <div className={`rounded-full bg-default-100 dark:bg-default-200/30 ${compact ? "p-2.5 mb-2" : "p-4 mb-3"}`}>
          <Icon size={compact ? 18 : 28} className="text-default-500" />
        </div>
      )}
      <p className={`font-medium text-foreground ${compact ? "text-sm" : "text-base"}`}>{title}</p>
      {hint && (
        <p className={`text-default-500 mt-1 max-w-md ${compact ? "text-xs" : "text-sm"}`}>{hint}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
