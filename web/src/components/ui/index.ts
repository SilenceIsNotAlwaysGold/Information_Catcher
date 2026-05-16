/**
 * 核心 UI 组件统一出口。
 *
 * 用法：
 *   import { PageHeader, SectionCard, StatTile, EmptyState, MetricBar, DataTable } from "@/components/ui";
 *
 * 设计原则：
 *   - 所有组件暗色友好（用 dark:xxx 修饰）
 *   - 板块语义色由 section prop 传入（monitor/studio/remix/toolbox/hotnews），见 lib/sections.ts
 *   - 不再增加新的颜色系统；用 Tailwind 已配的语义色 + NextUI 主题色
 */
export { PageHeader, BetaBadge, WipBadge } from "./PageHeader";
export { SectionCard } from "./SectionCard";
export { StatTile } from "./StatTile";
export { EmptyState } from "./EmptyState";
export { MetricBar } from "./MetricBar";
export { DataTable, type Column } from "./DataTable";
