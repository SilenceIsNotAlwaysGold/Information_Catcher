import type { Config } from "tailwindcss";
import { nextui } from "@nextui-org/react";

// 主色调：紫罗兰（violet）—— 现代后台 SaaS 风
const violet = {
  DEFAULT: "#7c3aed",
  foreground: "#ffffff",
  50:  "#f5f3ff",
  100: "#ede9fe",
  200: "#ddd6fe",
  300: "#c4b5fd",
  400: "#a78bfa",
  500: "#8b5cf6",
  600: "#7c3aed",
  700: "#6d28d9",
  800: "#5b21b6",
  900: "#4c1d95",
};

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@nextui-org/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: { extend: {} },
  darkMode: "class",
  plugins: [
    nextui({
      themes: {
        light: {
          colors: {
            primary: violet,
            focus: violet.DEFAULT,
          },
        },
        dark: {
          colors: {
            // 暗色下用更亮一档（500），保证在深色背景上有足够对比度
            primary: { ...violet, DEFAULT: "#8b5cf6" },
            focus: "#8b5cf6",
          },
        },
      },
    }),
  ],
};

export default config;
