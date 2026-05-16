"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Chip } from "@nextui-org/chip";
import { Divider } from "@nextui-org/divider";
import { Upload, Trash2, Download, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr } from "@/lib/toast";
import { PageHeader } from "@/components/ui";

const API = (p: string) => `/api/monitor${p}`;

type Post = { note_id: string; title: string; short_url: string; note_url: string; is_active: number };
type Account = { id: number; name: string };
type Group = { id: number; name: string };
type Result = { link: string; ok: boolean; note_id?: string; reason?: string };

export default function ImportPage() {
  const { token } = useAuth();
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [links, setLinks] = useState("");
  const [accountId, setAccountId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const [p, a, g] = await Promise.all([
      fetch(API("/posts"), { headers: h }).then((r) => r.json()),
      fetch(API("/accounts"), { headers: h }).then((r) => r.json()),
      fetch(API("/groups"), { headers: h }).then((r) => r.json()),
    ]);
    setPosts(p.posts ?? []);
    setAccounts(a.accounts ?? []);
    const gs: Group[] = g.groups ?? [];
    setGroups(gs);
    // 没选过分组时，默认选第一个，避免首次提交因没选直接 400
    setGroupId((prev) => prev || (gs[0] ? String(gs[0].id) : ""));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleImport = async () => {
    const items = links.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!items.length) return;
    if (!groupId) {
      toastErr("请先选择分组（导入的帖子需要归属到一个分组）");
      return;
    }
    setLoading(true);
    setResults([]);
    try {
      const res = await fetch(API("/posts"), {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          links: items,
          account_id: accountId ? parseInt(accountId) : null,
          group_id: parseInt(groupId),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 后端拒绝（如 400 必须选分组、429 超配额）— 把错误打到 UI，不要让用户以为"丢失了"
        const msg = data?.detail || data?.error || `HTTP ${res.status}`;
        toastErr(`导入失败：${msg}`);
        return;
      }
      setResults(data.results ?? []);
      setLinks("");
      await load();
    } catch (e: any) {
      toastErr(`导入异常：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
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
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="toolbox"
        icon={Upload}
        title="数据导入"
        hint="批量导入小红书帖子链接进行监控；或从博主主页一键导入全部作品。"
        actions={
          posts.length > 0 ? (
            <Button size="sm" variant="flat" startContent={<Download size={15} />} onPress={handleExport}>
              导出链接列表
            </Button>
          ) : null
        }
      />

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

          <div className="flex flex-wrap items-center gap-3">
            {/* 分组：必选，导入的帖子必须归属到某个分组（监控告警按分组路由） */}
            <Select
              isRequired
              label="分组"
              labelPlacement="outside-left"
              placeholder={groups.length ? "选择分组" : "暂无分组（先去监控设置创建）"}
              size="sm"
              className="flex-1 max-w-xs"
              isDisabled={groups.length === 0}
              selectedKeys={groupId ? new Set([groupId]) : new Set()}
              onSelectionChange={(k) => setGroupId(Array.from(k)[0] as string ?? "")}
              errorMessage={!groupId ? "必填" : undefined}
            >
              {groups.map((g) => (
                <SelectItem key={String(g.id)}>{g.name}</SelectItem>
              ))}
            </Select>
            {accounts.length > 0 && (
              <Select
                label="账号"
                labelPlacement="outside-left"
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
              isDisabled={!links.trim() || !groupId}
            >
              解析并导入
            </Button>
          </div>

          {groups.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-warning bg-warning/10 rounded p-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>还没有分组，去「监控设置 → 监控分组」新建一个</span>
            </div>
          )}

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
