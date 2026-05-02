"use client";

import { useEffect, useState, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { ArrowLeft, Heart, Bookmark, MessageCircle, Share2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const API = (path: string) => `/api/monitor${path}`;

type Snap = {
  id: number;
  note_id: string;
  liked_count: number;
  collected_count: number;
  comment_count: number;
  share_count: number;
  checked_at: string;
};

type PostMeta = {
  note_id: string;
  title: string;
  note_url: string;
  platform: string;
};

const SERIES = [
  { key: "liked_count" as const,     label: "点赞", color: "#FF2442" },
  { key: "collected_count" as const, label: "收藏", color: "#FFB000" },
  { key: "comment_count" as const,   label: "评论", color: "#3B82F6" },
];

function PostHistoryInner() {
  const params = useSearchParams();
  const note_id = params.get("note_id") || "";
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [history, setHistory] = useState<Snap[]>([]);
  const [post, setPost] = useState<PostMeta | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!note_id || !token) return;
    (async () => {
      const [h, posts] = await Promise.all([
        fetch(API(`/posts/${note_id}/history?limit=200`), { headers }).then((r) => r.json()),
        fetch(API("/posts"), { headers }).then((r) => r.json()),
      ]);
      const list = (h.history ?? []).slice().sort(
        (a: Snap, b: Snap) => a.checked_at.localeCompare(b.checked_at),
      );
      setHistory(list);
      const p = (posts.posts || []).find((x: any) => x.note_id === note_id);
      if (p) setPost(p);
      setLoading(false);
    })();
  }, [note_id, token]);

  const latest = history[history.length - 1];
  const W = 800, H = 280, M = 40;
  const innerW = W - M * 2;
  const innerH = H - M * 2;

  const lines = useMemo(() => {
    if (history.length < 2) return null;
    const xMax = Math.max(1, history.length - 1);
    return SERIES.map((s) => {
      const ys = history.map((p) => p[s.key] || 0);
      const yMax = Math.max(...ys, 1);
      const points = ys.map((y, i) => {
        const x = M + (i / xMax) * innerW;
        const yp = M + (1 - y / yMax) * innerH;
        return `${x.toFixed(1)},${yp.toFixed(1)}`;
      }).join(" ");
      return { ...s, points, yMax };
    });
  }, [history]);

  if (!note_id) {
    return <div className="p-6 text-default-400">缺少 note_id 参数</div>;
  }
  if (loading) {
    return <div className="flex h-[60vh] items-center justify-center"><Spinner /></div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="light" startContent={<ArrowLeft size={14} />}
          as={Link} href="/dashboard/xhs/posts/">
          返回列表
        </Button>
        {post?.platform && (
          <Chip size="sm" variant="flat">{post.platform.toUpperCase()}</Chip>
        )}
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <a href={post?.note_url || "#"} target="_blank" rel="noreferrer"
            className="font-semibold text-primary hover:underline">
            {post?.title || note_id}
          </a>
          <span className="text-xs text-default-400">{note_id}</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "点赞", value: latest?.liked_count, icon: <Heart size={16} className="text-[#FF2442]" /> },
              { label: "收藏", value: latest?.collected_count, icon: <Bookmark size={16} className="text-[#FFB000]" /> },
              { label: "评论", value: latest?.comment_count, icon: <MessageCircle size={16} className="text-[#3B82F6]" /> },
              { label: "分享", value: latest?.share_count, icon: <Share2 size={16} className="text-default-500" /> },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-2 p-3 border border-divider rounded-lg">
                {s.icon}
                <div>
                  <div className="text-xs text-default-400">{s.label}</div>
                  <div className="text-lg font-semibold">{(s.value ?? 0).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>

          {history.length < 2 && (
            <p className="text-sm text-default-400">暂无足够数据画图（至少需要 2 个 snapshot）</p>
          )}

          {lines && (
            <div className="overflow-x-auto">
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[280px]">
                {[0, 0.25, 0.5, 0.75, 1].map((p) => {
                  const y = M + p * innerH;
                  return (
                    <line key={p} x1={M} x2={W - M} y1={y} y2={y}
                      stroke="#e5e7eb" strokeDasharray="3 3" />
                  );
                })}
                <text x={M} y={H - 8} fontSize="10" fill="#9ca3af">
                  {history[0]?.checked_at?.slice(5, 16)}
                </text>
                <text x={W - M} y={H - 8} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {history[history.length - 1]?.checked_at?.slice(5, 16)}
                </text>
                {lines.map((s) => (
                  <polyline key={s.key} points={s.points} fill="none"
                    stroke={s.color} strokeWidth="2" />
                ))}
              </svg>
              <div className="flex justify-center gap-4 mt-2">
                {lines.map((s) => (
                  <span key={s.key} className="flex items-center gap-1 text-xs">
                    <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} />
                    {s.label}（峰值 {s.yMax.toLocaleString()}）
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="text-sm">最近 {history.length} 个 snapshot</CardHeader>
        <CardBody>
          <table className="text-xs w-full">
            <thead>
              <tr className="text-default-400 border-b border-divider">
                <th className="text-left py-1">时间</th>
                <th className="text-right">点赞</th>
                <th className="text-right">收藏</th>
                <th className="text-right">评论</th>
                <th className="text-right">分享</th>
              </tr>
            </thead>
            <tbody>
              {history.slice().reverse().slice(0, 30).map((s) => (
                <tr key={s.id} className="border-b border-divider/50">
                  <td className="py-1">{s.checked_at?.slice(0, 16)}</td>
                  <td className="text-right">{s.liked_count}</td>
                  <td className="text-right">{s.collected_count}</td>
                  <td className="text-right">{s.comment_count}</td>
                  <td className="text-right">{s.share_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

export default function PostHistoryPage() {
  return (
    <Suspense fallback={<div className="p-6"><Spinner /></div>}>
      <PostHistoryInner />
    </Suspense>
  );
}
