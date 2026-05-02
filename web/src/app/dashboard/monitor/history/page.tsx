"use client";
import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 旧 URL 兼容 stub —— 已迁移到 /dashboard/xhs/posts/history/。
function RedirectInner() {
  const r = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const qs = params.toString();
    r.replace(`/dashboard/xhs/posts/history/${qs ? `?${qs}` : ""}`);
  }, [r, params]);
  return null;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <RedirectInner />
    </Suspense>
  );
}
