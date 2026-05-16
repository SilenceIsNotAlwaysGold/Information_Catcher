"use client";

/**
 * AI PPT —— 输入主题 → AI 生大纲 JSON → python-pptx 渲染 .pptx 下载。
 *
 * 计费：ppt_outline 一次（覆盖大纲生成）；渲染本身不耗 AI。
 * （上传 .pptx 改造 — v2.1 再做）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { Presentation, Plus, Trash2, Sparkles, Download, RefreshCw, FileText, Upload, Wand2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ModelSelector } from "@/components/ModelSelector";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/studio/ppt${p}`;

type ProjectListItem = {
  id: number; title: string; topic: string; target_pages: number;
  style_hint: string; audience: string; status: string;
  pptx_url: string; created_at: string; updated_at: string;
};
type Page = { title: string; bullets: string[] };
type Plan = { title?: string; pages?: Page[] };
type Detail = ProjectListItem & { plan: Plan };

const STATUS_LABEL: Record<string, string> = {
  planning: "草稿", outlined: "大纲就绪", rendering: "渲染中", done: "已渲染",
};
const STATUS_COLOR: Record<string, any> = {
  planning: "default", outlined: "warning", rendering: "primary", done: "success",
};

export default function PptStudioPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const [list, setList] = useState<ProjectListItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  // 新建表单
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [pages, setPages] = useState(10);
  const [style, setStyle] = useState("商务严肃");
  const [audience, setAudience] = useState("");
  const [textModelId, setTextModelId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [rendering, setRendering] = useState(false);
  // 上传 .pptx
  const [uploading, setUploading] = useState(false);
  // AI 修改指令
  const [revInstruction, setRevInstruction] = useState("");
  const [revising, setRevising] = useState(false);

  const loadList = useCallback(async () => {
    if (!token) return;
    const r = await fetch(API("/projects"), { headers });
    if (r.ok) { const d = await r.json(); setList(d.projects || []); }
  }, [token, headers]);
  useEffect(() => { loadList(); }, [loadList]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) { setDetail(null); return; }
    const r = await fetch(API(`/projects/${selectedId}`), { headers });
    if (r.ok) setDetail(await r.json());
  }, [selectedId, headers]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const handleCreate = async () => {
    if (!topic.trim()) { toastErr("请输入主题"); return; }
    setCreating(true);
    try {
      const r = await fetch(API("/projects"), {
        method: "POST", headers,
        body: JSON.stringify({
          title, topic, target_pages: pages,
          style_hint: style, audience, text_model_id: textModelId,
        }),
      });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!r.ok) { toastErr(d.detail || "生成大纲失败"); return; }
      toastOk(`大纲生成完成 · ${d.plan?.pages?.length || 0} 页`);
      setTitle(""); setTopic(""); setAudience("");
      await loadList();
      setSelectedId(d.id);
    } finally { setCreating(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("删除这份 PPT？")) return;
    const r = await fetch(API(`/projects/${id}`), { method: "DELETE", headers });
    if (r.ok) {
      if (selectedId === id) setSelectedId(null);
      await loadList();
    }
  };

  // ── 上传 .pptx 创建项目 ─────────────────────────────────────
  const handleUpload = async (f: File) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pptx")) {
      toastErr("仅支持 .pptx（不支持老 .ppt / WPS .dps）"); return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("style_hint", style);
      const r = await fetch(API("/projects/upload"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },  // 不要塞 Content-Type，让浏览器加 boundary
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) { toastErr(d.detail || "上传失败"); return; }
      toastOk(`已导入 · 解析出 ${d.pages} 页`);
      await loadList();
      setSelectedId(d.id);
    } catch (e: any) {
      toastErr(e?.message || "上传异常");
    } finally { setUploading(false); }
  };

  // ── AI 修改大纲 ─────────────────────────────────────────────
  const handleRevise = async () => {
    if (!selectedId || !revInstruction.trim()) {
      toastErr("先选 PPT 并输入修改指令"); return;
    }
    setRevising(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/revise`), {
        method: "POST", headers,
        body: JSON.stringify({ instruction: revInstruction, text_model_id: textModelId }),
      });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!r.ok) { toastErr(d.detail || "修改失败"); return; }
      toastOk(`大纲已重写，现 ${d.pages} 页（旧 .pptx 已失效，请重新渲染）`);
      setRevInstruction("");
      await loadList(); await loadDetail();
    } finally { setRevising(false); }
  };

  const handleRender = async () => {
    if (!selectedId) return;
    setRendering(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/render`), { method: "POST", headers });
      const d = await r.json();
      if (!r.ok) { toastErr(d.detail || "渲染失败"); return; }
      toastOk(`PPTX 已生成（${Math.round(d.size_bytes / 1024)} KB），点"下载"`);
      await loadList(); await loadDetail();
    } finally { setRendering(false); }
  };

  const downloadUrl = useMemo(() => {
    if (!detail?.pptx_url) return "";
    // 加 token 让 FileResponse 也能用 Authorization；FastAPI 默认 Depends 解析 header，
    // 浏览器 <a download> 无法塞 header，所以拼成 ?token= ... 不行，
    // 简单做法：直接当下载链接打开，浏览器会带 cookie/header（如果有）；否则用户右键另存。
    return detail.pptx_url;
  }, [detail?.pptx_url]);

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-secondary/10 text-secondary p-3"><Presentation size={24} /></div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            AI PPT <Chip size="sm" variant="flat" color="secondary">Beta</Chip>
          </h1>
          <p className="text-sm text-default-500 mt-1">
            输入主题 → AI 生大纲（每页标题 + 3-5 要点）→ 一键渲染成 .pptx 下载。
            扣 <b>ppt_outline</b> 点（一次大纲生成覆盖全套）。
          </p>
        </div>
      </div>

      {/* 新建 */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <Plus size={16} /><span className="font-medium">新建 PPT</span>
        </CardHeader>
        <CardBody className="space-y-2">
          <div className="flex gap-2 flex-wrap items-end">
            <Input label="标题（可选）" size="sm" className="w-44"
              value={title} onValueChange={setTitle} placeholder="自动按主题命名" />
            <Input label="目标页数" size="sm" type="number" className="w-24"
              value={String(pages)}
              onValueChange={(v) => setPages(Math.max(3, Math.min(30, Number(v) || 10)))} />
            <Input label="风格" size="sm" className="w-40"
              value={style} onValueChange={setStyle} placeholder="商务严肃 / 极简 / 活泼" />
            <Input label="目标观众" size="sm" className="w-44"
              value={audience} onValueChange={setAudience} placeholder="如：投资人路演 / 学生科普" />
            <ModelSelector usage="text" value={textModelId} onChange={setTextModelId}
              label="文本模型" className="min-w-[220px]" />
          </div>
          <Textarea minRows={2} maxRows={4} size="sm"
            label="主题描述（500 字内）" labelPlacement="outside"
            value={topic} onValueChange={setTopic}
            placeholder="如：介绍 RAG 检索增强生成技术，针对 AI 工程师，覆盖原理、典型架构、几个开源框架对比、生产部署的常见坑" />
          <div className="flex items-center gap-2 flex-wrap">
            <Button color="primary" startContent={<Sparkles size={16} />}
              isLoading={creating} isDisabled={!topic.trim()}
              onPress={handleCreate}>
              生成大纲（扣 ppt_outline 点）
            </Button>
            <span className="text-xs text-default-400">或</span>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <Button as="span" variant="flat" color="secondary" size="sm"
                startContent={<Upload size={14} />}
                isLoading={uploading}>
                上传已有 .pptx
              </Button>
              <input type="file" accept=".pptx" className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]; if (f) handleUpload(f);
                  e.currentTarget.value = "";  // 允许再次选同名文件
                }} />
            </label>
            <span className="text-[11px] text-default-400">
              上传不扣点；AI 改造（在详情页"修改"扣 ppt_outline 点）
            </span>
          </div>
        </CardBody>
      </Card>

      {/* 列表 */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText size={16} />
            <span className="font-medium">我的 PPT</span>
            <Chip size="sm" variant="flat">{list.length}</Chip>
          </div>
          <Button size="sm" variant="light" isIconOnly onPress={loadList}><RefreshCw size={14} /></Button>
        </CardHeader>
        <CardBody>
          {list.length === 0 ? (
            <p className="text-sm text-default-400">还没 PPT，上方填表生成第一份。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {list.map((p) => {
                const on = p.id === selectedId;
                return (
                  <div key={p.id}
                    className={`p-3 rounded-md border-2 cursor-pointer transition ${on ? "border-secondary bg-secondary/5" : "border-default-200 hover:border-default-400"}`}
                    onClick={() => setSelectedId(p.id)}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium truncate">{p.title || p.topic.slice(0, 20)}</span>
                      <Chip size="sm" variant="flat" color={STATUS_COLOR[p.status] || "default"}>
                        {STATUS_LABEL[p.status] || p.status}
                      </Chip>
                    </div>
                    <p className="text-xs text-default-500 truncate">{p.topic}</p>
                    <p className="text-[10px] text-default-400 mt-0.5">{p.target_pages} 页 · {p.updated_at?.slice(5, 16)}</p>
                    <button type="button" className="text-[11px] text-danger mt-1 hover:underline"
                      onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}>删除</button>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 详情 + 大纲 + 渲染 */}
      {detail && (
        <Card>
          <CardHeader className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className="font-bold text-lg">{detail.title || detail.plan?.title || "未命名"}</p>
              <p className="text-xs text-default-500">{detail.topic}</p>
            </div>
            <div className="flex gap-2">
              <Button color="primary" size="sm" startContent={<Presentation size={14} />}
                isLoading={rendering} onPress={handleRender}>
                {detail.status === "done" ? "重新渲染" : "渲染 .pptx"}
              </Button>
              {detail.pptx_url && (
                <Button size="sm" variant="flat" color="success"
                  as="a" href={downloadUrl} target="_blank"
                  startContent={<Download size={14} />}>
                  下载
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            {/* AI 修改大纲 */}
            <div className="rounded border border-default-200 p-3 bg-default-50/50">
              <p className="text-xs font-medium mb-2 flex items-center gap-1">
                <Wand2 size={13} /> 让 AI 修改大纲（扣 ppt_outline 点）
              </p>
              <div className="flex gap-2 items-start">
                <Textarea minRows={2} maxRows={4} size="sm" className="flex-1"
                  placeholder="如：把第 3 页改成投资人视角；删掉最后一页；加一页竞品对比列 3 个对手；把全部标题改得更口语化"
                  value={revInstruction} onValueChange={setRevInstruction} />
                <Button color="secondary" size="sm" startContent={<Wand2 size={14} />}
                  isLoading={revising} isDisabled={!revInstruction.trim()}
                  onPress={handleRevise}>
                  AI 修改
                </Button>
              </div>
            </div>
            {(detail.plan?.pages || []).map((pg, i) => (
              <div key={i} className="rounded border border-default-200 p-3">
                <p className="font-medium mb-1">{i + 1}. {pg.title}</p>
                <ul className="list-disc ml-5 text-sm text-default-700 space-y-0.5">
                  {(pg.bullets || []).map((b, j) => <li key={j}>{b}</li>)}
                </ul>
              </div>
            ))}
            {(!detail.plan?.pages || detail.plan.pages.length === 0) && (
              <p className="text-sm text-default-400">大纲为空</p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
