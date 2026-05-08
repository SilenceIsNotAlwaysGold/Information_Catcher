"use client";

/**
 * /dashboard/admin/accounts —— 账号管理（admin only）
 *
 * 共享池中的所有平台 cookie 账号。包含 QR 登录（小红书）+ 手动录入（抖音/公众号）。
 */
import { Card, CardBody } from "@nextui-org/card";
import { AlertCircle, Server } from "lucide-react";
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
        </h1>
        <p className="text-sm text-default-500 mt-1">
          共享 cookie 池。所有用户的监控 / 热门抓取轮询使用这里的账号。
        </p>
      </div>

      <AccountsManagementCard token={token} />
    </div>
  );
}
