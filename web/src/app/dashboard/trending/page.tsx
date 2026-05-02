"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 旧 URL 兼容 stub —— 已迁移到 /dashboard/xhs/trending/。
export default function Page() {
  const r = useRouter();
  useEffect(() => { r.replace("/dashboard/xhs/trending/"); }, [r]);
  return null;
}
