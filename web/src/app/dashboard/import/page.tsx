"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Chip } from "@nextui-org/chip";
import { Divider } from "@nextui-org/divider";
import { Upload, Trash2, Download, CheckCircle, XCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

const API = (p: string) => `/api/monitor${p}`;

type Post = { note_id: string; title: string; short_url: string; note_url: string; is_active: number };
type Account = { id: number; name: string };
type Result = { link: string; ok: boolean; note_id?: string; reason?: string };

export default function ImportPage() {
  const { token } = useAuth();
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [links, setLinks] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const [p, a] = await Promise.all([
      fetch(API("/posts"), { headers: h }).then((r) => r.json()),
      fetch(API("/accounts"), { headers: h }).then((r) => r.json()),
    ]);
    setPosts(p.posts ?? []);
    setAccounts(a.accounts ?? []);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleImport = async () => {
    const items = links.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!items.length) return;
    setLoading(true);
    setResults([]);
    const res = await fetch(API("/posts"), {
      method: "POST",
      headers: h,
      body: JSON.stringify({ links: items, account_id: accountId ? parseInt(accountId) : null }),
    });
    const data = await res.json();
    setResults(data.results ?? []);
    setLinks("");
    await load();
    setLoading(false);
  };

  const handleDelete = async (note_id: string) => {
    await fetch(API(`/posts/${note_id}`), { method: "DELETE", headers: h });
    await load();
  };

  const handleExport = () => {
    const text = posts.map((p) => p.short_url || p.note_url).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "xhs-monitor-links.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">数据导入</h1>
          <p className="text-sm text-default-500 mt-0.5">批量导入小红书帖子链接进行监控</p>
        </div>
        {posts.length > 0 && (
          <Button size="sm" variant="flat" startContent={<Download size={15} />} onPress={handleExport}>
            导出链接列表
          </Button>
        )}
      </div>

      {/* Import form */}
      <Card className="border border-divider">
        <CardHeader className="font-semibold pb-0">粘贴帖子链接</CardHeader>
        <CardBody className="space-y-4 pt-3">
          <Textarea
            placeholder={"每行一个链接，支持：\n• 小红书 App 分享短链（xhslink.com/...）\n• 完整帖子 URL（xiaohongshu.com/explore/...）\n\n一次可粘贴多个，批量导入"}
            value={links}
            onValueChange={setLinks}
            minRows={6}
            classNames={{ input: "font-mono text-sm" }}
          />

          <div className="flex items-center gap-3">
            {accounts.length > 0 && (
              <Select
                placeholder="绑定账号（可选）"
                size="sm"
                className="flex-1 max-w-xs"
                selectedKeys={accountId ? new Set([accountId]) : new Set()}
                onSelectionChange={(k) => setAccountId(Array.from(k)[0] as string ?? "")}
              >
                {accounts.map((a) => (
                  <SelectItem key={String(a.id)}>{a.name}</SelectItem>
                ))}
              </Select>
            )}
            <Button
              color="primary"
              isLoading={loading}
              startContent={!loading ? <Upload size={16} /> : undefined}
              onPress={handleImport}
              isDisabled={!links.trim()}
            >
              解析并导入
            </Button>
          </div>

          {/* Results */}
          {results.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2 text-sm text-default-500">
                {successCount > 0 && <span className="text-success">✓ 成功 {successCount} 条</span>}
                {failCount > 0 && <span className="text-danger">✗ 失败 {failCount} 条</span>}
              </div>
              {results.filter((r) => !r.ok).map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-danger">
                  <XCircle size={14} />
                  <span className="truncate font-mono text-xs">{r.link}</span>
                  <span className="shrink-0">{r.reason}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Managed links list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">
            已导入链接
            <Chip size="sm" variant="flat" className="ml-2">{posts.length}</Chip>
          </h2>
        </div>

        {posts.length === 0 ? (
          <div className="text-center py-12 text-default-400">
            <p className="text-sm">还没有导入任何链接，在上方粘贴后点击「解析并导入」</p>
          </div>
        ) : (
          <div className="space-y-2">
            {posts.map((p, i) => (
              <div key={p.note_id}
                className="flex items-center gap-3 p-3 rounded-lg border border-divider hover:bg-default-50 transition-colors group">
                <span className="text-xs text-default-300 w-5 shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.title || "（标题待获取）"}</p>
                  <a href={p.note_url} target="_blank" rel="noreferrer"
                    className="text-xs text-default-400 hover:text-primary truncate block font-mono">
                    {p.short_url || p.note_url}
                  </a>
                </div>
                <Button isIconOnly size="sm" variant="light" color="danger"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onPress={() => handleDelete(p.note_id)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
