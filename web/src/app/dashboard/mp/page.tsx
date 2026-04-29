"use client";

import { PlatformPlaceholder } from "@/components/PlatformPlaceholder";

export default function MpPage() {
  return (
    <PlatformPlaceholder
      name="公众号"
      intro="公众号文章监控。受平台开放程度限制，v1 走「URL 喂入 + 趋势监控」模式，不做博主级订阅追新。"
      capabilities={[
        { label: "粘贴文章 URL 抓取标题/作者/正文/配图（匿名可达）", status: "planned" },
        { label: "AI 摘要（300 字以内）", status: "planned" },
        { label: "阅读数 / 在看数 / 点赞数 趋势监控（需用户提供 cookie+key）", status: "planned" },
        { label: "博主级订阅追新（无可靠通道，不做）", status: "planned" },
        { label: "评论数据（第三方不可达，不做）", status: "planned" },
      ]}
    />
  );
}
