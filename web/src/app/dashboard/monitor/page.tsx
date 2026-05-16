"use client";

/**
 * 监控板块 · 二级首页
 *
 * 提供：
 *   - 当前监控帖子分布（xhs / douyin）
 *   - 平台 × 功能 矩阵卡（小红书 / 抖音 × 帖子 / 博主 / 热门）
 *   - 当日告警速览
 *
 * 老 URL `/dashboard/monitor` 之前 redirect 到 `/dashboard/xhs/posts`，
 * 现在改为真正的板块首页（重构后入口集中在 Sidebar 「监控」节点）。
 */
import Link from "next/link";
import useSWR from "swr";
import { Eye, FileText, Users, TrendingUp, ArrowRight, Bell } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, SectionCard, StatTile, MetricBar, EmptyState } from "@/components/ui";
import { Chip } from "@nextui-org/chip";

type Overview = {
  today_alerts: { total: number; top: Array<{ id: number; title: string | null; note_id: string; alert_type: string; created_at: string }> };
  quota: { posts: { total: number; by_platform: Record<string, number> }; creators: number };
};

const platforms = [
  { key: "xhs", label: "小红书", emoji: "🌸" },
  { key: "douyin", label: "抖音", emoji: "🎵" },
] as const;
const sections = [
  { key: "posts", label: "帖子监控", icon: FileText, hint: "追踪互动数据" },
  { key: "creators", label: "博主追新", icon: Users, hint: "新作品自动入库" },
  { key: "trending", label: "热门内容", icon: TrendingUp, hint: "按关键词搜热门" },
] as const;

export default function MonitorLandingPage() {
  const { token } = useAuth();
  const fetcher = async ([u, t]: [string, string | null]) => {
    const r = await fetch(u, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  };
  const { data } = useSWR<Overview>(
    token ? ["/api/monitor/dashboard/overview", token] : null, fetcher,
    { dedupingInterval: 5000 },
  );

  const postsTotal = data?.quota.posts.total || 0;
  const barItems = platforms.map((p) => ({
    label: p.label, value: data?.quota.posts.by_platform[p.key] || 0,
    section: "monitor" as const,
  }));

  return (
    <div className="p-6 space-y-8 max-w-page mx-auto">
      <PageHeader
        section="monitor"
        icon={Eye}
        title="监控"
        hint="追踪小红书 / 抖音的帖子、博主和热门内容；阈值告警自动推送到飞书。"
      />

      {/* 关键指标 */}
      <section className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatTile label="监控帖子总数" value={postsTotal} icon={FileText} section="monitor" />
        <StatTile label="订阅博主" value={data?.quota.creators || 0} icon={Users} section="monitor"
          href="/dashboard/xhs/creators" />
        <StatTile label="今日告警" value={data?.today_alerts.total || 0} icon={Bell} section="monitor"
          href="/dashboard/monitor/history" />
      </section>

      {/* 平台 × 功能矩阵 */}
      <section>
        <h2 className="text-sm font-medium text-default-500 mb-3 uppercase tracking-wide">平台入口</h2>
        <div className="space-y-4">
          {platforms.map((plat) => (
            <SectionCard
              key={plat.key}
              title={<span className="text-base">{plat.emoji} {plat.label}</span>}
              hint={`${data?.quota.posts.by_platform[plat.key] || 0} 条监控中`}
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {sections.map((s) => {
                  const Icon = s.icon;
                  return (
                    <Link key={s.key} href={`/dashboard/${plat.key}/${s.key}`}>
                      <div className="group p-4 rounded-lg border border-default-200/60 hover:border-monitor-400 dark:hover:border-monitor-500 hover:bg-monitor-50/50 dark:hover:bg-monitor-900/10 transition-all">
                        <div className="flex items-center gap-2 mb-1">
                          <Icon size={16} className="text-monitor-600 dark:text-monitor-500" />
                          <span className="font-medium text-sm">{s.label}</span>
                          <ArrowRight size={12} className="text-default-300 ml-auto group-hover:text-monitor-600 transition-colors" />
                        </div>
                        <p className="text-xs text-default-500">{s.hint}</p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </SectionCard>
          ))}
        </div>
      </section>

      {/* 平台分布 */}
      {postsTotal > 0 && (
        <SectionCard title="监控分布">
          <MetricBar items={barItems} total={postsTotal} unit="条" />
        </SectionCard>
      )}

      {/* 当日告警速览 */}
      <SectionCard
        icon={Bell}
        title="今日告警"
        actions={
          <Link href="/dashboard/monitor/history" className="text-xs text-primary hover:underline">全部 →</Link>
        }
      >
        {!data?.today_alerts.top.length ? (
          <EmptyState icon={Bell} compact title="今日暂无告警" />
        ) : (
          <ul className="space-y-1.5">
            {data.today_alerts.top.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-default-50 dark:hover:bg-default-100/30">
                <Chip size="sm" variant="flat" color="warning" className="shrink-0">{a.alert_type}</Chip>
                <span className="text-sm truncate flex-1">{a.title || a.note_id}</span>
                <span className="text-xs text-default-400 shrink-0">{a.created_at?.slice(5, 16)}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
