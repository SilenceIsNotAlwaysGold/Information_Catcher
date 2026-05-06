"use client";

import { usePosts } from "@/lib/useApi";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Users } from "lucide-react";
import { PlatformSubNav, CreatorsCard, PostRow } from "@/components/platform";
import { EmptyState } from "@/components/EmptyState";
import { TableSkeleton } from "@/components/TableSkeleton";

export default function DouyinCreatorsPage() {
  const { posts: rawPosts, isLoading: loading } = usePosts();
  const posts = (rawPosts as PostRow[]).filter(
    (p) => p.platform === "douyin" && (p.group_name || "") === "我的关注"
  );

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
