"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard, Activity, Upload, Settings, LogOut, TrendingUp,
  ShieldCheck, Music2, Newspaper,
} from "lucide-react";
import { Button, Tooltip, Chip } from "@nextui-org/react";
import { useI18n } from "@/contexts/I18nContext";
import { useAuth } from "@/contexts/AuthContext";
import type { ReactNode } from "react";

type NavItem = {
  key: string;
  href: string;
  icon: ReactNode;
  label: string;
  /** 模块 id：同模块的项视觉上聚合（同色块、缩进） */
  module?: "xhs" | "douyin" | "mp" | "common";
  /** 占位（开发中），仍可点但页面会显示「开发中」 */
  wip?: boolean;
};

const xhsIcon = <span className="text-xl leading-none">🌸</span>;

const baseNavItems: NavItem[] = [
  { key: "dashboard", href: "/dashboard",                   icon: <LayoutDashboard size={20} />, label: "概览",       module: "common" },

  // 小红书模块（已实现）
  { key: "xhs-monitor",  href: "/dashboard/monitor",        icon: xhsIcon,                        label: "帖子监控", module: "xhs" },
  { key: "xhs-trending", href: "/dashboard/trending",       icon: <TrendingUp size={18} />,       label: "热门内容", module: "xhs" },

  // 抖音模块（开发中）
  { key: "douyin",   href: "/dashboard/douyin",             icon: <Music2 size={20} />,           label: "抖音",     module: "douyin", wip: true },

  // 公众号模块（开发中）
  { key: "mp",       href: "/dashboard/mp",                 icon: <Newspaper size={20} />,        label: "公众号",   module: "mp",     wip: true },

  // 通用工具
  { key: "import",   href: "/dashboard/import",             icon: <Upload size={20} />,           label: "数据导入", module: "common" },
  { key: "settings", href: "/dashboard/monitor/settings",   icon: <Settings size={20} />,         label: "设置",     module: "common" },
];

const adminNavItem: NavItem = {
  key: "admin", href: "/dashboard/admin", icon: <ShieldCheck size={20} />, label: "管理员", module: "common",
};

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const { logout, user } = useAuth();
  const navItems = user?.role === "admin" ? [...baseNavItems, adminNavItem] : baseNavItems;

  // 找最长前缀匹配作为 active
  const candidates = navItems
    .filter((it) => it.href === "/dashboard" ? pathname === "/dashboard" : pathname === it.href || pathname.startsWith(it.href + "/"))
    .sort((a, b) => b.href.length - a.href.length);
  const activeKey = candidates[0]?.key;

  // 按 module 分桶但保持原序
  const blocks: { module: NavItem["module"]; items: NavItem[] }[] = [];
  for (const it of navItems) {
    const last = blocks[blocks.length - 1];
    if (last && last.module === it.module) last.items.push(it);
    else blocks.push({ module: it.module, items: [it] });
  }

  const moduleLabel = (m?: NavItem["module"]) => {
    if (m === "xhs") return "小红书";
    if (m === "douyin") return "抖音";
    if (m === "mp") return "公众号";
    return "";
  };

  return (
    <aside className="fixed left-0 top-0 h-screen w-16 lg:w-56 bg-content1 border-r border-divider flex flex-col z-40">
      <div className="h-16 flex items-center justify-center lg:justify-start px-4 border-b border-divider gap-2">
        <span className="text-2xl">🪐</span>
        <span className="hidden lg:block font-bold text-base text-foreground">Pulse</span>
      </div>

      <nav className="flex-1 py-3 overflow-y-auto">
        <ul className="space-y-1 px-2">
          {blocks.map((blk, bi) => (
            <div key={bi} className="mb-2">
              {/* 平台模块的 group label */}
              {(blk.module === "xhs" || blk.module === "douyin" || blk.module === "mp") && (
                <div className="hidden lg:flex items-center gap-1 px-3 pt-2 pb-1">
                  <span className="text-[10px] font-semibold text-default-400 uppercase tracking-wide">
                    {moduleLabel(blk.module)}
                  </span>
                  {blk.items[0]?.wip && (
                    <Chip size="sm" variant="flat" color="default" className="h-4 px-1 text-[10px]">
                      开发中
                    </Chip>
                  )}
                </div>
              )}
              {blk.items.map((item) => {
                const isActive = item.key === activeKey;
                const indent = (blk.module === "xhs" || blk.module === "douyin" || blk.module === "mp")
                  ? "lg:ml-2" : "";
                return (
                  <li key={item.key}>
                    <Tooltip
                      content={item.wip ? `${item.label}（开发中）` : item.label}
                      placement="right" className="lg:hidden"
                    >
                      <Link href={item.href}>
                        <div className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${indent}
                          ${isActive ? "bg-primary text-primary-foreground"
                                     : item.wip ? "text-default-400 hover:bg-default-100"
                                                : "text-default-600 hover:bg-default-100"}`}>
                          {item.icon}
                          <span className="hidden lg:block text-sm font-medium flex-1">
                            {item.label}
                          </span>
                        </div>
                      </Link>
                    </Tooltip>
                  </li>
                );
              })}
            </div>
          ))}
        </ul>
      </nav>

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
