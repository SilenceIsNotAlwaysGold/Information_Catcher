"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Card, CardBody, CardHeader,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Chip, Button, Tooltip,
} from "@nextui-org/react";
import { BarChart2, ExternalLink } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav, CreatorsCard } from "@/components/platform";

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
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(API("/posts"), { headers });
      const d = await r.json();
      // 仅 xhs + 「我的关注」分组（博主追新自动入库的目标分组）
      const list: Post[] = (d.posts || []).filter(
        (p: Post) => isXhs(p) && p.group_name === "我的关注",
      );
      setPosts(list);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) load(); }, [token, load]);

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
            <TableBody emptyContent={loading ? "加载中…" : "还没有抓到博主帖子"}>
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
                    </div>
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
