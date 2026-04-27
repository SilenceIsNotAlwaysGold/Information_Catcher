"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardBody, Button, Chip } from "@nextui-org/react";
import { Activity, Upload, Bell, RefreshCw, TrendingUp, MessageCircle, Heart, Bookmark } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const API = (p: string) => `/api/monitor${p}`;

type Post = {
  note_id: string;
  title: string;
  liked_count: number | null;
  collected_count: number | null;
  comment_count: number | null;
  checked_at: string | null;
};

type Alert = {
  id: number;
  title: string;
  note_id: string;
  alert_type: string;
  message: string;
  created_at: string;
};

export default function DashboardPage() {
  const { token } = useAuth();
  const h = { Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<Post[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const [p, a] = await Promise.all([
      fetch(API("/posts"), { headers: h }).then((r) => r.json()),
      fetch(API("/alerts?limit=10"), { headers: h }).then((r) => r.json()),
    ]);
    setPosts(p.posts ?? []);
    setAlerts(a.alerts ?? []);
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers: h });
    setTimeout(async () => { await load(); setChecking(false); }, 3500);
  };

  const totalLikes = posts.reduce((s, p) => s + (p.liked_count ?? 0), 0);
  const totalCollects = posts.reduce((s, p) => s + (p.collected_count ?? 0), 0);
  const totalComments = posts.reduce((s, p) => s + (p.comment_count ?? 0), 0);
  const todayAlerts = alerts.filter(a => a.created_at?.startsWith(new Date().toISOString().slice(0, 10)));

  if (loading) {
    return <div className="flex items-center justify-center h-full text-default-400 text-sm">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">概览</h1>
          <p className="text-sm text-default-500 mt-0.5">小红书帖子数据监控</p>
        </div>
        <Button size="sm" variant="flat"
          startContent={<RefreshCw size={15} className={checking ? "animate-spin" : ""} />}
          onPress={handleCheck} isLoading={checking}>
          立即检测
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "监控帖子", value: posts.length, icon: <Activity size={18} />, color: "text-primary" },
          { label: "总点赞", value: totalLikes.toLocaleString(), icon: <Heart size={18} />, color: "text-red-500" },
          { label: "总收藏", value: totalCollects.toLocaleString(), icon: <Bookmark size={18} />, color: "text-yellow-500" },
          { label: "总评论", value: totalComments.toLocaleString(), icon: <MessageCircle size={18} />, color: "text-blue-500" },
        ].map((s) => (
          <Card key={s.label} className="border border-divider">
            <CardBody className="py-4 px-5">
              <div className={`mb-2 ${s.color}`}>{s.icon}</div>
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-xs text-default-400 mt-0.5">{s.label}</div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Quick actions */}
      {posts.length === 0 && (
        <Card className="border border-dashed border-divider">
          <CardBody className="py-10 flex flex-col items-center gap-4 text-center">
            <span className="text-4xl">🌸</span>
            <div>
              <p className="font-medium">还没有监控任何帖子</p>
              <p className="text-sm text-default-400 mt-1">点击下方按钮开始导入你的小红书帖子链接</p>
            </div>
            <Button color="primary" as={Link} href="/dashboard/import" startContent={<Upload size={16} />}>
              导入帖子链接
            </Button>
          </CardBody>
        </Card>
      )}

      {/* Recent alerts */}
      {alerts.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2">
              <Bell size={16} /> 最近告警
              {todayAlerts.length > 0 && (
                <Chip size="sm" color="warning" variant="flat">{todayAlerts.length} 条今日</Chip>
              )}
            </h2>
            <Button size="sm" variant="light" as={Link} href="/dashboard/monitor">查看全部</Button>
          </div>
          <div className="space-y-2">
            {alerts.slice(0, 5).map((a) => (
              <div key={a.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-divider hover:bg-default-50 transition-colors">
                <Chip size="sm" color={a.alert_type === "surge" ? "warning" : "primary"} variant="flat">
                  {a.alert_type === "surge" ? "飙升" : "评论"}
                </Chip>
                <span className="text-sm font-medium truncate flex-1">{a.title || a.note_id}</span>
                <span className="text-xs text-default-400 shrink-0">{a.message}</span>
                <span className="text-xs text-default-300 shrink-0">{a.created_at?.slice(5, 16)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Post list preview */}
      {posts.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold flex items-center gap-2">
              <TrendingUp size={16} /> 监控帖子 ({posts.length})
            </h2>
            <Button size="sm" variant="light" as={Link} href="/dashboard/monitor">管理列表</Button>
          </div>
          <div className="space-y-2">
            {posts.slice(0, 5).map((p) => (
              <div key={p.note_id}
                className="flex items-center gap-4 p-3 rounded-lg border border-divider">
                <span className="text-sm font-medium truncate flex-1 min-w-0">
                  {p.title || p.note_id}
                </span>
                <div className="flex items-center gap-3 text-xs text-default-500 shrink-0">
                  <span className="flex items-center gap-1"><Heart size={11} />{p.liked_count ?? "—"}</span>
                  <span className="flex items-center gap-1"><Bookmark size={11} />{p.collected_count ?? "—"}</span>
                  <span className="flex items-center gap-1"><MessageCircle size={11} />{p.comment_count ?? "—"}</span>
                </div>
                <span className="text-xs text-default-300 shrink-0 hidden md:block">
                  {p.checked_at ? p.checked_at.slice(5, 16) : "待检测"}
                </span>
              </div>
            ))}
            {posts.length > 5 && (
              <p className="text-xs text-default-400 text-center py-1">
                还有 {posts.length - 5} 条，<Link href="/dashboard/monitor" className="text-primary">查看全部</Link>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
