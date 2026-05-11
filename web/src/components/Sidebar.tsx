"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard, Upload, Settings, LogOut, TrendingUp,
  ShieldCheck, Music2, Newspaper, ChevronDown, ChevronRight,
  FileText, Users, Moon, Sun, X, Sparkles, Link2, SlidersHorizontal, Server,
  Image as ImageIcon, Wand2, Ticket, History as HistoryIcon, Puzzle, Wrench,
} from "lucide-react";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import { Chip } from "@nextui-org/chip";
import { useTheme } from "next-themes";
import { useI18n } from "@/contexts/I18nContext";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PLATFORM_SECTIONS, SECTION_LABEL,
  type PlatformKey, type SectionKey,
} from "@/components/platform";

type ModuleId = "common" | "xhs" | "douyin" | "mp" | "tools" | "admin";

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

// 可折叠组的"标题图标 + 标签"。common 不在此处。
const GROUP_ICON: Record<Exclude<ModuleId, "common">, ReactNode> = {
  xhs: xhsIcon,
  douyin: <Music2 size={20} />,
  mp: <Newspaper size={20} />,
  tools: <Wrench size={20} />,
  admin: <ShieldCheck size={20} />,
};

const GROUP_LABEL: Record<Exclude<ModuleId, "common">, string> = {
  xhs: "小红书",
  douyin: "抖音",
  mp: "公众号",
  tools: "工具",
  admin: "管理员",
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

  { key: "import",      href: "/dashboard/import",                icon: <Upload size={20} />,    label: "数据导入", module: "common" },

  // 工具组（默认折叠）
  { key: "tools-image",      href: "/dashboard/tools/product-image",   icon: <ImageIcon size={16} />, label: "商品图（自创）", module: "tools" },
  { key: "tools-remix",      href: "/dashboard/tools/product-remix",   icon: <Wand2 size={16} />,     label: "整体仿写",       module: "tools" },
  { key: "tools-text-remix", href: "/dashboard/tools/text-remix",      icon: <Wand2 size={16} />,     label: "文本仿写",       module: "tools" },
  { key: "tools-extension",  href: "/dashboard/extension",             icon: <Puzzle size={16} />,    label: "我的浏览器扩展", module: "tools" },

  { key: "settings",    href: "/dashboard/profile",               icon: <Settings size={20} />,  label: "个人设置", module: "common" },
];

// 管理员组（默认折叠，admin 才能看到）
const adminNavItems: NavItem[] = [
  { key: "admin",          href: "/dashboard/admin",          icon: <ShieldCheck size={16} />,        label: "控制台",   module: "admin" },
  { key: "admin-users",    href: "/dashboard/admin/users",    icon: <Users size={16} />,              label: "用户管理", module: "admin" },
  { key: "admin-invites",  href: "/dashboard/admin/invites",  icon: <Ticket size={16} />,             label: "邀请码",   module: "admin" },
  { key: "admin-audit",    href: "/dashboard/admin/audit",    icon: <HistoryIcon size={16} />,        label: "审计日志", module: "admin" },
  { key: "admin-ai",       href: "/dashboard/admin/ai",       icon: <Sparkles size={16} />,           label: "AI 模型",  module: "admin" },
  { key: "admin-feishu",   href: "/dashboard/admin/feishu",   icon: <Link2 size={16} />,              label: "飞书应用", module: "admin" },
  { key: "admin-system",   href: "/dashboard/admin/system",   icon: <SlidersHorizontal size={16} />,  label: "系统配置", module: "admin" },
  { key: "admin-accounts", href: "/dashboard/admin/accounts", icon: <Server size={16} />,             label: "账号管理", module: "admin" },
];

const COLLAPSE_KEY = "sidebar.collapsed.modules";

// 默认所有可折叠组都收起；进入页面时再根据当前 pathname 自动展开命中那一组。
const DEFAULT_COLLAPSED: Record<string, boolean> = {
  xhs: true, douyin: true, mp: true, tools: true, admin: true,
};

