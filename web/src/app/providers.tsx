// 全局Providers - 包装NextUI、主题、国际化、认证等上下文
"use client";

import { NextUIProvider } from "@nextui-org/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { Toaster } from "react-hot-toast";
import { I18nProvider } from "@/contexts/I18nContext";
import { AuthProvider } from "@/contexts/AuthContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NextUIProvider>
      <NextThemesProvider
        attribute="class"
        defaultTheme="light"
        enableSystem={false}
      >
        <I18nProvider>
          <AuthProvider>{children}</AuthProvider>
        </I18nProvider>
        {/* 全局 Toast 容器 —— 用 NextUI 的 content1/foreground 让暗色模式跟随主题 */}
        <Toaster
          position="top-right"
          toastOptions={{
            className: "!bg-content1 !text-foreground",
          }}
        />
      </NextThemesProvider>
    </NextUIProvider>
  );
}
