"use client";

import { PlatformPlaceholder } from "@/components/PlatformPlaceholder";

export default function DouyinPage() {
  return (
    <PlatformPlaceholder
      name="抖音"
      intro="抖音视频监控与热门内容追踪。技术上跟小红书 90% 同源（Playwright + 签名拦截），优先级 P1。"
      capabilities={[
        { label: "分享链接（v.douyin.com）→ 视频详情、点赞/评论/分享数", status: "planned" },
        { label: "关键词搜索热门视频（X-Bogus 签名拦截）", status: "planned" },
        { label: "博主主页订阅追新", status: "planned" },
        { label: "评论内容拉取", status: "planned" },
      ]}
    />
  );
}
