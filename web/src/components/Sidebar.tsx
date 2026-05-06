"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard, Upload, Settings, LogOut, TrendingUp,
  ShieldCheck, Music2, Newspaper, ChevronDown, ChevronRight,
  FileText, Users, Moon, Sun, X,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import { Chip } from "@nextui-org/chip";
import { useTheme } from "next-themes";
import { useI18n } from "@/contexts/I18nContext";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect, useState, type ReactNode } from "react";
import {
  PLATFORM_SECTIONS, SECTION_LABEL,
  type PlatformKey, type SectionKey,
} from "@/components/platform";

type ModuleId = "common" | "xhs" | "douyin" | "mp";

type NavItem = {
  key: string;
  href: string;
  icon: ReactNode;
  label: string;
  module: ModuleId;
  wip?: boolean;
};

const xhsIcon = <span className="text-xl leading-none">🌸</span>;

// 子项 icon：根据 section 类型选择
const sectionIcon = (section: SectionKey): ReactNode => {
  if (section === "posts") return <FileText size={16} />;
  if (section === "trending") return <TrendingUp size={16} />;
  return <Users size={16} />; // creators
};

// 平台分组的"标题图标"（折叠显示用）
const platformGroupIcon: Record<PlatformKey, ReactNode> = {
  xhs: xhsIcon,
  douyin: <Music2 size={20} />,
  mp: <Newspaper size={20} />,
};

const platformLabel: Record<PlatformKey, string> = {
  xhs: "小红书",
  douyin: "抖音",
  mp: "公众号",
};

// 用 PLATFORM_SECTIONS 自动生成每个平台的子项
const buildPlatformItems = (platform: PlatformKey): NavItem[] =>
  PLATFORM_SECTIONS[platform].map((section) => ({
    key: `${platform}-${section}`,
    href: `/dashboard/${platform}/${section}/`,
    icon: sectionIcon(section),
    label: SECTION_LABEL[section],
    module: platform,
  }));

const baseNavItems: NavItem[] = [
  { key: "dashboard", href: "/dashboard", icon: <LayoutDashboard size={20} />, label: "概览", module: "common" },

  ...buildPlatformItems("xhs"),
  ...buildPlatformItems("douyin"),
  ...buildPlatformItems("mp"),

  { key: "import",      href: "/dashboard/import",                icon: <Upload size={20} />,    label: "数据导入",   module: "common" },
  { key: "tools-image", href: "/dashboard/tools/product-image",   icon: <ImageIcon size={20} />, label: "商品图工具", module: "common" },
  { key: "settings",    href: "/dashboard/monitor/settings",      icon: <Settings size={20} />,  label: "设置",       module: "common" },
];

const adminNavItem: NavItem = {
  key: "admin", href: "/dashboard/admin", icon: <ShieldCheck size={20} />, label: "管理员控制台", module: "common",
};

const COLLAPSE_KEY = "sidebar.collapsed.modules";

