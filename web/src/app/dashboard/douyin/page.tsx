"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, CardBody, CardHeader, Button, Textarea, Chip,
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure, Tooltip,
} from "@nextui-org/react";
import { Plus, RefreshCw, Trash2, Music2, Download } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const API = (path: string) => `/api/monitor${path}`;

type Post = {
  note_id: string;
  title: string;
  note_url: string;
  liked_count: number | null;
  collected_count: number | null;
  comment_count: number | null;
  checked_at: string | null;
  last_fetch_status?: string;
  fail_count?: number;
  platform: string;
  tags?: string;  // JSON array
  author?: string;
};

function parseTags(s?: string): string[] {
  if (!s) return [];
  try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

export default function DouyinPage() {
  const { token } = useAuth();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [posts, setPosts] = useState<Post[]>([]);
  const [links, setLinks] = useState("");
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<{ link: string; ok: boolean; reason?: string }[]>([]);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const load = useCallback(async () => {
    const r = await fetch(API("/posts?platform=douyin"), { headers });
    const d = await r.json();
    setPosts(d.posts ?? []);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const items = links.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    setAdding(true);
    setResults([]);
    try {
      const r = await fetch(API("/posts"), {
        method: "POST", headers, body: JSON.stringify({ links: items }),
      });
      const d = await r.json();
      setResults(d.results ?? []);
      setLinks("");
      await load();
    } finally {
      setAdding(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    await fetch(API("/check"), { method: "POST", headers });
    setTimeout(async () => { await load(); setChecking(false); }, 4000);
  };

  const handleDelete = async (note_id: string) => {
    if (!confirm("确认删除这条监控？")) return;
    await fetch(API(`/posts/${note_id}`), { method: "DELETE", headers });
    await load();
  };

  const statusChip = (p: Post) => {
    const fc = p.fail_count ?? 0;
    if (fc >= 5) return <Chip size="sm" color="danger" variant="flat">⚠️ 已停抓</Chip>;
    if (p.last_fetch_status === "ok") return <Chip size="sm" color="success" variant="flat">正常</Chip>;
    if (p.last_fetch_status === "login_required")
      return <Chip size="sm" color="warning" variant="flat">🔒 需验证</Chip>;
    if (p.last_fetch_status === "deleted") return <Chip size="sm" color="danger" variant="flat">已删除</Chip>;
    if (p.last_fetch_status === "error") return <Chip size="sm" color="danger" variant="flat">抓取异常</Chip>;
    return <Chip size="sm" variant="flat">未检测</Chip>;
  };

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Music2 size={22} className="text-primary" />
          <h1 className="text-2xl font-bold">抖音监控</h1>
          <Chip size="sm" color="primary" variant="flat">v1 - 详情抓取</Chip>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="flat"
            startContent={<RefreshCw size={15} className={checking ? "animate-spin" : ""} />}
            onPress={handleCheck} isLoading={checking}>
            立即检测
          </Button>
          <Button size="sm" color="primary" startContent={<Plus size={16} />} onPress={onOpen}>
            添加抖音视频
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="text-sm text-default-500 flex-col items-start gap-1">
          <span>支持的链接形态：</span>
          <ul className="text-xs space-y-0.5 ml-3">
            <li>· 短链：<code>https://v.douyin.com/xxxxx/</code></li>
            <li>· 长链：<code>https://www.douyin.com/video/&#123;aweme_id&#125;</code></li>
            <li>· 移动分享：<code>https://www.iesdouyin.com/share/video/&#123;aweme_id&#125;/</code></li>
          </ul>
          <span className="text-xs text-warning mt-1">⚠️ 搜索（关键词热门）功能开发中，需 X-Bogus 签名拦截</span>
        </CardHeader>
        <CardBody className="p-0">
          <Table aria-label="douyin-posts" removeWrapper>
            <TableHeader>
              <TableColumn>视频</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>点赞</TableColumn>
              <TableColumn>评论</TableColumn>
              <TableColumn>分享</TableColumn>
              <TableColumn>最后检测</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody emptyContent="还没有添加抖音视频">
              {posts.map((p) => (
                <TableRow key={p.note_id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <a href={p.note_url} target="_blank" rel="noreferrer"
                        className="text-primary text-sm truncate max-w-md hover:underline">
                        {p.title || p.note_id}
                      </a>
                      <div className="flex items-center gap-1 flex-wrap">
                        {p.author && (
                          <span className="text-xs text-success">📢 {p.author}</span>
                        )}
                        {parseTags(p.tags).slice(0, 6).map((t, i) => (
                          <Chip key={i} size="sm" variant="flat" color="primary"
                            className="h-5 text-[10px] px-1">
                            #{t}
                          </Chip>
                        ))}
                      </div>
                      <span className="text-xs text-default-400">{p.note_id}</span>
                    </div>
                  </TableCell>
                  <TableCell>{statusChip(p)}</TableCell>
                  <TableCell>{p.liked_count ?? "—"}</TableCell>
                  <TableCell>{p.comment_count ?? "—"}</TableCell>
                  <TableCell>{p.collected_count ?? "—"}</TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">
                      {p.checked_at ? p.checked_at.slice(0, 16) : "待检测"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tooltip content="下载无水印 mp4">
                        <Button isIconOnly size="sm" variant="light"
                          onPress={async () => {
                            const r = await fetch(API(`/posts/${p.note_id}/video?clean=true`), { headers });
                            if (!r.ok) {
                              let msg = "下载失败";
                              try { const j = await r.json(); msg = j.detail || msg; } catch {}
                              alert(msg);
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
                      <Tooltip content="删除" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger"
                          onPress={() => handleDelete(p.note_id)}>
                          <Trash2 size={15} />
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

      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalContent>
          <ModalHeader>添加抖音视频</ModalHeader>
          <ModalBody>
            <Textarea
              label="视频链接（每行一个）"
              placeholder={"v.douyin.com/xxx/\n或 www.douyin.com/video/{id}"}
              value={links} onValueChange={setLinks} minRows={4}
            />
            {results.length > 0 && (
              <div className="text-xs space-y-1">
                {results.map((r, i) => (
                  <div key={i} className={r.ok ? "text-success" : "text-danger"}>
                    {r.ok ? "✓" : "✗"} {r.link.slice(0, 60)}{r.reason ? ` — ${r.reason}` : ""}
                  </div>
                ))}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>取消</Button>
            <Button color="primary" onPress={handleAdd} isLoading={adding}>添加</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
