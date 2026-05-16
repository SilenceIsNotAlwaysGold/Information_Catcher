"use client";

/**
 * Sidebar v2 —— 按板块（SECTIONS）重组。
 *
 * 结构：
 *   🏠 概览
 *   ────────────
 *   👁 监控        ▾  （展开子项：小红书 帖子/博主/热门 + 抖音 同 + 检测历史 + 告警设置）
 *   ✨ AI 工坊      ▾  （漫画 / 小说 / 旅游 / PPT）
 *   🪄 仿写床      ▾  （商品图 / 整体仿写 / 文案换背景）
 *   🛠 工具箱      ▾  （服务监控 / 浏览器扩展 / 数据导入 / 发布）
 *   📰 热点雷达
 *   ────────────
 *   ⚙️ 个人设置
 *   🛡 管理员      ▾  （admin 才可见，默认折叠）
 *
 * 跟 v1 比的关键变化：
 *   - 不再用 module 字段串平台/工具/管理员；改用 SECTIONS 单一真相源
 *   - "公众号"砍掉；"工具垃圾桶"拆为「仿写床」+「工具箱」两个有清晰主题的板块
 *   - 子项 icon 不再是 GROUP_ICON 兼并版，每项有自己的图标
 *   - 移动 drawer + 折叠态（lg 以下）的伪折叠 hack 简化掉了；md 折叠时直接展示组图标 tooltip
 */
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Home, Settings, LogOut, ShieldCheck, Moon, Sun, X,
  ChevronDown, ChevronRight, Users, Ticket, History as HistoryIcon, Sparkles, Link2,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import { useTheme } from "next-themes";
import { useAuth } from "@/contexts/AuthContext";
import { useEffect, useMemo, useState } from "react";
import { SECTION_ORDER, SECTIONS, sectionForPath, type SectionKey } from "@/lib/sections";

const COLLAPSE_KEY = "sidebar.collapsed.v2";

// 管理员子项独立维护
const ADMIN_ITEMS = [
  { key: "admin",         href: "/dashboard/admin",         icon: ShieldCheck,         label: "控制台" },
  { key: "admin-users",   href: "/dashboard/admin/users",   icon: Users,               label: "用户管理" },
  { key: "admin-invites", href: "/dashboard/admin/invites", icon: Ticket,              label: "邀请码" },
  { key: "admin-audit",   href: "/dashboard/admin/audit",   icon: HistoryIcon,         label: "审计日志" },
  { key: "admin-ai",      href: "/dashboard/admin/ai",      icon: Sparkles,            label: "AI 模型" },
  { key: "admin-feishu",  href: "/dashboard/admin/feishu",  icon: Link2,               label: "飞书应用" },
  { key: "admin-system",  href: "/dashboard/admin/system",  icon: SlidersHorizontal,   label: "系统配置" },
];

const SECTION_ACTIVE_BG: Record<SectionKey, string> = {
  monitor:  "bg-monitor-50  text-monitor-700  dark:bg-monitor-900/30  dark:text-monitor-100",
  studio:   "bg-studio-50   text-studio-700   dark:bg-studio-900/30   dark:text-studio-100",
  original: "bg-original-50 text-original-700 dark:bg-original-900/30 dark:text-original-100",
  remix:    "bg-remix-50    text-remix-700    dark:bg-remix-900/30    dark:text-remix-100",
  toolbox:  "bg-toolbox-50  text-toolbox-700  dark:bg-toolbox-900/30  dark:text-toolbox-100",
  hotnews:  "bg-hotnews-50  text-hotnews-700  dark:bg-hotnews-900/30  dark:text-hotnews-100",
};
const SECTION_DOT: Record<SectionKey, string> = {
  monitor:  "bg-monitor-500",
  studio:   "bg-studio-500",
  original: "bg-original-500",
  remix:    "bg-remix-500",
  toolbox:  "bg-toolbox-500",
  hotnews:  "bg-hotnews-500",
};