export type SidebarProps = {
  /** 移动端 drawer 是否打开（仅在 <md 生效） */
  mobileOpen?: boolean;
  /** 关闭 drawer 的回调（点击遮罩 / 链接 / 关闭按钮触发） */
  onMobileClose?: () => void;
};

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps = {}) {
  const pathname = usePathname();
  const { t } = useI18n();
  const { logout, user } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const navItems = user?.role === "admin" ? [...baseNavItems, adminNavItem] : baseNavItems;

  // 折叠状态：{ [module]: true } 表示折叠
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) setCollapsed(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  const toggle = (m: ModuleId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [m]: !prev[m] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // 最长前缀匹配 active：精确匹配 href 或 href + "/"
  const candidates = navItems
    .filter((it) => it.href === "/dashboard"
      ? pathname === "/dashboard" || pathname === "/dashboard/"
      : pathname === it.href
        || pathname === it.href.replace(/\/$/, "")
        || pathname.startsWith(it.href))
    .sort((a, b) => b.href.length - a.href.length);
  const activeKey = candidates[0]?.key;

  // 按 module 分桶但保留原序
  const blocks: { module: ModuleId; items: NavItem[] }[] = [];
  for (const it of navItems) {
    const last = blocks[blocks.length - 1];
    if (last && last.module === it.module) last.items.push(it);
    else blocks.push({ module: it.module, items: [it] });
  }

  return (
    <>
      {/* 移动端遮罩：仅在 <md 且 drawer 打开时显示 */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-black/50 transition-opacity duration-200
          ${mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside
        className={`fixed left-0 top-0 h-screen w-64 md:w-16 lg:w-64 bg-content1 border-r border-divider flex flex-col z-50
          transition-transform duration-200 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0`}
      >
      <div className="h-16 flex items-center justify-between md:justify-center lg:justify-start px-4 border-b border-divider gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🪐</span>
          <span className="hidden max-md:block lg:block font-bold text-base text-foreground">Pulse</span>
        </div>
        {/* 移动端 drawer 关闭按钮 */}
        <button
          type="button"
          onClick={onMobileClose}
          className="md:hidden p-1 rounded hover:bg-default-100 text-default-500"
          aria-label="关闭菜单"
        >
          <X size={20} />
        </button>
      </div>

      <nav className="flex-1 py-3 overflow-y-auto">
        <ul className="space-y-1 px-2">
          {blocks.map((blk, bi) => {
            const isPlatformGroup = blk.module === "xhs" || blk.module === "douyin" || blk.module === "mp";
            // 完全由用户控制；折叠后即使当前 active 在该组也收起，仅靠 chevron 视觉反馈
            const isOpen = !isPlatformGroup || !collapsed[blk.module];
            const platform = blk.module as PlatformKey;
            return (
              <div key={bi} className="mb-1">
                {isPlatformGroup && (
                  <button
                    type="button"
                    onClick={() => toggle(blk.module)}
                    className="hidden max-md:flex lg:flex w-full items-center gap-2 px-3 pt-2 pb-1 text-left
                               hover:bg-default-100 rounded transition-colors"
                  >
                    {isOpen
                      ? <ChevronDown size={12} className="text-default-400" />
                      : <ChevronRight size={12} className="text-default-400" />}
                    <span className="shrink-0 scale-75 origin-left">
                      {platformGroupIcon[platform]}
                    </span>
                    <span className="text-[10px] font-semibold text-default-400 uppercase tracking-wider">
                      {platformLabel[platform]}
                    </span>
                    {blk.items[0]?.wip && (
                      <Chip size="sm" variant="flat" color="default" className="h-4 px-1 text-[10px] ml-1">
                        开发中
                      </Chip>
                    )}
                  </button>
                )}
                {/* 子项：折叠时仅在 lg 屏隐藏；移动端 drawer 内（max-md）按宽态显示 */}
                <div className={isOpen ? "" : "max-md:hidden hidden lg:hidden"}>
                  {blk.items.map((item) => {
                    const isActive = item.key === activeKey;
                    const indent = isPlatformGroup ? "max-md:ml-4 lg:ml-4" : "";
                    return (
                      <li key={item.key}>
                        <Tooltip
                          content={item.wip ? `${item.label}（开发中）` : item.label}
                          placement="right" className="lg:hidden"
                        >
                          <Link href={item.href} onClick={onMobileClose}>
                            <div className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${indent}
                              ${isActive ? "bg-primary text-primary-foreground"
                                         : item.wip ? "text-default-400 hover:bg-default-100"
                                                    : "text-default-600 hover:bg-default-100"}`}>
                              {/* 平台子项在窄屏显示平台 icon，宽屏（含移动端 drawer）显示 section icon */}
                              {isPlatformGroup ? (
                                <>
                                  <span className="max-md:hidden lg:hidden">{platformGroupIcon[platform]}</span>
                                  <span className="hidden max-md:block lg:block">{item.icon}</span>
                                </>
                              ) : item.icon}
                              <span className="hidden max-md:block lg:block text-sm font-medium flex-1">
                                {item.label}
                              </span>
                            </div>
                          </Link>
                        </Tooltip>
                      </li>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-divider p-3 space-y-2">
        <div className="hidden max-md:flex lg:flex items-center gap-2 mb-1 px-1">
          <span className="text-sm text-default-500 truncate">{user?.username}</span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content={t("common.logout")} placement="right">
            <Button isIconOnly variant="light" className="w-full max-md:w-auto lg:w-auto" onClick={logout}>
              <LogOut size={18} />
              <span className="hidden max-md:inline lg:inline ml-2 text-sm">{t("common.logout")}</span>
            </Button>
          </Tooltip>
          <Tooltip
            content={mounted && theme === "dark" ? "切到浅色" : "切到暗色"}
            placement="right"
          >
            <Button
              isIconOnly
              variant="light"
              aria-label="切换主题"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {mounted && theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
          </Tooltip>
        </div>
      </div>
    </aside>
    </>
  );
}
