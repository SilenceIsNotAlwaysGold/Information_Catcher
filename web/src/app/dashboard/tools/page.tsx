"use client";

/**
 * 仿写床 · 二级首页
 *
 * 把"商品图（自创）/ 整体仿写 / 文案换背景" 三个原本散落在 Sidebar "工具" 组的
 * 仿写工具统一收口；都是基于 AI 改造别人爆款内容的常见动作。
 */
import Link from "next/link";
import { Wand2, Wand, Type, ArrowRight, Coins, PenLine } from "lucide-react";
import { PageHeader } from "@/components/ui";

const TOOLS = [
  {
    key: "product-remix", label: "整体仿写", icon: Wand,
    href: "/dashboard/tools/product-remix",
    desc: "抓爆款帖子的全部图文 → AI 整体重写出一份新内容（图、文案、标题）。",
    pricing: "remix · 按图扣 image 点 + 文案扣 text_remix",
  },
  {
    key: "text-remix", label: "文案换背景", icon: Type,
    href: "/dashboard/tools/text-remix",
    desc: "抠出原帖文案 + 自动重写 + 换个匹配的背景图，保留排版结构。",
    pricing: "text_remix_rewrite · 0.5 点 / 次",
  },
];

export default function RemixLandingPage() {
  return (
    <div className="p-6 space-y-8 max-w-page mx-auto">
      <PageHeader
        section="remix"
        icon={Wand2}
        title="仿写床"
        hint="基于他人已有爆款内容做改造：整套帖子重写、文案换背景。想从零原创请用 AI 工坊或原创板块。"
      />

      <div className="rounded-md border border-default-200 bg-default-50/50 dark:bg-default-100/20 p-3 text-xs text-default-600 flex items-start gap-2">
        <PenLine size={14} className="text-original-600 dark:text-original-500 shrink-0 mt-0.5" />
        <div>
          想自己写一段底稿让 AI 按平台风格改写？去
          <Link href="/dashboard/original" className="text-original-600 hover:underline mx-1">原创板块</Link>。
          想纯 AI 出商品 / 场景图？去
          <Link href="/dashboard/tools/product-image" className="text-studio-600 hover:underline mx-1">AI 工坊 · AI 生图</Link>。
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <Link key={t.key} href={t.href}>
              <div className="group h-full rounded-xl border border-default-200/60 bg-content1 p-5 shadow-card hover:shadow-card-hover transition-all hover:-translate-y-0.5">
                <div className="flex items-start justify-between mb-3">
                  <div className="inline-flex p-2.5 rounded-lg bg-remix-100 text-remix-600 dark:bg-remix-900/30 dark:text-remix-500">
                    <Icon size={20} />
                  </div>
                  <ArrowRight size={16} className="text-default-300 group-hover:text-remix-600 group-hover:translate-x-0.5 transition-all mt-1" />
                </div>
                <h3 className="font-semibold mb-1">{t.label}</h3>
                <p className="text-xs text-default-500 leading-relaxed mb-3">{t.desc}</p>
                <div className="flex items-center gap-1 text-[11px] text-default-400">
                  <Coins size={10} />{t.pricing}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