export type SidebarProps = {
  /** 移动端 drawer 是否打开（仅在 <md 生效） */
  mobileOpen?: boolean;
  /** 关闭 drawer 的回调（点击遮罩 / 链接 / 关闭按钮触发） */
  onMobileClose?: () => void;
};

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabQuery = searchParams?.get("tab") || "";
  const { t } = useI18n();
  const { logout, user } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const navItems = user?.role === "admin" ? [...baseNavItems, ...adminNavItems] : baseNavItems;

  // 折叠状态：默认全部可折叠组收起；localStorage 中有值优先用之；
  // 当前 pathname 命中的组在初次渲染时强制展开（避免用户进入页面看不到当前位置）。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(DEFAULT_COLLAPSED);

  // 推断当前 pathname 落在哪个组里（用于初次自动展开）
  const activeGroup: ModuleId | null = useMemo(() => {
    for (const it of navItems) {
      if (it.module === "common") continue;
      const hrefPath = it.href.split("?")[0];
      const matched = pathname === hrefPath
        || pathname === hrefPath.replace(/\/$/, "")
        || pathname.startsWith(hrefPath + "/");
      if (matched) return it.module;
    }
    return null;
  }, [pathname, navItems]);

  useEffect(() => {
    let initial: Record<string, boolean> = { ...DEFAULT_COLLAPSED };
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) initial = { ...initial, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    if (activeGroup) initial[activeGroup] = false; // 当前所在组自动展开
    setCollapsed(initial);
    // 仅在首次挂载和 active 组变化时执行
  }, [activeGroup]);

  const toggle = (m: ModuleId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [m]: !prev[m] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // 最长前缀匹配 active：精确匹配 href 或 href + "/"
  // 对带 ?tab=xxx 的入口（如「账号管理」）：当前 path 命中且 query 也匹配才算 active
  const candidates = navItems
    .filter((it) => {
      const [hrefPath, hrefQs] = it.href.split("?");
      const pathMatch = hrefPath === "/dashboard"
        ? pathname === "/dashboard" || pathname === "/dashboard/"
        : pathname === hrefPath
          || pathname === hrefPath.replace(/\/$/, "")
          || pathname.startsWith(hrefPath + "/");
      if (!pathMatch) return false;
      if (!hrefQs) return true;
      const want = new URLSearchParams(hrefQs).get("tab") || "";
      return want === tabQuery;
    })
    .sort((a, b) => b.href.length - a.href.length);
  const activeKey = (() => {
    if (tabQuery) {
      const withQuery = candidates.find((c) => c.href.includes("?tab="));
      if (withQuery) return withQuery.key;
    }
    const noQuery = candidates.filter((c) => !c.href.includes("?"));
    return (noQuery[0] || candidates[0])?.key;
  })();

  // 按 module 分桶但保留原序
  const blocks: { module: ModuleId; items: NavItem[] }[] = [];
  for (const it of navItems) {
    const last = blocks[blocks.length - 1];
    if (last && last.module === it.module) last.items.push(it);
    else blocks.push({ module: it.module, items: [it] });
  }

  return (
    <>
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
          <span className="hidden max-md:block lg:block font-bold text-base text-foreground tracking-tight">
            Trend<span className="text-primary">Pulse</span>
          </span>
        </div>
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
            const isCollapsible = blk.module !== "common";
            const isOpen = !isCollapsible || !collapsed[blk.module];
            return (
              <div key={bi} className={isCollapsible ? "mt-3 mb-1" : "mb-1"}>
                {isCollapsible && (
                  <button
                    type="button"
                    onClick={() => toggle(blk.module)}
                    className="hidden max-md:flex lg:flex w-full items-center gap-2.5 px-3 py-2 text-left
                               text-default-700 hover:bg-default-100 rounded-lg transition-colors group"
                  >
                    <span className="shrink-0 text-default-500 group-hover:text-default-700 transition-colors">
                      {GROUP_ICON[blk.module as Exclude<ModuleId, "common">]}
                    </span>
                    <span className="text-sm font-semibold flex-1">
                      {GROUP_LABEL[blk.module as Exclude<ModuleId, "common">]}
                    </span>
                    {blk.items[0]?.wip && (
                      <Chip size="sm" variant="flat" color="warning" className="h-5 px-1.5 text-[10px]">
                        WIP
                      </Chip>
                    )}
                    {isOpen
                      ? <ChevronDown size={14} className="text-default-400 shrink-0" />
                      : <ChevronRight size={14} className="text-default-400 shrink-0" />}
                  </button>
                )}
                {/* 子项：折叠时仅在 lg 屏隐藏；移动端 drawer 内（max-md）按宽态显示 */}
                <div className={isOpen ? "" : "max-md:hidden hidden lg:hidden"}>
                  {blk.items.map((item) => {
                    const isActive = item.key === activeKey;
                    const indent = isCollapsible ? "max-md:ml-4 lg:ml-4" : "";
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
                              {/* 可折叠组的子项在窄屏（md 折叠态）显示组图标，宽屏显示子项 icon */}
                              {isCollapsible ? (
                                <>
                                  <span className="max-md:hidden lg:hidden">
                                    {GROUP_ICON[blk.module as Exclude<ModuleId, "common">]}
                                  </span>
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
