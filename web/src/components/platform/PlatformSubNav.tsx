"use client";

import { Tabs, Tab } from "@nextui-org/react";
import { useRouter } from "next/navigation";
import {
  PlatformKey, SectionKey, PLATFORM_LABEL, SECTION_LABEL, PLATFORM_SECTIONS,
} from "./types";

/**
 * 平台子模块顶部导航条。每个平台（xhs/douyin/mp）下显示三个并列子模块入口。
 * 点击切换到对应路由 /dashboard/{platform}/{section}/。
 */
export function PlatformSubNav({
  platform, current,
}: {
  platform: PlatformKey;
  current: SectionKey;
}) {
  const router = useRouter();
  const sections = PLATFORM_SECTIONS[platform];

  return (
    <div className="flex items-center gap-3 mb-4">
      <h1 className="text-xl font-semibold whitespace-nowrap">
        {PLATFORM_LABEL[platform]}
      </h1>
      <Tabs
        size="sm"
        selectedKey={current}
        onSelectionChange={(k) => {
          const key = k as SectionKey;
          router.push(`/dashboard/${platform}/${key}/`);
        }}
        aria-label={`${platform}-sections`}
      >
        {sections.map((s) => (
          <Tab key={s} title={SECTION_LABEL[s]} />
        ))}
      </Tabs>
    </div>
  );
}
