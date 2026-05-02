"use client";

import Link from "next/link";
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
