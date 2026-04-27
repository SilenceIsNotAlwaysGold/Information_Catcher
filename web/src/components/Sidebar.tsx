"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { LayoutDashboard, Activity, Upload, Settings, LogOut, TrendingUp } from "lucide-react";
import { Button, Tooltip } from "@nextui-org/react";
import { useI18n } from "@/contexts/I18nContext";
import { useAuth } from "@/contexts/AuthContext";

const navItems = [
  { key: "dashboard", href: "/dashboard",                   icon: <LayoutDashboard size={22} />, label: "概览" },
  { key: "monitor",   href: "/dashboard/monitor",           icon: <Activity size={22} />,        label: "帖子监控" },
  { key: "trending",  href: "/dashboard/trending",          icon: <TrendingUp size={22} />,      label: "热门内容" },
  { key: "import",    href: "/dashboard/import",            icon: <Upload size={22} />,          label: "数据导入" },
  { key: "settings",  href: "/dashboard/monitor/settings",  icon: <Settings size={22} />,        label: "设置" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const { logout, user } = useAuth();

  return (
    <aside className="fixed left-0 top-0 h-screen w-16 lg:w-56 bg-content1 border-r border-divider flex flex-col z-40">
      {/* Logo */}
      <div className="h-16 flex items-center justify-center lg:justify-start px-4 border-b border-divider gap-2">
        <span className="text-2xl">🌸</span>
        <span className="hidden lg:block font-bold text-base text-foreground">小红书监控</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4">
        <ul className="space-y-1 px-2">
          {navItems.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
            return (
              <li key={item.key}>
                <Tooltip content={item.label} placement="right" className="lg:hidden">
                  <Link href={item.href}>
                    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors
                      ${isActive ? "bg-primary text-primary-foreground" : "hover:bg-default-100 text-default-600"}`}>
                      {item.icon}
                      <span className="hidden lg:block text-sm font-medium">
                        {item.label}
                      </span>
                    </div>
                  </Link>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User */}
      <div className="border-t border-divider p-3">
        <div className="hidden lg:flex items-center gap-2 mb-2 px-1">
          <span className="text-sm text-default-500 truncate">{user?.username}</span>
        </div>
        <Tooltip content={t("common.logout")} placement="right">
          <Button isIconOnly variant="light" className="w-full lg:w-auto" onClick={logout}>
            <LogOut size={18} />
            <span className="hidden lg:inline ml-2 text-sm">{t("common.logout")}</span>
          </Button>
        </Tooltip>
      </div>
    </aside>
  );
}
