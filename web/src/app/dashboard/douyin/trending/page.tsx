"use client";

import { PlatformSubNav } from "@/components/platform";
import { PlatformPlaceholder } from "@/components/PlatformPlaceholder";

export default function DouyinTrendingPage() {
  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <PlatformSubNav platform="douyin" current="trending" />

      <PlatformPlaceholder feature="抖音热门" issue="" />

      <p className="text-xs text-default-500 leading-relaxed max-w-2xl">
        抖音热门搜索已可用（后端 <code>search_trending</code>），需要先在管理员页配置抖音账号 cookie。
        结果会自动按平台路由展示。
      </p>
    </div>
  );
}
