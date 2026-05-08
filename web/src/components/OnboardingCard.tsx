"use client";

/**
 * Onboarding 引导卡片
 *
 * 在 dashboard 首页显示「开始使用三步走」：
 *   1. 绑定飞书（自动建群 + 多维表格）
 *   2. 配置热门关键词
 *   3. 添加第一条监控帖子
 *
 * 三步全部满足时整个卡片隐藏。
 */
import useSWR from "swr";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import { Button } from "@nextui-org/button";
import { CheckCircle2, Circle, ArrowRight, Rocket } from "lucide-react";

type Props = {
  token: string | null;
  postsTotal: number;
};

const fetcher = (token: string | null) => async (url: string) => {
  const r = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function OnboardingCard({ token, postsTotal }: Props) {
  const { data: feishu } = useSWR(
    token ? "/api/feishu/status" : null, fetcher(token),
    { revalidateOnFocus: false },
  );
  const { data: settings } = useSWR(
    token ? "/api/monitor/settings" : null, fetcher(token),
    { revalidateOnFocus: false },
  );

  if (!feishu || !settings) return null;

  const feishuBound = !!feishu.bound;
  const trendingConfigured = !!(settings.trending_keywords || "").trim();
  const hasPosts = postsTotal > 0;

  const allDone = feishuBound && trendingConfigured && hasPosts;
  if (allDone) return null;

  const steps: Array<{
    done: boolean;
    title: string;
    desc: string;
    href: string;
    cta: string;
  }> = [
    {
      done: feishuBound,
      title: "绑定飞书",
      desc: "扫码授权后自动建群 + 多维表格，告警直接推到群里。",
      href: "/dashboard/profile",
      cta: "去绑定",
    },
    {
      done: trendingConfigured,
      title: "配置热门关键词",
      desc: "选你关心的话题，系统每 30 分钟抓一次新内容。",
      href: "/dashboard/xhs/trending",
      cta: "去设置",
    },
    {
      done: hasPosts,
      title: "添加监控帖子",
      desc: "粘贴小红书 / 抖音 / 公众号链接，开始追踪它的点赞收藏评论。",
      href: "/dashboard/xhs/posts",
      cta: "去添加",
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;

  return (
    <Card className="border border-primary/30 bg-primary/5">
      <CardHeader className="flex items-start gap-3 pb-2">
        <div className="rounded-xl bg-primary/15 text-primary p-2.5">
          <Rocket size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold">开始使用 Pulse</h3>
            <Chip size="sm" variant="flat" color="primary">
              {completedCount}/{steps.length} 已完成
            </Chip>
          </div>
          <p className="text-xs text-default-500 mt-0.5">
            完成下面三步后整个引导会自动消失。
          </p>
        </div>
      </CardHeader>
      <CardBody className="space-y-2 pt-1">
        {steps.map((step) => (
          <div
            key={step.title}
            className={`flex items-center gap-3 rounded-lg p-3 ${
              step.done
                ? "bg-success/5 border border-success/20"
                : "bg-content1 border border-divider"
            }`}
          >
            {step.done ? (
              <CheckCircle2 size={18} className="text-success shrink-0" />
            ) : (
              <Circle size={18} className="text-default-300 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${step.done ? "text-default-500 line-through" : ""}`}>
                {step.title}
              </p>
              {!step.done && (
                <p className="text-xs text-default-500 mt-0.5">{step.desc}</p>
              )}
            </div>
            {!step.done && (
              <Button
                size="sm"
                color="primary"
                variant="flat"
                as={Link}
                href={step.href}
                endContent={<ArrowRight size={13} />}
              >
                {step.cta}
              </Button>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
