"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav, CreatorsCard, PostRow } from "@/components/platform";

export default function DouyinCreatorsPage() {
  const { token } = useAuth();
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/monitor/posts?platform=douyin`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const d = await r.json();
        const all: PostRow[] = d.posts ?? [];
        setPosts(all.filter((p) => (p.group_name || "") === "我的关注"));
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

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
          <Table aria-label="douyin-creator-posts" removeWrapper>
            <TableHeader>
              <TableColumn>视频</TableColumn>
              <TableColumn>作者</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>评论</TableColumn>
              <TableColumn>检测时间</TableColumn>
            </TableHeader>
            <TableBody emptyContent={loading ? "加载中…" : "暂无追新内容"}>
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
        </CardBody>
      </Card>
    </div>
  );
}
