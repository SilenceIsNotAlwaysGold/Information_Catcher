"use client";

/**
 * AI 工坊 · 二级首页
 *
 * 提供：
 *   - 4 个工坊入口大卡（漫画 / 小说 / 旅游 / PPT），点开进具体页
 *   - 用户余额一目了然 + 不足提示
 *   - 我的最近作品快览（聚合各工坊最近 3 个项目）—— 用 SWR 拉每个 list 接口（轻量）
 */
import Link from "next/link";
import useSWR from "swr";
import {
  Sparkles, BookOpen, FileText, Presentation, Plane, ImagePlus,
  Coins, ArrowRight, Clock,
} from "lucide-react";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, SectionCard, StatTile, EmptyState } from "@/components/ui";

type StudioId = "comic" | "novel" | "travel" | "ppt" | "image";

const STUDIOS: Array<{
  id: StudioId; label: string; icon: any; href: string;
  desc: string; feature: string; pricing: string;
}> = [
  {
    id: "comic", label: "AI 漫画", icon: BookOpen, href: "/dashboard/studio/comic",
    desc: "对话引导写故事 → 拆分镜 → 逐格生图。可关联小说一键转分镜。",
    feature: "对话→分镜→生图", pricing: "story 0.5 · panel 0.5+image",
  },
  {
    id: "novel", label: "AI 小说", icon: FileText, href: "/dashboard/studio/novel",
    desc: "卷 / 章 / 角色卡 / 世界观 / 伏笔 / 工作流，专业网文创作。",
    feature: "outline 0.5 · chapter 1.0", pricing: "按章扣点",
  },
  {
    id: "travel", label: "AI 旅游攻略", icon: Plane, href: "/dashboard/studio/travel",
    desc: "一段描述生成完整旅游攻略：行程、住宿、餐饮、贴士。",
    feature: "travel_plan 0.5", pricing: "一次生成一次扣",
  },
  {
    id: "ppt", label: "AI PPT", icon: Presentation, href: "/dashboard/studio/ppt",
    desc: "主题 → 大纲 → python-pptx 渲染。支持模板、6 种布局、Pexels / AI 配图。",
    feature: "ppt_outline 1.0", pricing: "一次大纲覆盖全套",
  },
  {
    id: "image", label: "AI 生图", icon: ImagePlus, href: "/dashboard/tools/product-image",
    desc: "填商品 / 场景信息 + AI 生成 prompt，一次出 1-4 张图。可上传参考图。",
    feature: "product_image 1.0", pricing: "按张扣 image 点",
  },
];

const fetcher = async ([u, t]: [string, string | null]) => {
  const r = await fetch(u, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export default function StudioLandingPage() {
  const { token } = useAuth();
  const { data: billing } = useSWR<{ balance: number }>(
    token ? ["/api/billing/me", token] : null, fetcher,
    { refreshInterval: 30_000 },
  );
  // 拉一下 PPT 列表作"我的最近"代表（其他工坊后续也可以聚）
  const { data: pptList } = useSWR<{ projects: Array<{ id: number; title: string; topic: string; status: string; updated_at: string }> }>(
    token ? ["/api/studio/ppt/projects", token] : null, fetcher,
    { dedupingInterval: 30_000 },
  );

  const balance = billing?.balance;
  const balanceLow = balance !== undefined && balance < 5;

  return (
    <div className="p-6 space-y-8 max-w-page mx-auto">
      <PageHeader
        section="studio"
        icon={Sparkles}
        title="AI 工坊"
        hint="用 AI 把想法变成完整内容。所有调用走平台模型，按点数扣费。"
        actions={
          <Chip
            startContent={<Coins size={12} className="ml-1" />}
            color={balance === undefined ? "default" : balanceLow ? "warning" : "default"}
            variant="flat" size="md"
          >
            余额 {balance !== undefined ? balance.toFixed(2) : "—"}
          </Chip>
        }
      />

      {balanceLow && (
        <div className="rounded-xl border-l-4 border-warning bg-warning-50/50 dark:bg-warning-900/10 p-4 flex items-start gap-3">
          <Coins className="text-warning shrink-0 mt-0.5" size={18} />
          <div className="flex-1">
            <p className="font-medium text-sm">点数不多了（{balance?.toFixed(2)}）</p>
            <p className="text-xs text-default-500 mt-0.5">联系管理员充值；每月 1 号会按你的套餐自动赠送。</p>
          </div>
          <Button as={Link} href="/dashboard/profile" size="sm" variant="flat" color="warning">查看余额</Button>
        </div>
      )}

      {/* 5 个工坊大卡 */}
      <section>
        <h2 className="text-sm font-medium text-default-500 mb-3 uppercase tracking-wide">所有工坊</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {STUDIOS.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.id} href={s.href}>
                <div className="group h-full rounded-xl border border-default-200/60 bg-content1 p-5 shadow-card hover:shadow-card-hover transition-all hover:-translate-y-0.5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="inline-flex p-2.5 rounded-lg bg-studio-100 text-studio-600 dark:bg-studio-900/30 dark:text-studio-500">
                      <Icon size={22} />
                    </div>
                    <ArrowRight size={16} className="text-default-300 group-hover:text-studio-600 group-hover:translate-x-0.5 transition-all mt-1" />
                  </div>
                  <h3 className="font-semibold text-lg mb-1">{s.label}</h3>
                  <p className="text-xs text-default-500 leading-relaxed mb-3">{s.desc}</p>
                  <div className="flex items-center gap-1.5 text-[11px] text-default-400">
                    <Coins size={10} />
                    <span>{s.feature}</span>
                    <span className="text-default-300">·</span>
                    <span>{s.pricing}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* 我的 PPT 最近 3 个 */}
      <SectionCard
        icon={Presentation}
        title="最近的 PPT"
        actions={
          <Link href="/dashboard/studio/ppt" className="text-xs text-primary hover:underline">全部 →</Link>
        }
      >
        {!pptList?.projects?.length ? (
          <EmptyState
            icon={Presentation} compact
            title="还没有 PPT 项目"
            hint="去 AI PPT 工坊创建第一份"
            action={<Button as={Link} href="/dashboard/studio/ppt" size="sm" color="primary" variant="flat">新建 PPT</Button>}
          />
        ) : (
          <ul className="space-y-1.5">
            {pptList.projects.slice(0, 3).map((p) => (
              <li key={p.id}>
                <Link href={`/dashboard/studio/ppt`} className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-default-50 dark:hover:bg-default-100/30">
                  <Presentation size={14} className="text-studio-500 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{p.title || p.topic}</p>
                    <p className="text-[11px] text-default-400 truncate">{p.topic}</p>
                  </div>
                  <Chip size="sm" variant="flat" className="shrink-0">{p.status}</Chip>
                  <span className="text-xs text-default-400 shrink-0 hidden md:inline">
                    <Clock size={10} className="inline mr-0.5" />{p.updated_at?.slice(5, 16)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
