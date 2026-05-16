"use client";

/**
 * 工具箱 · 二级首页
 *
 * 实用辅助类工具的聚合页：
 *   - 服务监控（uptime-kuma 风格 HTTP/TCP 探活）
 *   - 浏览器扩展（TrendPulse Helper）
 *   - 数据导入（批量贴 URL）
 *   - 发布（待开发）
 *   - v2.2+ 计划：gotenberg / AI 音乐 / AI 视频
 */
import Link from "next/link";
import { Wrench, Activity, Puzzle, Upload, Send, ArrowRight, Music, FileType, Film } from "lucide-react";
import { PageHeader, SectionCard, WipBadge } from "@/components/ui";
import { Chip } from "@nextui-org/chip";

const TOOLS = [
  { key: "uptime",    label: "服务监控", icon: Activity, href: "/dashboard/toolbox/uptime",
    desc: "HTTP / TCP 探活，连续失败时飞书推送。复用 uptime-kuma 思路。" },
  { key: "extension", label: "浏览器扩展", icon: Puzzle, href: "/dashboard/extension",
    desc: "TrendPulse Helper：从浏览器抓帖子、博主主页、热门关键词。" },
  { key: "import",    label: "数据导入", icon: Upload, href: "/dashboard/import",
    desc: "批量粘贴链接入库；也支持从博主主页一键导入全部作品。" },
  { key: "publish",   label: "发布", icon: Send, href: "/dashboard/publish",
    desc: "矩阵发布（v2.2 接入飞书 / 公众号 / 知乎）", wip: true },
];

const COMING = [
  { label: "文档转换",  icon: FileType, desc: "gotenberg：Office ↔ PDF、HTML → PDF" },
  { label: "AI 音乐",   icon: Music,    desc: "ace-step-ui：文本 → 音乐" },
  { label: "AI 视频",   icon: Film,     desc: "可灵 / SVD API：图 → 视频" },
];

export default function ToolboxLandingPage() {
  return (
    <div className="p-6 space-y-8 max-w-page mx-auto">
      <PageHeader
        section="toolbox"
        icon={Wrench}
        title="工具箱"
        hint="服务监控、浏览器扩展、数据导入等实用辅助工具。"
      />

      <section>
        <h2 className="text-sm font-medium text-default-500 mb-3 uppercase tracking-wide">已上线</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <Link key={t.key} href={t.href}>
                <div className="group h-full rounded-xl border border-default-200/60 bg-content1 p-5 shadow-card hover:shadow-card-hover transition-all hover:-translate-y-0.5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="inline-flex p-2.5 rounded-lg bg-toolbox-100 text-toolbox-600 dark:bg-toolbox-900/30 dark:text-toolbox-500">
                      <Icon size={20} />
                    </div>
                    <ArrowRight size={16} className="text-default-300 group-hover:text-toolbox-600 group-hover:translate-x-0.5 transition-all mt-1" />
                  </div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold">{t.label}</h3>
                    {t.wip && <WipBadge />}
                  </div>
                  <p className="text-xs text-default-500 leading-relaxed">{t.desc}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-default-500 mb-3 uppercase tracking-wide">规划中（v2.2+）</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {COMING.map((c) => {
            const Icon = c.icon;
            return (
              <div key={c.label} className="rounded-xl border border-dashed border-default-300 p-5 opacity-70">
                <div className="inline-flex p-2 rounded-lg bg-default-100 text-default-500 mb-2">
                  <Icon size={18} />
                </div>
                <h3 className="font-medium text-sm">{c.label}</h3>
                <p className="text-xs text-default-500 mt-1">{c.desc}</p>
                <Chip size="sm" variant="flat" className="mt-2">需起外部 docker 服务</Chip>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
