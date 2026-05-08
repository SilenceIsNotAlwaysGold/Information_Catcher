"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Card, CardBody } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import {
  Activity,
  Bell,
  RefreshCw,
  Users,
  ShieldCheck,
  TrendingUp,
  Inbox,
  Heart,
  Bookmark,
  MessageCircle,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { UpdateNoticeBanner } from "@/components/UpdateNoticeBanner";
import { CardSkeleton } from "@/components/CardSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { OnboardingCard } from "@/components/OnboardingCard";
import { toastOk, toastErr } from "@/lib/toast";

// ── Types ───────────────────────────────────────────────────────────────────

type AlertItem = {
  id: number;
  note_id: string;
  title: string | null;
  alert_type: string;
  message: string | null;
  created_at: string;
};

type FetchItem = {
  platform: string;
  fetch_type: string;
  status: "success" | "fail";
  ok_count: number;
  fail_count: number;
  started_at: string;
  note_id?: string;
};

type Overview = {
  today_alerts: {
    total: number;
    by_type: { surge: number; comment: number; trending: number };
    top: AlertItem[];
  };
  recent_fetches: FetchItem[];
  quota: {
    accounts: { total: number; valid: number; expired: number };
    posts: { total: number; by_platform: Record<string, number> };
    creators: number;
    lives: number;
  };
  metric_totals: { likes: number; collects: number; comments: number };
};

const OVERVIEW_URL = "/api/monitor/dashboard/overview";

// ── Helpers ─────────────────────────────────────────────────────────────────

const fmtTime = (s: string) => (s ? s.slice(5, 16) : "");

const PLATFORM_LABEL: Record<string, string> = {
  xhs: "小红书",
  douyin: "抖音",
  mp: "公众号",
};
const PLATFORM_COLOR: Record<string, "danger" | "default" | "success" | "primary" | "warning" | "secondary"> = {
  xhs: "danger",
  douyin: "default",
  mp: "success",
};

const ALERT_LABEL: Record<string, string> = {
  surge: "飙升",
  comment: "评论",
  trending: "热门",
};
const ALERT_COLOR: Record<string, "warning" | "primary" | "secondary"> = {
  surge: "warning",
  comment: "primary",
  trending: "secondary",
};

