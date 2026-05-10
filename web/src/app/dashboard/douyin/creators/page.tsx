"use client";

import { usePosts, mutatePosts } from "@/lib/useApi";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Users, Trash2 } from "lucide-react";
import { PlatformSubNav, CreatorsCard, PostRow } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { useAuth } from "@/contexts/AuthContext";
import { confirmDialog } from "@/components/ConfirmDialog";
import { toastErr, toastOk } from "@/lib/toast";

export default function DouyinCreatorsPage() {
  const { posts: rawPosts, isLoading: loading } = usePosts();
  // 博主追新的帖子：creator_id 不为 null（add_post 时关联到 monitor_creators.id）
  const posts = (rawPosts as PostRow[]).filter(
    (p) => p.platform === "douyin" && (p as any).creator_id != null
  );
  const { token } = useAuth();

  const handleDelete = async (note_id: string, title: string) => {
    const ok = await confirmDialog({
      title: "删除作品",
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

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <PlatformSubNav platform="douyin" current="creators" />

      <CreatorsCard platform="douyin" />

      <Card>
        <CardHeader className="flex flex-col items-start gap-1">
          <p className="text-sm font-medium">最近抓到的追新内容</p>
          <p className="text-xs text-default-400">
            自动归入「我的关注」分组，共 {posts.length} 条
          </p>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={Users}
              title="暂无追新内容"
              hint="在上方「订阅博主」中粘贴抖音博主主页 URL 开始追新，新作品会自动入库到「我的关注」分组。"
            />
          ) : (
          <Table aria-label="douyin-creator-posts" removeWrapper>
            <TableHeader>
              <TableColumn>视频</TableColumn>
              <TableColumn>作者</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>评论</TableColumn>
              <TableColumn>检测时间</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {posts.map((p) => (
                <TableRow key={p.note_id}>
                  <TableCell>
                    <a href={p.note_url} target="_blank" rel="noreferrer"
                      className="text-primary text-sm truncate max-w-md hover:underline">
                      {p.title || p.note_id}
                    </a>
                  </TableCell>
                  <TableCell>
                    {p.author ? (
                      <Chip size="sm" variant="flat" color="success">{p.author}</Chip>
                    ) : (
                      <span className="text-xs text-default-400">—</span>
                    )}
                  </TableCell>
                  <TableCell>{p.liked_count ?? "—"}</TableCell>
                  <TableCell>{p.comment_count ?? "—"}</TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">
                      {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Tooltip content="删除作品" color="danger">
                      <Button isIconOnly size="sm" variant="light" color="danger"
                        onPress={() => handleDelete(p.note_id, p.title || "")}>
                        <Trash2 size={15} />
                      </Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
