"use client";

/**
 * StatTile — 单个关键指标小卡。
 *
 *   ┌────────────────────────────┐
 *   │ [icon]  标签                │
 *   │   数值（大）  ↑ 12.5%       │
 *   │   小副标 / hint              │
 *   └────────────────────────────┘
 *
 * 用在 dashboard 概览、各板块二级首页。点击可跳转。
 */
import Link from "next/link";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SectionKey } from "@/lib/sections";

type Props = {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  /** trend：+12.5% / -3% / 0 */
  trend?: { value: number; unit?: string };
  hint?: string;
  /** 板块语义色，决定 icon 背景 */
  section?: SectionKey;
  /** 点击跳到哪 */
  href?: string;
};

const ICON_BG: Record<SectionKey | "neutral", string> = {
  monitor:  "bg-monitor-100  text-monitor-600  dark:bg-monitor-900/40  dark:text-monitor-500",
  studio:   "bg-studio-100   text-studio-600   dark:bg-studio-900/40   dark:text-studio-500",
  original: "bg-original-100 text-original-600 dark:bg-original-900/40 dark:text-original-500",
  remix:    "bg-remix-100    text-remix-600    dark:bg-remix-900/40    dark:text-remix-500",
  toolbox:  "bg-toolbox-100  text-toolbox-600  dark:bg-toolbox-900/40  dark:text-toolbox-500",
  hotnews:  "bg-hotnews-100  text-hotnews-600  dark:bg-hotnews-900/40  dark:text-hotnews-500",
  neutral:  "bg-default-100  text-default-600  dark:bg-default-200/30  dark:text-default-500",
};

export function StatTile({ label, value, icon: Icon, trend, hint, section, href }: Props) {
  const TrendIcon = !trend ? null : trend.value > 0 ? TrendingUp : trend.value < 0 ? TrendingDown : Minus;
  const trendColor = !trend ? "" : trend.value > 0 ? "text-success-600" : trend.value < 0 ? "text-danger-600" : "text-default-400";
  const tone = section || "neutral";

  const body = (
    <div className={`group rounded-xl border border-default-200/60 bg-content1 p-4 shadow-card hover:shadow-card-hover transition-all ${href ? "hover:-translate-y-0.5 cursor-pointer" : ""}`}>
      <div className="flex items-center gap-2 mb-2">
        {Icon && (
          <div className={`rounded-md p-1.5 ${ICON_BG[tone]}`}>
            <Icon size={14} />
          </div>
        )}
        <span className="text-xs font-medium text-default-600 uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-display-sm tabular-nums text-foreground">{value}</span>
        {trend && TrendIcon && (
          <span className={`inline-flex items-center text-xs font-medium gap-0.5 ${trendColor}`}>
            <TrendIcon size={12} />
            {trend.value > 0 ? "+" : ""}{trend.value}{trend.unit || "%"}
          </span>
        )}
      </div>
      {hint && <p className="text-xs text-default-500 mt-1">{hint}</p>}
    </div>
  );

  return href ? <Link href={href}>{body}</Link> : body;
}
