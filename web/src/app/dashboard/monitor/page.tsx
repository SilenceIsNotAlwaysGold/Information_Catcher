"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 旧 URL 兼容 stub —— 整个监控页面已迁移到 /dashboard/xhs/posts/。
export default function Page() {
  const r = useRouter();
  useEffect(() => { r.replace("/dashboard/xhs/posts/"); }, [r]);
  return null;
}
