"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Tooltip } from "@nextui-org/tooltip";
import { Download } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformSubNav } from "@/components/platform";
import {
  PlatformPostsView, type PostRow,
} from "@/components/platform/PlatformPostsView";
import { mutatePosts } from "@/lib/useApi";
import { toastErr } from "@/lib/toast";

const AddDouyinPostsModal = dynamic(
  () => import("./_modals/AddDouyinPostsModal"),
  { ssr: false },
);

const API = (path: string) => `/api/monitor${path}`;

function parseTags(s?: string): string[] {
  if (!s) return [];
  try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

export default function DouyinPostsPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // 添加 modal 的 state
  const [links, setLinks] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [results, setResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);

  const handleAdd = async () => {
    const items = links.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length || !selectedGroupId) return;
    setAdding(true);
    setResults([]);
    try {
      const r = await fetch(API("/posts"), {
        method: "POST", headers,
        body: JSON.stringify({
          links: items, group_id: parseInt(selectedGroupId),
        }),
      });
      const d = await r.json();
      setResults(d.results ?? []);
      setLinks("");
      await mutatePosts();
    } finally {
      setAdding(false);
    }
  };

  // 标题下面附加：作者 + tags
  const renderTitleExtras = (p: PostRow) => {
    const tags = parseTags(p.tags);
    if (!p.author && tags.length === 0) return null;
    return (
      <div className="flex items-center gap-1 flex-wrap">
        {p.author && <span className="text-xs text-success">📢 {p.author}</span>}
        {tags.slice(0, 6).map((t, i) => (
          <Chip key={i} size="sm" variant="flat" color="primary"
            className="h-5 text-[10px] px-1">
            #{t}
          </Chip>
        ))}
      </div>
    );
  };

  // 行操作：下载无水印 mp4
  const renderRowActions = (p: PostRow) => (
    <Tooltip content="下载无水印 mp4">
      <Button isIconOnly size="sm" variant="light"
        onPress={async () => {
          const r = await fetch(API(`/posts/${p.note_id}/video?clean=true`), { headers });
          if (!r.ok) {
            let msg = "下载失败";
            try { const j = await r.json(); msg = j.detail || msg; } catch {}
            toastErr(msg);
            return;
          }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `douyin_${p.note_id}.mp4`;
          a.click();
          URL.revokeObjectURL(url);
        }}>
        <Download size={15} />
      </Button>
    </Tooltip>
  );

  return (
    <div className="p-6 space-y-4">
      <PlatformSubNav platform="douyin" current="posts" />
      <PlatformPostsView
        platform="douyin"
        addLabel="添加抖音视频"
        emptyTitle="还没有添加抖音视频"
        emptyHint="支持 v.douyin.com 短链 / www.douyin.com/video/{id} 长链 / iesdouyin 移动分享链。"
        metricColumns={[
          { key: "liked_count",     label: "点赞", sortKey: "liked" },
          { key: "comment_count",   label: "评论", sortKey: "comment" },
          { key: "collected_count", label: "分享", sortKey: "collected" },
        ]}
        AddModal={AddDouyinPostsModal}
        addModalProps={{
          selectedGroupId, setSelectedGroupId,
          links, setLinks,
          results, adding,
          onSubmit: handleAdd,
        }}
        renderTitleExtras={renderTitleExtras}
        renderRowActions={renderRowActions}
      />
    </div>
  );
}
