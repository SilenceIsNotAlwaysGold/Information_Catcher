"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Spinner } from "@nextui-org/spinner";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { GlobalSearch, useGlobalSearch } from "@/components/GlobalSearch";
import { usePosts, useAlerts, useAccounts, useGroups } from "@/lib/useApi";

// 预热最常用 SWR 缓存：子页面导航时数据已就绪
function CachePrefetcher() {
  usePosts();
  useAlerts(30);
  useAccounts();
  useGroups();
  return null;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isLoading } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { open: searchOpen, openSearch, closeSearch } = useGlobalSearch();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isAuthenticated, isLoading, router]);

  // 路由变化时自动关闭移动 drawer
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }
  if (!isAuthenticated) return null;

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <main className="flex-1 ml-0 md:ml-64 min-h-screen flex flex-col">
        <TopBar
          onMobileMenu={() => setMobileOpen(true)}
          onOpenSearch={openSearch}
        />
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </main>
      <GlobalSearch open={searchOpen} onClose={closeSearch} />
      <CachePrefetcher />
    </div>
  );
}