const classifyAlert = (t: string): "surge" | "comment" | "trending" => {
  const x = (t || "").toLowerCase();
  if (x.startsWith("trending")) return "trending";
  if (x.startsWith("comment")) return "comment";
  return "surge";
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { token, user } = useAuth();
  const [checking, setChecking] = useState(false);

  const fetcher = async ([url, t]: [string, string | null]) => {
    const res = await fetch(url, {
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json() as Promise<Overview>;
  };

  const { data, error, isLoading, mutate } = useSWR<Overview>(
    token ? [OVERVIEW_URL, token] : null,
    fetcher,
    { dedupingInterval: 5000, revalidateOnFocus: false }
  );

  const handleCheck = async () => {
    if (!token) return;
    setChecking(true);
    try {
      const res = await fetch("/api/monitor/check", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      toastOk("检测任务已触发，稍后会刷新数据");
      // 后台异步抓取，3.5s 后再 revalidate 一次
      setTimeout(() => { mutate(); }, 3500);
    } catch (e: any) {
      toastErr(`触发失败：${e?.message || e}`);
    } finally {
      setChecking(false);
    }
  };

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "凌晨好";
    if (h < 12) return "早上好";
    if (h < 14) return "中午好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();
  const username = (user as any)?.username || "";

  // ── Loading ──
  if (isLoading || (!data && !error)) {
    return (
      <div className="p-6 space-y-6 max-w-6xl">
        <UpdateNoticeBanner />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">运营概览</h1>
            <p className="text-sm text-default-500 mt-0.5">加载中...</p>
          </div>
        </div>
        <CardSkeleton cards={4} cols={4} />
        <CardSkeleton cards={3} cols={3} />
      </div>
    );
  }

  // ── Error ──
  if (error || !data) {
    return (
      <div className="p-6 space-y-6 max-w-6xl">
        <UpdateNoticeBanner />
        <Card className="border border-divider">
          <CardBody>
            <EmptyState
              icon={AlertTriangle}
              title="加载概览失败"
              hint="检查后端服务或刷新页面再试一次。"
              action={
                <Button size="sm" variant="flat" onPress={() => mutate()}>
                  重试
                </Button>
              }
            />
          </CardBody>
        </Card>
      </div>
    );
  }

  const {
    today_alerts,
    recent_fetches,
    quota,
  } = data;

  const postsTotal = quota.posts.total || 0;
  const platformBars = (["xhs", "douyin", "mp"] as const).map((k) => ({
    key: k,
    label: PLATFORM_LABEL[k],
    color: PLATFORM_COLOR[k],
    count: quota.posts.by_platform[k] || 0,
    pct: postsTotal > 0 ? Math.round(((quota.posts.by_platform[k] || 0) * 100) / postsTotal) : 0,
  }));

  // ── 4 张大卡 ──
  const stats = [
    {
      label: "监控帖子",
      value: postsTotal,
      icon: <Activity size={18} />,
      color: "text-primary",
      href: "/dashboard/monitor",
    },
    {
      label: "有效账号",
      value: `${quota.accounts.valid} / ${quota.accounts.total}`,
      icon: <ShieldCheck size={18} />,
      color: "text-success",
      hint: quota.accounts.expired > 0 ? `${quota.accounts.expired} 个已过期` : undefined,
      href: "/dashboard/admin/accounts",
    },
    {
      label: "订阅创作者",
      value: quota.creators,
      icon: <Users size={18} />,
      color: "text-secondary",
      href: "/dashboard/xhs/creators",
    },
    {
      label: "今日告警",
      value: today_alerts.total,
      icon: <Bell size={18} />,
      color: "text-warning",
      href: "/dashboard/monitor/history",
    },
  ];

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <UpdateNoticeBanner />

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {greeting}{username ? `，${username}` : ""}
          </h1>
          <p className="text-sm text-default-500 mt-0.5">
            今日告警 {today_alerts.total} 条 · 累计监控 {postsTotal} 条帖子
          </p>
        </div>
        <Button
          size="sm"
          color="primary"
          variant="flat"
          startContent={<RefreshCw size={15} className={checking ? "animate-spin" : ""} />}
          onPress={handleCheck}
          isLoading={checking}
        >
          立即检测
        </Button>
      </div>

      {/* Onboarding（三步未全部完成时显示） */}
      <OnboardingCard token={token} postsTotal={postsTotal} />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="block">
            <Card className="border border-divider hover:border-primary-300 transition-colors">
              <CardBody className="py-4 px-5">
                <div className={`mb-2 ${s.color}`}>{s.icon}</div>
                <div className="text-2xl font-bold">{s.value}</div>
                <div className="text-xs text-default-400 mt-0.5">{s.label}</div>
                {s.hint && (
                  <div className="text-[11px] text-warning mt-1">{s.hint}</div>
                )}
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>

      {/* 3 columns: alerts / fetches / quota */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 今日告警 Top 5 */}
        <Card className="border border-divider">
          <CardBody className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm flex items-center gap-1.5">
                <Bell size={15} className="text-warning" /> 今日告警
                {today_alerts.total > 0 && (
                  <Chip size="sm" color="warning" variant="flat">
                    {today_alerts.total}
                  </Chip>
                )}
              </h2>
              <Link
                href="/dashboard/monitor/history"
                className="text-xs text-primary hover:underline"
              >
                全部
              </Link>
            </div>
            {today_alerts.top.length === 0 ? (
              <EmptyState
                icon={Bell}
                title="今日暂无告警"
                hint="阈值触发时会在这里实时出现。"
              />
            ) : (
              <ul className="space-y-2">
                {today_alerts.top.slice(0, 5).map((a) => {
                  const cls = classifyAlert(a.alert_type);
                  return (
                    <li
                      key={a.id}
                      className="flex flex-col gap-1 p-2.5 rounded-lg border border-divider hover:bg-default-50"
                    >
                      <div className="flex items-center gap-2">
                        <Chip size="sm" color={ALERT_COLOR[cls]} variant="flat">
                          {ALERT_LABEL[cls]}
                        </Chip>
                        <span className="text-xs font-medium truncate flex-1">
                          {a.title || a.note_id}
                        </span>
                        <span className="text-[11px] text-default-300 shrink-0">
                          {fmtTime(a.created_at)}
                        </span>
                      </div>
                      {a.message && (
                        <p className="text-[11px] text-default-500 truncate">
                          {a.message}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* 最近抓取 Top 5 */}
        <Card className="border border-divider">
          <CardBody className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm flex items-center gap-1.5">
                <Zap size={15} className="text-primary" /> 最近抓取
              </h2>
            </div>
            {recent_fetches.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="暂无抓取记录"
                hint="点击上方「立即检测」触发一次。"
              />
            ) : (
              <ul className="space-y-2">
                {recent_fetches.slice(0, 5).map((r, i) => (
                  <li
                    key={`${r.started_at}-${i}`}
                    className="flex items-center gap-2 p-2.5 rounded-lg border border-divider"
                  >
                    <Chip
                      size="sm"
                      color={PLATFORM_COLOR[r.platform] || "default"}
                      variant="flat"
                    >
                      {PLATFORM_LABEL[r.platform] || r.platform || "?"}
                    </Chip>
                    <span className="text-xs text-default-600 truncate flex-1">
                      {r.fetch_type || "—"}
                    </span>
                    <Chip
                      size="sm"
                      variant="dot"
                      color={r.status === "success" ? "success" : "danger"}
                    >
                      {r.status === "success" ? "成功" : "失败"}
                    </Chip>
                    <span className="text-[11px] text-default-300 shrink-0 hidden lg:inline">
                      {fmtTime(r.started_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* 配额状态：三平台帖子分布 */}
        <Card className="border border-divider">
          <CardBody className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm flex items-center gap-1.5">
                <TrendingUp size={15} className="text-secondary" /> 配额状态
              </h2>
              <span className="text-xs text-default-400">
                共 {postsTotal} 条
              </span>
            </div>

            {postsTotal === 0 ? (
              <EmptyState
                icon={Activity}
                title="暂无监控帖子"
                hint="去监控页添加要追踪的笔记或视频。"
                action={
                  <Button
                    size="sm"
                    as={Link}
                    href="/dashboard/monitor"
                    color="primary"
                    variant="flat"
                  >
                    去添加
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {platformBars.map((b) => (
                  <div key={b.key} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{b.label}</span>
                      <span className="text-default-400">
                        {b.count} ({b.pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-default-100 overflow-hidden">
                      <div
                        className={
                          b.color === "danger"
                            ? "h-full bg-danger"
                            : b.color === "success"
                              ? "h-full bg-success"
                              : "h-full bg-default-400"
                        }
                        style={{ width: `${b.pct}%` }}
                      />
                    </div>
                  </div>
                ))}

                <div className="pt-2 border-t border-divider grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[11px] text-default-400 flex items-center justify-center gap-1">
                      <Heart size={10} /> 点赞
                    </div>
                    <div className="text-sm font-semibold">
                      {data.metric_totals.likes.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-default-400 flex items-center justify-center gap-1">
                      <Bookmark size={10} /> 收藏
                    </div>
                    <div className="text-sm font-semibold">
                      {data.metric_totals.collects.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-default-400 flex items-center justify-center gap-1">
                      <MessageCircle size={10} /> 评论
                    </div>
                    <div className="text-sm font-semibold">
                      {data.metric_totals.comments.toLocaleString()}
                    </div>
                  </div>
                </div>

                {quota.lives > 0 && (
                  <div className="pt-1 text-[11px] text-default-500">
                    直播订阅：{quota.lives} 个
                  </div>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
