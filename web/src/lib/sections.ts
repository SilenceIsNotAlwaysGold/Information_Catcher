/**
 * 板块（Section）配置 — 整个前端的 IA 单一真相源。
 *
 * 五大板块（按 v2 ROADMAP）：
 *   monitor  — 内容获取 / 监控告警（小红书 + 抖音）
 *   studio   — AI 工坊（漫画 / 小说 / 旅游 / PPT）
 *   remix    — 仿写床（商品图 / 整体仿写 / 文案换背景）
 *   toolbox  — 实用工具（服务监控、扩展、未来 gotenberg/ace-step）
 *   hotnews  — 热点雷达
 *
 * 任何地方需要"板块名/色/图标/路由"都从这里取，避免到处硬编码。
 */
import {
  Eye, Sparkles, Wand2, Wrench, Newspaper, PenLine,
  type LucideIcon,
} from "lucide-react";

export type SectionKey = "monitor" | "studio" | "original" | "remix" | "toolbox" | "hotnews";

export type SectionMeta = {
  key: SectionKey;
  label: string;
  desc: string;
  icon: LucideIcon;
  /** Tailwind 颜色名前缀，配合 tailwind.config 的 sectionColors 用：text-monitor-600 / bg-monitor-50 */
  color: SectionKey;
  /** 板块二级首页路径 */
  href: string;
  /** 板块下的所有子页（用于 Sidebar 展开和 CommandBar 跳转）*/
  children: Array<{ key: string; label: string; href: string; hint?: string }>;
};

export const SECTIONS: Record<SectionKey, SectionMeta> = {
  monitor: {
    key: "monitor",
    label: "监控",
    desc: "追踪小红书 / 抖音的帖子、博主、热门内容",
    icon: Eye,
    color: "monitor",
    href: "/dashboard/monitor",
    children: [
      { key: "xhs-posts",     label: "小红书 · 帖子",   href: "/dashboard/xhs/posts" },
      { key: "xhs-creators",  label: "小红书 · 博主追新", href: "/dashboard/xhs/creators" },
      { key: "xhs-trending",  label: "小红书 · 热门内容", href: "/dashboard/xhs/trending" },
      { key: "douyin-posts",     label: "抖音 · 视频",     href: "/dashboard/douyin/posts" },
      { key: "douyin-creators",  label: "抖音 · 博主追新", href: "/dashboard/douyin/creators" },
      { key: "douyin-trending",  label: "抖音 · 热门内容", href: "/dashboard/douyin/trending" },
      { key: "monitor-history",  label: "检测历史",        href: "/dashboard/monitor/history" },
      { key: "monitor-settings", label: "告警与设置",      href: "/dashboard/monitor" },
    ],
  },
  studio: {
    key: "studio",
    label: "AI 工坊",
    desc: "用 AI 生成漫画、小说、旅游攻略、PPT 和图片",
    icon: Sparkles,
    color: "studio",
    href: "/dashboard/studio",
    children: [
      { key: "studio-comic",   label: "AI 漫画",      href: "/dashboard/studio/comic",   hint: "对话→分镜→生图" },
      { key: "studio-novel",   label: "AI 小说",      href: "/dashboard/studio/novel",   hint: "卷/章/角色卡/伏笔" },
      { key: "studio-travel",  label: "AI 旅游攻略",  href: "/dashboard/studio/travel",  hint: "纯 LLM 一键生成" },
      { key: "studio-ppt",     label: "AI PPT",       href: "/dashboard/studio/ppt",     hint: "大纲 + 模板 + 配图" },
      { key: "studio-image",   label: "AI 生图",      href: "/dashboard/tools/product-image", hint: "商品图 / 场景图" },
    ],
  },
  original: {
    key: "original",
    label: "原创",
    desc: "你写一段底稿 → AI 按平台风格改写成成品",
    icon: PenLine,
    color: "original",
    href: "/dashboard/original",
    children: [
      // 子页都在 /dashboard/original 内 tab 切换，不暴露给侧边栏
    ],
  },
  remix: {
    key: "remix",
    label: "仿写床",
    desc: "用 AI 把别人的爆款内容改造成自己的",
    icon: Wand2,
    color: "remix",
    href: "/dashboard/tools",
    children: [
      { key: "tools-product-remix", label: "整体仿写",        href: "/dashboard/tools/product-remix" },
      { key: "tools-text-remix",    label: "文案换背景",      href: "/dashboard/tools/text-remix" },
    ],
  },
  toolbox: {
    key: "toolbox",
    label: "工具箱",
    desc: "服务监控、浏览器扩展、数据导入等辅助工具",
    icon: Wrench,
    color: "toolbox",
    href: "/dashboard/toolbox",
    children: [
      { key: "toolbox-uptime",    label: "服务监控",      href: "/dashboard/toolbox/uptime", hint: "HTTP/TCP 探活 + 告警" },
      { key: "extension",         label: "浏览器扩展",    href: "/dashboard/extension" },
      { key: "import",            label: "数据导入",      href: "/dashboard/import" },
      { key: "publish",           label: "发布",          href: "/dashboard/publish" },
    ],
  },
  hotnews: {
    key: "hotnews",
    label: "热点雷达",
    desc: "9 个源汇总：HN、GitHub、V2EX、微博、B 站、知乎、IT 之家…",
    icon: Newspaper,
    color: "hotnews",
    href: "/dashboard/hotnews",
    children: [],
  },
};

export const SECTION_ORDER: SectionKey[] = ["monitor", "studio", "original", "remix", "toolbox", "hotnews"];

/**
 * 从 pathname 推断属于哪个板块（用于 TopBar 面包屑高亮、Sidebar active）。
 * 返回 null = 概览页或不属任何板块。
 */
export function sectionForPath(pathname: string): SectionKey | null {
  for (const sec of SECTION_ORDER) {
    const m = SECTIONS[sec];
    // 板块二级首页本身 or 任一子页前缀
    if (pathname === m.href || pathname.startsWith(m.href + "/")) return sec;
    for (const child of m.children) {
      if (pathname === child.href || pathname.startsWith(child.href + "/")) return sec;
    }
  }
  return null;
}

/**
 * 从 pathname 推断面包屑（TopBar 用）。返回最多 3 段，最后一段是当前页。
 */
export function breadcrumbForPath(pathname: string): Array<{ label: string; href?: string }> {
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return [{ label: "概览" }];
  }
  if (pathname.startsWith("/dashboard/admin")) {
    const seg = pathname.split("/")[3] || "";
    const map: Record<string, string> = {
      "": "控制台", users: "用户管理", invites: "邀请码", audit: "审计日志",
      ai: "AI 模型", feishu: "飞书应用", system: "系统配置",
    };
    return [
      { label: "管理员", href: "/dashboard/admin" },
      ...(seg ? [{ label: map[seg] || seg }] : []),
    ];
  }
  if (pathname.startsWith("/dashboard/profile")) {
    return [{ label: "个人中心" }];
  }
  const sec = sectionForPath(pathname);
  if (!sec) return [{ label: "TrendPulse" }];
  const meta = SECTIONS[sec];
  const crumbs: Array<{ label: string; href?: string }> = [
    { label: meta.label, href: meta.href },
  ];
  const child = meta.children.find(
    (c) => pathname === c.href || pathname.startsWith(c.href + "/"),
  );
  if (child) crumbs.push({ label: child.label });
  return crumbs;
}
