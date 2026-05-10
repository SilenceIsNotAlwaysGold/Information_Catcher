"use client";

import { useMemo, useState } from "react";
import { usePosts, mutatePosts } from "@/lib/useApi";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Tooltip } from "@nextui-org/tooltip";
import { BarChart2, ExternalLink, Users, Trash2, X as XIcon } from "lucide-react";
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
  author?: string | null;
  liked_count?: number | null;
  collected_count?: number | null;
  comment_count?: number | null;
  checked_at?: string | null;
  group_name?: string | null;
  platform?: string;
  creator_id?: number | null;
};

const isXhs = (p: Post) => !p.platform || p.platform === "xhs";

export default function XhsCreatorsPage() {
  const { posts: rawPosts, isLoading: loading } = usePosts();
  // 博主追新的帖子：creator_id 不为 null（add_post 时关联到 monitor_creators.id）
  const allPosts = (rawPosts as Post[]).filter((p) => isXhs(p) && p.creator_id != null);

  // 筛选：博主 / 标题作者搜索 / 最低点赞
  const [authorFilter, setAuthorFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [minLikes, setMinLikes] = useState<string>("");
  const authorOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of allPosts) if (p.author) s.add(p.author);
    return Array.from(s).sort();
  }, [allPosts]);
  const posts = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const minL = parseInt(minLikes || "0", 10);
    return allPosts.filter((p) => {
      if (authorFilter && (p.author || "") !== authorFilter) return false;
      if (minL > 0 && (p.liked_count ?? 0) < minL) return false;
      if (kw) {
        const hay = `${p.title || ""} ${p.author || ""} ${p.note_id}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [allPosts, authorFilter, search, minLikes]);
  const hasFilter = authorFilter || search || minLikes;
  const resetFilters = () => { setAuthorFilter(""); setSearch(""); setMinLikes(""); };
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
        <CardHeader className="flex flex-col items-stretch gap-3">
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium">已入库帖子（来自博主追新）</p>
              <p className="text-xs text-default-400">
                共 {allPosts.length} 条{hasFilter && `（筛选后 ${posts.length} 条）`}
              </p>
            </div>
            {hasFilter && (
              <Button size="sm" variant="light" startContent={<XIcon size={13} />}
                onPress={resetFilters}>清除筛选</Button>
            )}
          </div>
          <div className="flex flex-row flex-wrap items-end gap-3">
            {authorOptions.length > 0 && (
              <div className="min-w-[160px]">
                <p className="text-xs text-default-500 mb-1">博主</p>
                <select
                  className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                  value={authorFilter}
                  onChange={(e) => setAuthorFilter(e.target.value)}
                >
                  <option value="">全部博主</option>
                  {authorOptions.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            )}
            <Input size="sm" type="number" min={0} className="w-28"
              label="点赞 ≥" labelPlacement="outside-left"
              value={minLikes} onValueChange={setMinLikes} />
            <Input size="sm" className="w-56"
              label="搜索" labelPlacement="outside-left"
              placeholder="标题 / 作者 / ID"
              value={search} onValueChange={setSearch} />
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
                    <Chip size="sm" variant="flat" color="secondary">{p.author || p.account_name || "—"}</Chip>
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
