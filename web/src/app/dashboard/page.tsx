"use client";

/**
 * Dashboard 概览页 v2 — 五大板块入口为骨架。
 *
 * 视觉分层：
 *   1. 顶部：欢迎语 + 余额 + 立即检测按钮
 *   2. 四大板块大入口卡（监控 / AI 工坊 / 仿写床 / 工具箱），点开进二级首页
 *   3. 关键指标 StatTile × 4（监控帖子 / 订阅博主 / 今日告警 / 累计点赞）
 *   4. 双栏：今日告警 Top 5  ‖  最近抓取 Top 5
 *   5. 平台监控分布 MetricBar（只显示 v2 留存平台 xhs/douyin）
 */
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import {
  Activity, Bell, RefreshCw, Users, Zap, AlertTriangle,
  Heart, Bookmark, MessageCircle, ArrowRight, Coins,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { CardSkeleton } from "@/components/CardSkeleton";
import { OnboardingCard } from "@/components/OnboardingCard";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader, SectionCard, StatTile, EmptyState, MetricBar } from "@/components/ui";
import { SECTIONS, SECTION_ORDER } from "@/lib/sections";

type AlertItem = {
  id: number; note_id: string; title: string | null;
  alert_type: string; message: string | null; created_at: string;
};
type FetchItem = {
  platform: string; fetch_type: string;
  status: "success" | "fail"; ok_count: number; fail_count: number;
  started_at: string; note_id?: string;
};
type Overview = {
  today_alerts: { total: number; by_type: { surge: number; comment: number; trending: number }; top: AlertItem[] };
  recent_fetches: FetchItem[];
  quota: { accounts: { total: number; valid: number; expired: number };
           posts: { total: number; by_platform: Record<string, number> };
           creators: number };
  metric_totals: { likes: number; collects: number; comments: number };
};

const OVERVIEW_URL = "/api/monitor/dashboard/overview";

const fmtTime = (s: string) => (s ? s.slice(5, 16) : "");
const PLATFORM_LABEL: Record<string, string> = { xhs: "小红书", douyin: "抖音", mp: "公众号" };

const ALERT_LABEL: Record<string, string> = { surge: "飙升", comment: "评论", trending: "热门" };
const ALERT_COLOR: Record<string, "warning" | "primary" | "secondary"> = {
  surge: "warning", comment: "primary", trending: "secondary",
};
const classifyAlert = (t: string): "surge" | "comment" | "trending" => {
  const x = (t || "").toLowerCase();
  if (x.startsWith("trending")) return "trending";
  if (x.startsWith("comment")) return "comment";
  return "surge";
};

