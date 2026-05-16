"use client";

/**
 * MetricBar — 横向小进度条族，用于显示分布、配额。
 *
 *  小红书   ▓▓▓▓▓▓▓▓░░░░░  60% (24)
 *  抖音    ▓▓▓▓░░░░░░░░░  25% (10)
 *  公众号  ▓▓░░░░░░░░░░░  10% (4)
 *
 * total 给出 → 自动算 pct。或者直接传 pct。
 */
import type { SectionKey } from "@/lib/sections";

type Item = {
  label: string;
  value: number;
  /** 板块语义色（决定条的颜色） */
  section?: SectionKey;
  /** 显式百分比（不传则按 sum 算） */
  pct?: number;
};

type Props = {
  items: Item[];
  /** 总数；不传则取 items.value 之和 */
  total?: number;
  /** 显示数值后缀 */
  unit?: string;
};

const BAR_FILL: Record<SectionKey | "neutral", string> = {
  monitor:  "bg-monitor-500",
  studio:   "bg-studio-500",
  original: "bg-original-500",
  remix:    "bg-remix-500",
  toolbox:  "bg-toolbox-500",
  hotnews:  "bg-hotnews-500",
  neutral:  "bg-primary-500",
};

export function MetricBar({ items, total, unit = "" }: Props) {
  const sum = total ?? items.reduce((a, x) => a + x.value, 0);
  return (
    <ul className="space-y-3">
      {items.map((it, i) => {
        const pct = it.pct !== undefined ? it.pct : (sum > 0 ? Math.round((it.value / sum) * 100) : 0);
        const tone = it.section || "neutral";
        return (
          <li key={i} className="text-sm">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-default-700">{it.label}</span>
              <span className="text-default-500 tabular-nums">
                <span className="text-foreground font-medium">{it.value}</span>
                {unit && <span className="ml-0.5">{unit}</span>}
                <span className="ml-2 text-xs">{pct}%</span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-default-100 dark:bg-default-200/30 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${BAR_FILL[tone]}`}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