export type SidebarProps = {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps = {}) {
  const pathname = usePathname() || "/";
  const { logout, user } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const isAdmin = user?.role === "admin";

  const activeSection = useMemo<SectionKey | null>(() => sectionForPath(pathname), [pathname]);

  // 折叠状态：默认全折叠；命中的板块自动展开
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    SECTION_ORDER.forEach((k) => (init[k] = true));
    init["admin"] = true;
    return init;
  });
  useEffect(() => {
    let next: Record<string, boolean> = {};
    SECTION_ORDER.forEach((k) => (next[k] = true));
    next["admin"] = true;
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) next = { ...next, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    if (activeSection) next[activeSection] = false;  // 命中的板块自动展开
    if (pathname.startsWith("/dashboard/admin")) next["admin"] = false;
    setCollapsed(next);
  }, [activeSection, pathname]);

  const toggle = (key: string) => {
    setCollapsed((p) => {
      const n = { ...p, [key]: !p[key] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(n)); } catch {}
      return n;
    });
  };

  const isActive = (href: string) =>
    href === "/dashboard"
      ? pathname === "/dashboard" || pathname === "/dashboard/"
      : pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      {/* 移动端遮罩 */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-black/50 transition-opacity duration-200
          ${mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={onMobileClose}
        aria-hidden="true"
      />
      <aside
        className={`fixed left-0 top-0 h-screen w-64 bg-content1 border-r border-divider flex flex-col z-50
          transition-transform duration-200 ease-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"} md:translate-x-0`}
      >
        {/* Brand */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-divider">
          <Link href="/dashboard" className="flex items-center gap-2" onClick={onMobileClose}>
            <span className="text-2xl leading-none">🪐</span>
            <span className="font-bold text-base text-foreground tracking-tight">
              Trend<span className="text-primary">Pulse</span>
            </span>
          </Link>
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
          <ul className="space-y-0.5 px-2">
            {/* 概览 */}
            <NavLeaf
              href="/dashboard"
              icon={<Home size={18} />}
              label="概览"
              active={isActive("/dashboard")}
              onClick={onMobileClose}
            />

            <Divider />

            {/* 5 个板块 */}
            {SECTION_ORDER.map((key) => {
              const sec = SECTIONS[key];
              const isOpen = !collapsed[key];
              const isHere = activeSection === key;
              const hasChildren = sec.children.length > 0;
              const Icon = sec.icon;
              if (!hasChildren) {
                // 热点雷达：扁平直链
                return (
                  <NavLeaf
                    key={key}
                    href={sec.href}
                    icon={<Icon size={18} className={`text-${sec.color}-600 dark:text-${sec.color}-500`} />}
                    label={sec.label}
                    active={isHere}
                    activeBg={SECTION_ACTIVE_BG[key]}
                    onClick={onMobileClose}
                  />
                );
              }
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg transition-colors
                      ${isHere ? SECTION_ACTIVE_BG[key] : "text-default-700 hover:bg-default-100 dark:hover:bg-default-200/40"}`}
                  >
                    <span className={`shrink-0 ${isHere ? "" : `text-${sec.color}-600 dark:text-${sec.color}-500`}`}>
                      <Icon size={18} />
                    </span>
                    <span className="text-sm font-medium flex-1">{sec.label}</span>
                    {isOpen
                      ? <ChevronDown size={14} className="text-default-400" />
                      : <ChevronRight size={14} className="text-default-400" />}
                  </button>
                  {isOpen && (
                    <ul className="mt-0.5 mb-1 ml-5 pl-3 border-l border-default-200 dark:border-default-200/40 space-y-0.5">
                      {/* 板块二级首页（如果路径是子页则不再单独显示"概览"快捷条目，避免冗余） */}
                      <NavChild
                        href={sec.href}
                        label={`${sec.label} 概览`}
                        active={pathname === sec.href || pathname === sec.href + "/"}
                        dotClass={SECTION_DOT[key]}
                        onClick={onMobileClose}
                      />
                      {sec.children.map((c) => (
                        <NavChild
                          key={c.key}
                          href={c.href}
                          label={c.label}
                          hint={c.hint}
                          active={isActive(c.href)}
                          dotClass={SECTION_DOT[key]}
                          onClick={onMobileClose}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}

            <Divider />

            <NavLeaf
              href="/dashboard/profile"
              icon={<Settings size={18} />}
              label="个人中心"
              active={isActive("/dashboard/profile")}
              onClick={onMobileClose}
            />

            {/* 管理员组（仅 admin 可见） */}
            {isAdmin && (
              <li>
                <button
                  type="button"
                  onClick={() => toggle("admin")}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg transition-colors
                    ${pathname.startsWith("/dashboard/admin") ? "bg-default-100 text-foreground dark:bg-default-200/40" : "text-default-600 hover:bg-default-100 dark:hover:bg-default-200/40"}`}
                >
                  <span className="shrink-0 text-default-500"><ShieldCheck size={18} /></span>
                  <span className="text-sm font-medium flex-1">管理员</span>
                  {collapsed["admin"]
                    ? <ChevronRight size={14} className="text-default-400" />
                    : <ChevronDown size={14} className="text-default-400" />}
                </button>
                {!collapsed["admin"] && (
                  <ul className="mt-0.5 mb-1 ml-5 pl-3 border-l border-default-200 dark:border-default-200/40 space-y-0.5">
                    {ADMIN_ITEMS.map((it) => (
                      <NavChild
                        key={it.key}
                        href={it.href}
                        label={it.label}
                        active={isActive(it.href)}
                        dotClass="bg-default-400"
                        onClick={onMobileClose}
                      />
                    ))}
                  </ul>
                )}
              </li>
            )}
          </ul>
        </nav>

        {/* 底部：用户信息 + 主题 + 退出 */}
        <div className="border-t border-divider p-3 space-y-2">
          <div className="flex items-center gap-2 px-1 text-sm">
            <div className="size-7 rounded-full bg-primary-100 dark:bg-primary-900/40 grid place-items-center text-primary-600 dark:text-primary-400 font-semibold text-xs uppercase">
              {(user?.username || "U")[0]}
            </div>
            <span className="text-default-700 truncate flex-1">{user?.username}</span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip content="退出登录">
              <Button isIconOnly variant="light" size="sm" onClick={logout}>
                <LogOut size={16} />
              </Button>
            </Tooltip>
            <Tooltip content={mounted && theme === "dark" ? "切到浅色" : "切到暗色"}>
              <Button
                isIconOnly variant="light" size="sm" aria-label="切换主题"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {mounted && theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </Button>
            </Tooltip>
          </div>
        </div>
      </aside>
    </>
  );
}

/** 顶级直链（概览 / 热点雷达 / 个人中心） */
function NavLeaf({
  href, icon, label, active, activeBg, onClick,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  /** 命中态背景色 className（板块直链覆盖默认 primary） */
  activeBg?: string;
  onClick?: () => void;
}) {
  const defaultActive = "bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-100";
  return (
    <li>
      <Link href={href} onClick={onClick}>
        <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors
          ${active ? (activeBg || defaultActive) : "text-default-700 hover:bg-default-100 dark:hover:bg-default-200/40"}`}>
          <span className="shrink-0">{icon}</span>
          <span className="text-sm font-medium flex-1">{label}</span>
        </div>
      </Link>
    </li>
  );
}

/** 子菜单项（板块下的具体页面） */
function NavChild({
  href, label, hint, active, dotClass, onClick,
}: {
  href: string;
  label: string;
  hint?: string;
  active?: boolean;
  /** 圆点颜色 className */
  dotClass: string;
  onClick?: () => void;
}) {
  return (
    <li>
      <Link href={href} onClick={onClick}>
        <div className={`relative flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-md transition-colors
          ${active
            ? "bg-default-100 text-foreground dark:bg-default-200/50 font-medium"
            : "text-default-600 hover:bg-default-100 dark:hover:bg-default-200/40"}`}>
          {/* 圆点 — 给侧栏一点节奏感 */}
          <span className={`absolute -left-[7px] size-1.5 rounded-full ${active ? dotClass : "bg-transparent"}`} />
          <span className="text-sm truncate flex-1">{label}</span>
          {hint && active && (
            <span className="text-[10px] text-default-400 truncate hidden xl:inline-block">{hint}</span>
          )}
        </div>
      </Link>
    </li>
  );
}

function Divider() {
  return <li className="my-2 mx-3 h-px bg-divider" />;
}
