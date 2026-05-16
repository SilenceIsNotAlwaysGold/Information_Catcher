"use client";

/**
 * TopBar v2 — 桌面端顶部条。
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ☰  AI 工坊 › AI PPT          ⌘K搜索  +新建▾  ⊛6249  admin▾  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * 提供：
 *   - 面包屑（自动从 pathname 推导，sectionForPath / breadcrumbForPath 单一真相）
 *   - 全局 ⌘K 搜索按钮（点击调 openSearch）
 *   - + 新建快捷菜单（PPT / 漫画 / 小说 / 旅游攻略 / 加监控 / 抓博主作品）
 *   - 余额 Chip（实时拉 /api/billing/me；不足 50 点变橙；为 0 变红，点击进个人中心）
 *   - 用户菜单（个人中心 / 主题 / 退出登录）
 *   - 移动端：折叠成"汉堡 + 当前页 + 搜索图标"，其它操作收进右上头像菜单
 */
import { Menu, Search, Plus, Coins, Sun, Moon, LogOut, Settings, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import {
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSection,
} from "@nextui-org/dropdown";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { breadcrumbForPath } from "@/lib/sections";

type Props = {
  onMobileMenu: () => void;
  onOpenSearch: () => void;
};

const fetcher = async ([url, t]: [string, string | null]) => {
  const r = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

const QUICK_ACTIONS = [
  { key: "new-ppt",        label: "新建 PPT",         href: "/dashboard/studio/ppt",            desc: "扣 ppt_outline 点" },
  { key: "new-comic",      label: "新建漫画",         href: "/dashboard/studio/comic" },
  { key: "new-novel",      label: "新建小说",         href: "/dashboard/studio/novel" },
  { key: "new-travel",     label: "新建旅游攻略",     href: "/dashboard/studio/travel" },
  { key: "new-image",      label: "AI 生图",          href: "/dashboard/tools/product-image",   desc: "商品 / 场景图" },
  { key: "new-original",   label: "原创 · 平台改写",  href: "/dashboard/original",              desc: "你写底稿 → 平台风格" },
  { key: "add-monitor",    label: "添加监控帖子",     href: "/dashboard/xhs/posts" },
  { key: "import-creator", label: "导入博主全部作品", href: "/dashboard/xhs/creators" },
];

export function TopBar({ onMobileMenu, onOpenSearch }: Props) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { user, token, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // 余额（30s 刷一次，焦点回 tab 时再刷）
  const { data: billing } = useSWR<{ balance: number }>(
    token ? ["/api/billing/me", token] : null,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
  );
  const balance = billing?.balance;

  const crumbs = breadcrumbForPath(pathname);

  // 监听 ⌘/Ctrl + K 一次（GlobalSearch 自己也监听了 — 这里再监听一次直接对接 onOpenSearch；双监听等价）
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        onOpenSearch();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onOpenSearch]);

  // 余额色：>= 50 默认，< 50 warning，<= 0 danger
  const balColor: "default" | "warning" | "danger" =
    balance === undefined ? "default" :
    balance <= 0 ? "danger" :
    balance < 50 ? "warning" :
    "default";

  return (
    <header className="sticky top-0 z-30 h-14 bg-content1/80 backdrop-blur-md border-b border-divider flex items-center gap-2 px-3 md:px-5">
      {/* 移动端汉堡 */}
      <button
        type="button"
        onClick={onMobileMenu}
        className="md:hidden p-1 rounded hover:bg-default-100 text-default-600"
        aria-label="打开菜单"
      >
        <Menu size={20} />
      </button>

      {/* 面包屑 */}
      <nav className="hidden md:flex items-center gap-1.5 text-sm min-w-0 flex-1" aria-label="breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <ChevronRight size={14} className="text-default-300 shrink-0" />}
            {c.href ? (
              <Link href={c.href} className="text-default-500 hover:text-foreground truncate transition-colors">
                {c.label}
              </Link>
            ) : (
              <span className="text-foreground font-medium truncate">{c.label}</span>
            )}
          </span>
        ))}
      </nav>

      {/* 移动端只显示当前页面名 */}
      <span className="md:hidden font-semibold text-foreground truncate flex-1">
        {crumbs[crumbs.length - 1]?.label || "TrendPulse"}
      </span>

      {/* 右侧操作组 */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* 全局搜索 */}
        <Button
          variant="flat" size="sm" radius="md"
          className="hidden md:inline-flex"
          startContent={<Search size={14} />}
          onPress={onOpenSearch}
          aria-label="全局搜索"
        >
          <span className="text-default-500 text-xs">搜索</span>
          <kbd className="ml-1 px-1.5 py-0.5 rounded bg-default-100 text-[10px] text-default-500 font-mono">⌘K</kbd>
        </Button>
        <Button
          isIconOnly variant="light" size="sm" radius="md"
          className="md:hidden"
          onPress={onOpenSearch}
          aria-label="全局搜索"
        >
          <Search size={18} />
        </Button>

        {/* + 新建 */}
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button
              variant="flat" color="primary" size="sm" radius="md"
              startContent={<Plus size={14} />}
              endContent={<ChevronDown size={12} />}
              className="hidden md:inline-flex"
            >
              新建
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label="快捷新建" variant="flat" onAction={(k) => {
            const item = QUICK_ACTIONS.find((a) => a.key === k);
            if (item) router.push(item.href);
          }}>
            <DropdownSection title="AI 工坊">
              {QUICK_ACTIONS.slice(0, 5).map((a) => (
                <DropdownItem key={a.key} description={a.desc}>{a.label}</DropdownItem>
              ))}
            </DropdownSection>
            <DropdownSection title="原创">
              <DropdownItem key={QUICK_ACTIONS[5].key} description={QUICK_ACTIONS[5].desc}>
                {QUICK_ACTIONS[5].label}
              </DropdownItem>
            </DropdownSection>
            <DropdownSection title="监控">
              {QUICK_ACTIONS.slice(6).map((a) => (
                <DropdownItem key={a.key}>{a.label}</DropdownItem>
              ))}
            </DropdownSection>
          </DropdownMenu>
        </Dropdown>

        {/* 余额 Chip */}
        <Link href="/dashboard/profile" aria-label="个人中心">
          <Chip
            startContent={<Coins size={12} className="ml-1" />}
            color={balColor}
            variant={balColor === "default" ? "flat" : "flat"}
            size="sm"
            className="cursor-pointer hover:opacity-80 transition-opacity"
          >
            {balance === undefined ? "—" : balance.toFixed(2)}
          </Chip>
        </Link>

        {/* 用户菜单 */}
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <button
              type="button"
              className="ml-1 size-8 rounded-full bg-primary-100 dark:bg-primary-900/40 grid place-items-center text-primary-600 dark:text-primary-400 font-semibold text-xs uppercase hover:ring-2 hover:ring-primary-200 dark:hover:ring-primary-700 transition-all"
              aria-label="用户菜单"
            >
              {(user?.username || "U")[0]}
            </button>
          </DropdownTrigger>
          <DropdownMenu aria-label="用户菜单" variant="flat">
            <DropdownItem
              key="profile"
              startContent={<Settings size={14} />}
              onClick={() => router.push("/dashboard/profile")}
            >
              个人中心
            </DropdownItem>
            <DropdownItem
              key="theme"
              startContent={mounted && theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {mounted && theme === "dark" ? "切到浅色" : "切到暗色"}
            </DropdownItem>
            <DropdownItem
              key="logout"
              color="danger"
              startContent={<LogOut size={14} />}
              onClick={logout}
            >
              退出登录
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>
    </header>
  );
}
