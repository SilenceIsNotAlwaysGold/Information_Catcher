"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Spinner } from "@nextui-org/spinner";
import { Menu, Search } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { PLATFORM_LABEL, type PlatformKey } from "@/components/platform";
import { GlobalSearch, useGlobalSearch } from "@/components/GlobalSearch";
import { usePosts, useAlerts, useAccounts, useGroups, useLives } from "@/lib/useApi";

// 预热最常用 SWR 缓存：布局挂载后立即拉取，子页面导航时数据已就绪，无需重新请求
function CachePrefetcher() {
  usePosts();
  useAlerts(30);
  useAccounts();
  useGroups();
  useLives();
  return null;
}

// 从当前路由推断顶部栏标题（仅移动端 topbar 使用）
function inferTopbarTitle(pathname: string): string {
  if (pathname === "/dashboard" || pathname === "/dashboard/") return "概览";
  const parts = pathname.split("/").filter(Boolean); // ["dashboard", "<seg>", ...]
  const seg = parts[1];
  if (!seg) return "TrendPulse";
  if (seg in PLATFORM_LABEL) return PLATFORM_LABEL[seg as PlatformKey];
  if (seg === "import") return "数据导入";
  if (seg === "monitor") return "设置";
  if (seg === "admin") return "管理员控制台";
  if (seg === "publish") return "发布";
  if (seg === "trending") return "热门内容";
  return "TrendPulse";
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isLoading } = useAuth();
  // 移动端 drawer 开关：状态在 layout，传给 Sidebar 与 topbar 汉堡按钮共享
  const [mobileOpen, setMobileOpen] = useState(false);
  // 全局 ⌘K 搜索（hook 内部已挂载 window keydown 监听）
  const { open: searchOpen, openSearch, closeSearch } = useGlobalSearch();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/login");
  }, [isAuthenticated, isLoading, router]);

  // 路由切换时强制关闭 drawer（兜底，链接点击已会调 onMobileClose）
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f9fafb]">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const title = inferTopbarTitle(pathname);

  return (
    <div className="flex min-h-screen bg-[#f9fafb]">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      {/* main area offset for sidebar width：移动端 0，md 16，lg 64 */}
      <main className="flex-1 ml-0 md:ml-16 lg:ml-64 min-h-screen overflow-y-auto">
        {/* 移动端 topbar：汉堡 + 当前页面标题 + 搜索图标；≥md 隐藏 */}
        <header className="md:hidden sticky top-0 z-30 h-14 flex items-center gap-3 px-4 bg-content1 border-b border-divider">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="p-1 -ml-1 rounded hover:bg-default-100 text-default-600"
            aria-label="打开菜单"
          >
            <Menu size={22} />
          </button>
          <span className="font-semibold text-foreground truncate flex-1">{title}</span>
          <button
            type="button"
            onClick={openSearch}
            className="p-1.5 rounded hover:bg-default-100 text-default-600"
            aria-label="全局搜索"
          >
            <Search size={20} />
          </button>
        </header>

        {/* 桌面端顶栏：右侧搜索按钮（含 ⌘K 提示徽章），<md 隐藏 */}
        <header className="hidden md:flex sticky top-0 z-30 h-12 items-center justify-end px-6 bg-content1/80 backdrop-blur border-b border-divider">
          <button
            type="button"
            onClick={openSearch}
            className="inline-flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-md border border-divider bg-default-50 hover:bg-default-100 text-default-500 text-sm transition-colors min-w-[220px]"
            aria-label="全局搜索"
          >
            <Search size={15} />
            <span className="flex-1 text-left">搜索帖子、作者、直播间…</span>
            <span className="ml-2 text-xs">
              <kbd className="px-1.5 py-0.5 rounded bg-default-100 text-default-600 border border-divider">
                ⌘K
              </kbd>
            </span>
          </button>
        </header>

          {children}
      </main>

      {/* 全局搜索弹窗，受控显示 */}
      <GlobalSearch open={searchOpen} onClose={closeSearch} />
      {/* 预热常用数据缓存，无 UI 输出 */}
      <CachePrefetcher />
    </div>
  );
}
