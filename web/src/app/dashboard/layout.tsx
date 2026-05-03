"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Spinner } from "@nextui-org/spinner";
import { Menu } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { PLATFORM_LABEL, type PlatformKey } from "@/components/platform";

// 从当前路由推断顶部栏标题（仅移动端 topbar 使用）
function inferTopbarTitle(pathname: string): string {
  if (pathname === "/dashboard" || pathname === "/dashboard/") return "概览";
  const parts = pathname.split("/").filter(Boolean); // ["dashboard", "<seg>", ...]
  const seg = parts[1];
  if (!seg) return "Pulse";
  if (seg in PLATFORM_LABEL) return PLATFORM_LABEL[seg as PlatformKey];
  if (seg === "import") return "数据导入";
  if (seg === "monitor") return "设置";
  if (seg === "admin") return "管理员控制台";
  if (seg === "publish") return "发布";
  if (seg === "trending") return "热门内容";
  return "Pulse";
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isLoading } = useAuth();
  // 移动端 drawer 开关：状态在 layout，传给 Sidebar 与 topbar 汉堡按钮共享
  const [mobileOpen, setMobileOpen] = useState(false);

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
      {/* main area offset for sidebar width：移动端 0，md 16，lg 56 */}
      <main className="flex-1 ml-0 md:ml-16 lg:ml-56 min-h-screen overflow-y-auto">
        {/* 移动端 topbar：汉堡 + 当前页面标题；≥md 隐藏 */}
        <header className="md:hidden sticky top-0 z-30 h-14 flex items-center gap-3 px-4 bg-content1 border-b border-divider">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="p-1 -ml-1 rounded hover:bg-default-100 text-default-600"
            aria-label="打开菜单"
          >
            <Menu size={22} />
          </button>
          <span className="font-semibold text-foreground truncate">{title}</span>
        </header>
        {children}
      </main>
    </div>
  );
}
