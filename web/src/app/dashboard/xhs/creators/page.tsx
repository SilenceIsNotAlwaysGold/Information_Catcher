"use client";

import { usePosts, mutatePosts } from "@/lib/useApi";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import { BarChart2, ExternalLink, Users, Trash2 } from "lucide-react";
import { PlatformSubNav, CreatorsCard } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";
import { useAuth } from "@/contexts/AuthContext";
import { confirmDialog } from "@/components/ConfirmDialog";
import { toastErr, toastOk } from "@/lib/toast";

const API = (path: string) => `/api/monitor${path}`;

type Post = {
  note_id: string;
  title: string;
  note_url: string;
  account_name?: string | null;
  liked_count?: number | null;
  collected_count?: number | null;
  comment_count?: number | null;
  checked_at?: string | null;
  group_name?: string | null;
  platform?: string;
};

const isXhs = (p: Post) => !p.platform || p.platform === "xhs";

export default function XhsCreatorsPage() {
  const { posts: rawPosts, isLoading: loading } = usePosts();
  const posts = (rawPosts as Post[]).filter((p) => isXhs(p) && p.group_name === "我的关注");
  const { token } = useAuth();

  const handleDelete = async (note_id: string, title: string) => {
    const ok = await confirmDialog({
      title: "删除帖子",
      content: `确认删除「${(title || note_id).slice(0, 40)}」？历史快照也会一并删除。`,
      confirmText: "删除", cancelText: "取消", danger: true,
    });
    if (!ok) return;
    const r = await fetch(API(`/posts/${note_id}`), {
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
    <div className="p-6 space-y-4">
      <PlatformSubNav platform="xhs" current="creators" />

      <CreatorsCard platform="xhs" />

      <Card>
        <CardHeader className="flex justify-between items-center">
          <div>
            <p className="text-sm font-medium">已入库帖子（来自博主追新）</p>
            <p className="text-xs text-default-400">
              下方列出「我的关注」分组下的小红书帖子，共 {posts.length} 条
            </p>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={Users}
              title="还没有抓到博主帖子"
              hint="在上方「订阅博主」中粘贴小红书博主主页 URL 开始追新，新帖会自动入库到「我的关注」分组。"
            />
          ) : (
          <Table aria-label="creator-posts" removeWrapper>
            <TableHeader>
              <TableColumn>标题 / ID</TableColumn>
              <TableColumn>作者</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>收藏</TableColumn>
              <TableColumn>评论</TableColumn>
              <TableColumn>最后检测</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {posts.map((p) => (
                <TableRow key={p.note_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <a href={p.note_url} target="_blank" rel="noreferrer"
                        className="text-primary text-sm truncate max-w-xs hover:underline">
                        {p.title || p.note_id}
                      </a>
                      <span className="text-xs text-default-400">{p.note_id}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Chip size="sm" variant="flat">{p.account_name ?? "—"}</Chip>
                  </TableCell>
                  <TableCell>{p.liked_count ?? "—"}</TableCell>
                  <TableCell>{p.collected_count ?? "—"}</TableCell>
                  <TableCell>{p.comment_count ?? "—"}</TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">
                      {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tooltip content="历史数据">
                        <Button isIconOnly size="sm" variant="light"
                          as={Link} href={`/dashboard/xhs/posts/history?note_id=${p.note_id}`}>
                          <BarChart2 size={15} />
                        </Button>
                      </Tooltip>
                      <Tooltip content="打开原帖">
                        <Button isIconOnly size="sm" variant="light"
                          as="a" href={p.note_url} target="_blank">
                          <ExternalLink size={15} />
                        </Button>
                      </Tooltip>
                      <Tooltip content="删除帖子" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger"
                          onPress={() => handleDelete(p.note_id, p.title)}>
                          <Trash2 size={15} />
                        </Button>
                      </Tooltip>
                    </div>
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