export default function DashboardPage() {
  const { token, user } = useAuth();
  const [checking, setChecking] = useState(false);

  const fetcher = async ([url, t]: [string, string | null]) => {
    const r = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json() as Promise<Overview>;
  };
  const { data, error, isLoading, mutate } = useSWR<Overview>(
    token ? [OVERVIEW_URL, token] : null, fetcher,
    { dedupingInterval: 5000, revalidateOnFocus: false },
  );

  const { data: billing } = useSWR<{ balance: number }>(
    token ? ["/api/billing/me", token] : null,
    fetcher as any,
    { refreshInterval: 30_000 },
  );

  const handleCheck = async () => {
    if (!token) return;
    setChecking(true);
    try {
      const r = await fetch("/api/monitor/check", {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(String(r.status));
      toastOk("检测任务已触发，稍后会刷新数据");
      setTimeout(() => { mutate(); }, 3500);
    } catch (e: any) {
      toastErr(`触发失败：${e?.message || e}`);
    } finally { setChecking(false); }
  };

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "凌晨好"; if (h < 12) return "早上好";
    if (h < 14) return "中午好"; if (h < 18) return "下午好";
    return "晚上好";
  })();
  const username = (user as any)?.username || "";

  if (isLoading || (!data && !error)) {
    return (
      <div className="p-6 space-y-6 max-w-page mx-auto">
        <PageHeader title="加载中…" hint="正在拉取概览数据" />
        <CardSkeleton cards={4} cols={4} />
        <CardSkeleton cards={3} cols={3} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-page mx-auto">
        <SectionCard>
          <EmptyState
            icon={AlertTriangle}
            title="加载概览失败"
            hint="检查后端服务或刷新页面再试一次。"
            action={<Button size="sm" variant="flat" onPress={() => mutate()}>重试</Button>}
          />
        </SectionCard>
      </div>
    );
  }

  const { today_alerts, recent_fetches, quota, metric_totals } = data;
  const postsTotal = quota.posts.total || 0;
  // v2 只留 xhs + douyin（公众号砍掉，不再展示进度条）
  const platformBars = (["xhs", "douyin"] as const).map((k) => ({
    label: PLATFORM_LABEL[k],
    value: quota.posts.by_platform[k] || 0,
    section: "monitor" as const,
  }));

  return (
    <div className="p-6 space-y-8 max-w-page mx-auto">
      <PageHeader
        title={`${greeting}${username ? `，${username}` : ""}`}
        hint={`今日告警 ${today_alerts.total} 条 · 累计监控 ${postsTotal} 条帖子`}
        actions={
          <>
            <Chip
              startContent={<Coins size={12} className="ml-1" />}
              variant="flat" color="default" size="md"
              className="hidden md:inline-flex"
            >
              余额 {billing?.balance !== undefined ? billing.balance.toFixed(2) : "—"}
            </Chip>
            <Button
              size="sm" color="primary" variant="flat"
              startContent={<RefreshCw size={15} className={checking ? "animate-spin" : ""} />}
              onPress={handleCheck} isLoading={checking}
            >
              立即检测
            </Button>
          </>
        }
      />

      <OnboardingCard token={token} postsTotal={postsTotal} />

      {/* 五大板块入口 */}
      <section>
        <h2 className="text-sm font-medium text-default-500 mb-3 uppercase tracking-wide">板块入口</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {SECTION_ORDER.map((key) => {
            const sec = SECTIONS[key];
            const Icon = sec.icon;
            return (
              <Link key={key} href={sec.href}>
                <div className={`group relative rounded-xl border border-default-200/60 bg-content1 p-5 shadow-card hover:shadow-card-hover transition-all hover:-translate-y-0.5 h-full`}>
                  <div className={`inline-flex p-2.5 rounded-lg mb-3 bg-${sec.color}-100 text-${sec.color}-600 dark:bg-${sec.color}-900/30 dark:text-${sec.color}-500`}>
                    <Icon size={20} />
                  </div>
                  <h3 className="font-semibold text-foreground flex items-center gap-1 mb-1">
                    {sec.label}
                    <ArrowRight size={14} className="text-default-300 group-hover:text-default-600 transition-colors group-hover:translate-x-0.5 duration-150" />
                  </h3>
                  <p className="text-xs text-default-500 line-clamp-2">{sec.desc}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* 关键指标 4 个 */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="监控帖子" value={postsTotal} icon={Activity}
          section="monitor" href="/dashboard/monitor"
          hint={`xhs ${quota.posts.by_platform.xhs || 0} · douyin ${quota.posts.by_platform.douyin || 0}`}
        />
        <StatTile
          label="订阅博主" value={quota.creators} icon={Users}
          section="monitor" href="/dashboard/xhs/creators"
        />
        <StatTile
          label="今日告警" value={today_alerts.total} icon={Bell}
          section="hotnews" href="/dashboard/monitor/history"
          hint={`飙升 ${today_alerts.by_type.surge} · 评论 ${today_alerts.by_type.comment} · 热门 ${today_alerts.by_type.trending}`}
        />
        <StatTile
          label="累计互动" value={metric_totals.likes.toLocaleString()} icon={Heart}
          section="studio"
          hint={`收藏 ${metric_totals.collects.toLocaleString()} · 评论 ${metric_totals.comments.toLocaleString()}`}
        />
      </section>

      {/* 双栏：告警 + 抓取 */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          icon={Bell} title="今日告警"
          badge={today_alerts.total > 0 && (
            <Chip size="sm" color="warning" variant="flat">{today_alerts.total}</Chip>
          )}
          actions={
            <Link href="/dashboard/monitor/history" className="text-xs text-primary hover:underline">全部 →</Link>
          }
        >
          {today_alerts.top.length === 0 ? (
            <EmptyState icon={Bell} compact title="今日暂无告警" hint="阈值触发时会在这里实时出现。" />
          ) : (
            <ul className="space-y-2">
              {today_alerts.top.slice(0, 5).map((a) => {
                const cls = classifyAlert(a.alert_type);
                return (
                  <li key={a.id} className="flex flex-col gap-1 p-2.5 rounded-md hover:bg-default-50 dark:hover:bg-default-100/30 transition-colors">
                    <div className="flex items-center gap-2 min-w-0">
                      <Chip size="sm" color={ALERT_COLOR[cls]} variant="flat" className="shrink-0">
                        {ALERT_LABEL[cls]}
                      </Chip>
                      <span className="text-sm font-medium truncate flex-1">{a.title || a.note_id}</span>
                      <span className="text-xs text-default-400 shrink-0">{fmtTime(a.created_at)}</span>
                    </div>
                    {a.message && (
                      <p className="text-xs text-default-500 truncate pl-1">{a.message}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard icon={Zap} title="最近抓取">
          {recent_fetches.length === 0 ? (
            <EmptyState icon={Zap} compact title="暂无抓取记录" hint="点击上方「立即检测」触发一次。" />
          ) : (
            <ul className="space-y-1.5">
              {recent_fetches.slice(0, 5).map((r, i) => (
                <li key={`${r.started_at}-${i}`} className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-default-50 dark:hover:bg-default-100/30 transition-colors">
                  <Chip size="sm" variant="flat" className="shrink-0">
                    {PLATFORM_LABEL[r.platform] || r.platform || "?"}
                  </Chip>
                  <span className="text-sm text-default-700 truncate flex-1">{r.fetch_type || "—"}</span>
                  <Chip size="sm" variant="dot" color={r.status === "success" ? "success" : "danger"}>
                    {r.status === "success" ? "成功" : "失败"}
                  </Chip>
                  <span className="text-xs text-default-400 shrink-0 hidden lg:inline">{fmtTime(r.started_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </section>

      {/* 平台分布 */}
      <SectionCard icon={Activity} title="平台监控分布" hint={`共 ${postsTotal} 条监控中`}>
        {postsTotal === 0 ? (
          <EmptyState
            icon={Activity}
            title="暂无监控帖子"
            hint="去监控板块添加要追踪的笔记或视频。"
            action={<Button size="sm" as={Link} href="/dashboard/monitor" color="primary" variant="flat">去添加</Button>}
          />
        ) : (
          <MetricBar items={platformBars} total={postsTotal} unit="条" />
        )}
      </SectionCard>
    </div>
  );
}
