"use client";

import Link from "next/link";
import { Radar } from "lucide-react";
import {
  PlatformKey, SectionKey, PLATFORM_LABEL, SECTION_LABEL, PLATFORM_SECTIONS,
} from "./types";

/**
 * 平台子模块顶部导航条。每个平台（xhs/douyin/mp）下显示三个并列子模块入口。
 * 点击切换到对应路由 /dashboard/{platform}/{section}/。
 *
 * 用原生 Link + Tailwind 实现，替代 NextUI Tabs：
 * - 避免 framer-motion 在每次平台页 mount 时的滑块动画初始化
 * - 让 next/link 的 prefetch 直接预热目标 chunk，切换更顺滑
 */
export function PlatformSubNav({
  platform, current,
}: {
  platform: PlatformKey;
  current: SectionKey;
}) {
  const sections = PLATFORM_SECTIONS[platform];

  return (
    <div className="flex items-center gap-3 mb-5 flex-wrap">
      {/* monitor 板块色图标块：与 v2 PageHeader 同款视觉语言，让平台监控页
          和 AI 工坊/工具箱等新板块页风格统一（升级这一个共享组件即可，
          无需逐个改 16 个平台页） */}
      <div className="shrink-0 rounded-xl p-2.5 bg-monitor-100 text-monitor-600 dark:bg-monitor-900/30 dark:text-monitor-500">
        <Radar size={20} strokeWidth={2} />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight whitespace-nowrap">
        {PLATFORM_LABEL[platform]}
      </h1>
      <nav
        aria-label={`${platform}-sections`}
        className="inline-flex items-center bg-default-100 rounded-medium p-1 gap-1"
      >
        {sections.map((s) => {
          const isActive = s === current;
          return (
            <Link
              key={s}
              href={`/dashboard/${platform}/${s}/`}
              prefetch
              className={`px-3 py-1 rounded-small text-sm font-medium transition-colors ${
                isActive
                  ? "bg-content1 text-foreground shadow-small"
                  : "text-default-500 hover:text-foreground"
              }`}
            >
              {SECTION_LABEL[s]}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
