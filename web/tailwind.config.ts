import type { Config } from "tailwindcss";
import { nextui } from "@nextui-org/react";

// 主色：violet（保留 v1 主色，所有 NextUI primary 走它）
const violet = {
  DEFAULT: "#7c3aed", foreground: "#ffffff",
  50:  "#f5f3ff", 100: "#ede9fe", 200: "#ddd6fe", 300: "#c4b5fd",
  400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed", 700: "#6d28d9",
  800: "#5b21b6", 900: "#4c1d95",
};

// 板块语义色（直接 className：text-monitor-600 / bg-studio-100 / border-toolbox-500）
const sectionColors = {
  monitor:  { 50: "#eff6ff", 100: "#dbeafe", 500: "#3b82f6", 600: "#2563eb", 900: "#1e3a8a" }, // 蓝
  studio:   { 50: "#faf5ff", 100: "#f3e8ff", 500: "#a855f7", 600: "#9333ea", 900: "#581c87" }, // 紫
  original: { 50: "#ecfdf5", 100: "#d1fae5", 500: "#10b981", 600: "#059669", 900: "#064e3b" }, // 翠绿
  remix:    { 50: "#fff7ed", 100: "#ffedd5", 500: "#f97316", 600: "#ea580c", 900: "#7c2d12" }, // 橙
  toolbox:  { 50: "#f0fdfa", 100: "#ccfbf1", 500: "#14b8a6", 600: "#0d9488", 900: "#134e4a" }, // 青
  hotnews:  { 50: "#fff1f2", 100: "#ffe4e6", 500: "#f43f5e", 600: "#e11d48", 900: "#881337" }, // 玫
} as const;

// 板块语义色 className safelist —— 因为我们用 `bg-${sec.color}-100` 动态拼接，
// Tailwind JIT 只识别完整字符串字面量，必须把所有可能组合显式列出来才会编译进去。
const SECTION_KEYS = ["monitor", "studio", "original", "remix", "toolbox", "hotnews"] as const;
const SECTION_SAFELIST = SECTION_KEYS.flatMap((c) => [
  // 背景
  `bg-${c}-50`, `bg-${c}-100`, `bg-${c}-500`, `bg-${c}-600`,
  `dark:bg-${c}-900/10`, `dark:bg-${c}-900/30`, `dark:bg-${c}-900/40`,
  // 文字
  `text-${c}-500`, `text-${c}-600`, `text-${c}-700`, `text-${c}-100`,
  `dark:text-${c}-100`, `dark:text-${c}-400`, `dark:text-${c}-500`,
  // 边框
  `border-${c}-400`, `border-${c}-500`, `hover:border-${c}-400`, `dark:hover:border-${c}-500`,
  // hover 背景
  `hover:bg-${c}-50/50`, `dark:hover:bg-${c}-900/10`,
  // group-hover 文字
  `group-hover:text-${c}-600`,
]);

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@nextui-org/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  safelist: SECTION_SAFELIST,
  theme: {
    extend: {
      colors: {
        monitor:  sectionColors.monitor,
        studio:   sectionColors.studio,
        original: sectionColors.original,
        remix:    sectionColors.remix,
        toolbox:  sectionColors.toolbox,
        hotnews:  sectionColors.hotnews,
      },
      fontSize: {
        "display-sm": ["1.75rem", { lineHeight: "2.25rem", letterSpacing: "-0.02em", fontWeight: "700" }],
        "display-md": ["2.25rem", { lineHeight: "2.75rem", letterSpacing: "-0.02em", fontWeight: "700" }],
        "display-lg": ["3rem",    { lineHeight: "3.5rem",  letterSpacing: "-0.02em", fontWeight: "800" }],
      },
      maxWidth: {
        page: "1200px",
        "page-wide": "1440px",
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.05), 0 1px 2px -1px rgb(0 0 0 / 0.05)",
        "card-hover": "0 4px 12px -2px rgb(0 0 0 / 0.08), 0 2px 6px -2px rgb(0 0 0 / 0.05)",
      },
    },
  },
  darkMode: "class",
  plugins: [
    nextui({
      themes: {
        light: {
          colors: {
            primary: violet,
            focus: violet.DEFAULT,
            background: "#fafaf9",     // 暖灰白，比纯白柔和
            content1: "#ffffff",
            content2: "#f5f5f4",
            content3: "#e7e5e4",
          },
        },
        dark: {
          colors: {
            primary: { ...violet, DEFAULT: "#8b5cf6" },
            focus: "#8b5cf6",
            background: "#0c0a14",     // 微紫黑，比纯黑暖
            content1: "#161320",
            content2: "#1f1b2e",
            content3: "#2a253c",
          },
        },
      },
    }),
  ],
};

export default config;
