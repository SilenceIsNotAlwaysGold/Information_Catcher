"use client";

/**
 * /dashboard/admin/accounts —— 账号管理（admin only）
 *
 * 共享池中的所有平台 cookie 账号。包含 QR 登录（小红书）+ 手动录入（抖音/公众号）。
 */
import { Card, CardBody } from "@nextui-org/card";
import { AlertCircle, Server, Puzzle, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import { AccountsManagementCard } from "@/components/admin/AccountsManagementCard";

export default function AdminAccountsPage() {
  const { token } = useAuth();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";

  if (!isAdmin && me) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardBody className="flex flex-row gap-2 items-center text-sm text-warning">
            <AlertCircle size={16} /> 仅管理员可访问
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Server size={22} />
          账号管理
          <span className="text-tiny font-normal px-2 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
            已弃用
          </span>
        </h1>
        <p className="text-sm text-default-500 mt-1">
          历史 cookie 账号池。从 v0.7 起 TrendPulse 已全面切换到浏览器扩展通道。
        </p>
      </div>

      {/* 弃用迁移引导 */}
      <Card className="bg-warning/5 border-warning/20">
        <CardBody className="space-y-3">
          <div className="flex items-start gap-3">
            <Puzzle className="text-warning flex-shrink-0 mt-0.5" size={20} />
            <div className="space-y-2 text-sm">
              <div className="font-semibold text-default-900">
                TrendPulse 现已通过浏览器扩展跑所有抓取任务，无需在此录入 cookie
              </div>
              <ul className="list-disc pl-5 space-y-1 text-default-700">
                <li><strong>关键词热门搜索</strong>、<strong>博主追新</strong>、<strong>评论拉取</strong>、<strong>直播状态</strong> ——
                  全部通过 TrendPulse Helper 浏览器扩展，使用你已登录的浏览器执行</li>
                <li>不再有封号风险（用的是用户自己日常的浏览器和 IP）</li>
                <li>不再需要扫码 / 录入 cookie / 配置代理</li>
              </ul>
              <Link
                href="/dashboard/extension"
                className="inline-flex items-center gap-1 text-primary font-medium underline mt-1"
              >
                前往「我的浏览器扩展」安装与配置 <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* 老的 cookie 账号管理仍然可用，但不再驱动主要业务流程 */}
      <div className="text-tiny text-default-500 italic">
        以下账号列表仅作历史保留 / 兼容老数据使用。新增账号、cookie 健康检查等功能已停止维护。
      </div>
      <AccountsManagementCard token={token} />
    </div>
  );
}
