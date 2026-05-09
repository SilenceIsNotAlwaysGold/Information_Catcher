"use client";

import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import { Skeleton } from "@nextui-org/skeleton";
import { Newspaper, Trash2 } from "lucide-react";
import { PlatformSubNav, CreatorsCard } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { usePosts, mutatePosts } from "@/lib/useApi";
import { useAuth } from "@/contexts/AuthContext";
import { confirmDialog } from "@/components/ConfirmDialog";
import { toastErr, toastOk } from "@/lib/toast";

type Post = {
  note_id: string;
  title: string;
  note_url: string;
  author?: string | null;
  checked_at?: string | null;
  copyright_stat?: string | null;
  platform?: string;
};

export default function MpCreatorsPage() {
  const { posts: rawPosts, isLoading: loading } = usePosts();
  const posts = (rawPosts as Post[]).filter((p) => p.platform === "mp");
  const { token } = useAuth();

  const handleDelete = async (note_id: string, title: string) => {
    const ok = await confirmDialog({
      title: "删除文章",
      content: `确认删除「${(title || note_id).slice(0, 40)}」？历史快照也会一并删除。`,
      confirmText: "删除", cancelText: "取消", danger: true,
    });
    if (!ok) return;
    const r = await fetch(`/api/monitor/posts/${note_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) {
      toastOk("已删除");
      await mutatePosts();
    } else {
      const j = await r.json().catch(() => ({}));
      toastErr(`删除失败：${j.detail || `HTTP ${r.status}`}`);
    }
  };

  // 按 author 分组，每组取最近 10 篇（按 checked_at 倒序）
  const grouped = (() => {
    const m: Record<string, Post[]> = {};
    for (const p of posts) {
      const a = (p.author || "").trim();
      if (!a) continue;
      (m[a] ||= []).push(p);
    }
    const sorted = Object.entries(m).map(([author, items]) => {
      const sortedItems = [...items].sort((x, y) => {
        const tx = x.checked_at || "";
        const ty = y.checked_at || "";
        return ty.localeCompare(tx);
      }).slice(0, 10);
      return { author, items: sortedItems, total: items.length };
    });
    sorted.sort((a, b) => b.total - a.total);
    return sorted;
  })();

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <PlatformSubNav platform="mp" current="creators" />

      <CreatorsCard platform="mp" />

      <Card>
        <CardHeader className="flex-col items-start gap-1">
          <p className="text-sm font-medium">已订阅公众号近期文章</p>
          <p className="text-xs text-default-400">
            按公众号分组，每组展示最近抓到的 10 篇。完整文章列表见「文章列表」页。
          </p>
        </CardHeader>
        <CardBody className="space-y-4">
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-5 w-40 rounded-lg" />
                  <div className="ml-6 space-y-1">
                    <Skeleton className="h-4 w-3/4 rounded-md" />
                    <Skeleton className="h-4 w-2/3 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          ) : grouped.length === 0 ? (
            <EmptyState
              icon={Newspaper}
              title="还没有抓到任何已订阅公众号的文章"
              hint="在上方「订阅公众号」中添加目标公众号，定时任务会自动追新；也可以在「文章列表」页粘贴文章链接手动抓取。"
            />
          ) : (
            grouped.map((g) => (
              <div key={g.author} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-success text-sm">📢 {g.author}</span>
                  <Chip size="sm" variant="flat">{g.total} 篇</Chip>
                </div>
                <ul className="ml-6 space-y-1">
                  {g.items.map((p) => (
                    <li key={p.note_id} className="group flex items-center gap-2 text-sm">
                      {p.copyright_stat === "11" && (
                        <Chip size="sm" color="success" variant="flat">原创</Chip>
                      )}
                      {(p.copyright_stat === "100" || p.copyright_stat === "101") && (
                        <Chip size="sm" color="warning" variant="flat">转载</Chip>
                      )}
                      <a href={p.note_url} target="_blank" rel="noreferrer"
                        className="text-primary truncate max-w-xl hover:underline flex-1">
                        {p.title || p.note_id}
                      </a>
                      <span className="text-xs text-default-400 shrink-0">
                        {p.checked_at ? p.checked_at.slice(5, 16) : ""}
                      </span>
                      <Tooltip content="删除文章" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger"
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                          onPress={() => handleDelete(p.note_id, p.title || "")}>
                          <Trash2 size={13} />
                        </Button>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
