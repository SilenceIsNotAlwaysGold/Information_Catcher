"use client";

/**
 * AI 漫画工坊（v2 板块 2 / 第一个 AI 工坊功能）
 *
 * 工作流（参考 LoreVista，走平台 AI + 计费）：
 *   1. 新建项目 → drafting
 *   2. 对话引导 AI 写故事（comic_story 扣点）→ 用户在编辑器里定稿故事梗概
 *   3. 加角色卡（保持人物外貌一致）
 *   4. AI 拆分镜（comic_story 扣一次大的）→ 进 drawing 状态
 *   5. 单格生图 / 全部生图（每格 comic_panel 扣点）→ done
 *
 * 单页面 + URL ?id=N 切项目，避免静态导出的动态路由麻烦。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import {
  BookOpen, Plus, Trash2, Send, Sparkles, ImageIcon,
  Users as UsersIcon, FileText, RefreshCw, Download,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ModelSelector } from "@/components/ModelSelector";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader, BetaBadge } from "@/components/ui";

const API = (p: string) => `/api/studio/comic${p}`;

type Project = {
  id: number; user_id: number; title: string; synopsis: string;
  style_hint: string; status: string;
  text_model_id: number | null; image_model_id: number | null;
  created_at: string; updated_at: string;
  panel_count: number; done_count: number;
};
type Turn = { id: number; role: "user" | "assistant"; content: string; created_at: string };
type Character = { id: number; name: string; appearance: string; ref_image_url: string };
type Panel = {
  id: number; seq: number; script_text: string; char_names: string[];
  image_url: string; image_prompt: string;
  gen_status: "pending" | "generating" | "done" | "error";
  gen_error: string;
};
type Detail = {
  project: Project; turns: Turn[]; characters: Character[]; panels: Panel[];
};

const STATUS_LABEL: Record<string, string> = {
  drafting: "写故事中", scripting: "拆分镜中", drawing: "生图中", done: "已完成",
};
const STATUS_COLOR: Record<string, any> = {
  drafting: "default", scripting: "warning", drawing: "primary", done: "success",
};

export default function ComicStudioPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  // ── 项目列表 ──────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newStyle, setNewStyle] = useState("日系少女漫画");

  const loadProjects = useCallback(async () => {
    if (!token) return;
    setLoadingList(true);
    try {
      const r = await fetch(API("/projects"), { headers });
      if (r.ok) {
        const d = await r.json();
        setProjects(d.projects || []);
        // 从 URL 取 ?id=
        if (selectedId === null && typeof window !== "undefined") {
          const id = new URL(window.location.href).searchParams.get("id");
          if (id) setSelectedId(Number(id));
          else if (d.projects?.length) setSelectedId(d.projects[0].id);
        }
      }
    } finally { setLoadingList(false); }
  }, [token, headers, selectedId]);
  useEffect(() => { loadProjects(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  // 切项目时同步 URL
  useEffect(() => {
    if (typeof window === "undefined" || selectedId === null) return;
    const u = new URL(window.location.href);
    u.searchParams.set("id", String(selectedId));
    window.history.replaceState({}, "", u.toString());
  }, [selectedId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const r = await fetch(API("/projects"), {
        method: "POST", headers,
        body: JSON.stringify({ title: newTitle, style_hint: newStyle }),
      });
      const d = await r.json();
      if (!r.ok) { toastErr(d.detail || "创建失败"); return; }
      setNewTitle("");
      await loadProjects();
      setSelectedId(d.id);
      toastOk("项目已创建");
    } finally { setCreating(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("删除该漫画项目？对话/角色/分镜都会一起删掉，无法恢复。")) return;
    const r = await fetch(API(`/projects/${id}`), { method: "DELETE", headers });
    if (r.ok) {
      if (selectedId === id) setSelectedId(null);
      await loadProjects();
      toastOk("已删除");
    } else { toastErr("删除失败"); }
  };

  // ── 项目详情 ──────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const loadDetail = useCallback(async () => {
    if (!selectedId) { setDetail(null); return; }
    setLoadingDetail(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}`), { headers });
      if (r.ok) setDetail(await r.json());
      else setDetail(null);
    } finally { setLoadingDetail(false); }
  }, [selectedId, headers]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  // ── 对话引导 ─────────────────────────────────────────────────────────
  const [chatMsg, setChatMsg] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const handleChat = async () => {
    const m = chatMsg.trim();
    if (!m || !selectedId) return;
    setChatBusy(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/chat`), {
        method: "POST", headers, body: JSON.stringify({ message: m }),
      });
      const d = await r.json();
      if (r.status === 402) {
        toastErr(`余额不足：${d.detail || ""}（去个人中心找管理员充值）`);
        return;
      }
      if (!r.ok) { toastErr(d.detail || "对话失败"); return; }
      setChatMsg("");
      await loadDetail();
    } finally { setChatBusy(false); }
  };

  // ── 定稿梗概 ─────────────────────────────────────────────────────────
  const [synopsisDraft, setSynopsisDraft] = useState("");
  useEffect(() => { setSynopsisDraft(detail?.project.synopsis || ""); }, [detail?.project.id]);
  const saveSynopsis = async () => {
    if (!selectedId) return;
    const r = await fetch(API(`/projects/${selectedId}/synopsis`), {
      method: "PUT", headers, body: JSON.stringify({ synopsis: synopsisDraft }),
    });
    if (r.ok) { toastOk("梗概已定稿，进入分镜阶段"); await loadDetail(); }
    else toastErr("保存失败");
  };

  // ── 角色卡 ───────────────────────────────────────────────────────────
  const [charName, setCharName] = useState("");
  const [charApp, setCharApp] = useState("");
  const addChar = async () => {
    if (!selectedId || !charName.trim()) { toastErr("角色名必填"); return; }
    const r = await fetch(API(`/projects/${selectedId}/characters`), {
      method: "POST", headers, body: JSON.stringify({ name: charName.trim(), appearance: charApp.trim() }),
    });
    if (r.ok) { setCharName(""); setCharApp(""); await loadDetail(); }
    else toastErr("加角色失败");
  };
  const delChar = async (cid: number) => {
    if (!selectedId) return;
    const r = await fetch(API(`/projects/${selectedId}/characters/${cid}`), { method: "DELETE", headers });
    if (r.ok) await loadDetail();
  };

  // ── 拆分镜 ───────────────────────────────────────────────────────────
  const [nPanels, setNPanels] = useState(8);
  const [storyboarding, setStoryboarding] = useState(false);
  const doStoryboard = async () => {
    if (!selectedId) return;
    if (detail?.panels.length && !confirm("已有分镜，重拆会清掉现有的，确认？")) return;
    setStoryboarding(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/storyboard`), {
        method: "POST", headers, body: JSON.stringify({ n_panels: nPanels, replace: true }),
      });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!r.ok) { toastErr(d.detail || "拆分镜失败"); return; }
      toastOk(`拆出 ${d.n_panels} 格`);
      await loadDetail();
    } finally { setStoryboarding(false); }
  };

  // ── 生图 ─────────────────────────────────────────────────────────────
  const [genBusyId, setGenBusyId] = useState<number | null>(null);
  const genOne = async (panelId: number) => {
    setGenBusyId(panelId);
    try {
      const r = await fetch(API(`/panels/${panelId}/generate`), { method: "POST", headers });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!d.ok) toastErr(d.error || "生图失败");
      else toastOk("生图完成");
      await loadDetail();
    } finally { setGenBusyId(null); }
  };
  const [genAllBusy, setGenAllBusy] = useState(false);
  const genAll = async () => {
    if (!selectedId) return;
    setGenAllBusy(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/generate-all`), { method: "POST", headers });
      const d = await r.json();
      if (d.stopped === "insufficient_credits") {
        toastErr(`余额用完了：已生成 ${d.generated}/${d.total} 格`);
      } else if (d.ok) {
        toastOk(`批量生图：${d.generated}/${d.total} 格成功`);
      } else {
        toastErr(d.detail || d.error || "批量生图失败");
      }
      await loadDetail();
    } finally { setGenAllBusy(false); }
  };

  // ── 模型偏好 ─────────────────────────────────────────────────────────
  const updateModels = async (patch: { text_model_id?: number | null; image_model_id?: number | null }) => {
    if (!selectedId) return;
    await fetch(API(`/projects/${selectedId}`), {
      method: "PUT", headers, body: JSON.stringify(patch),
    });
    await loadDetail();
  };

  return (
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="studio"
        icon={BookOpen}
        title="AI 漫画工坊"
        badge={<BetaBadge />}
        hint="对话引导 AI 写故事 → 拆分镜 → 配角色卡 → 逐格生图。按 comic_story / comic_panel 扣点。"
      />

      {/* 项目列表 + 新建 */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText size={16} />
            <span className="font-medium">我的漫画项目</span>
            <Chip size="sm" variant="flat">{projects.length}</Chip>
          </div>
          <Button size="sm" variant="light" isIconOnly onPress={loadProjects}>
            <RefreshCw size={14} />
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          {/* 新建 */}
          <div className="flex gap-2 flex-wrap items-end">
            <Input label="标题" size="sm" className="w-44"
              value={newTitle} onValueChange={setNewTitle} placeholder="未命名漫画" />
            <Input label="画风提示" size="sm" className="flex-1 min-w-[200px]"
              value={newStyle} onValueChange={setNewStyle}
              placeholder="如：日系少女 / 美式卡通 / 水墨" />
            <Button size="sm" color="primary" startContent={<Plus size={14} />}
              isLoading={creating} onPress={handleCreate}>新建项目</Button>
          </div>
          {/* 列表 */}
          {loadingList ? (
            <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载中…</div>
          ) : projects.length === 0 ? (
            <p className="text-sm text-default-400">还没有项目，新建一个开始吧</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {projects.map((p) => {
                const on = p.id === selectedId;
                return (
                  <div key={p.id}
                    className={`p-3 rounded-md border-2 cursor-pointer transition ${on ? "border-secondary bg-secondary/5" : "border-default-200 hover:border-default-400"}`}
                    onClick={() => setSelectedId(p.id)}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium truncate">{p.title || "未命名"}</span>
                      <Chip size="sm" variant="flat" color={STATUS_COLOR[p.status] || "default"}>
                        {STATUS_LABEL[p.status] || p.status}
                      </Chip>
                    </div>
                    <p className="text-xs text-default-500">
                      {p.style_hint || "—"} · {p.done_count}/{p.panel_count} 格
                    </p>
                    <p className="text-[10px] text-default-400 mt-0.5">
                      {p.created_at?.slice(5, 16)}
                    </p>
                    <button type="button" className="text-[11px] text-danger mt-1 hover:underline"
                      onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}>
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {selectedId && loadingDetail && (
        <div className="flex items-center gap-2 text-sm text-default-400">
          <Spinner size="sm" /> 加载项目详情…
        </div>
      )}

      {detail && (
        <>
          {/* 模型偏好 */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <Sparkles size={16} />
              <span className="font-medium">该项目使用的 AI 模型</span>
              <span className="text-xs text-default-400">（默认走系统默认模型）</span>
            </CardHeader>
            <CardBody className="flex gap-3 flex-wrap">
              <ModelSelector usage="text"
                value={detail.project.text_model_id}
                onChange={(id) => updateModels({ text_model_id: id })}
                label="文本模型（写故事 / 拆分镜）"
                className="min-w-[260px]" />
              <ModelSelector usage="image"
                value={detail.project.image_model_id}
                onChange={(id) => updateModels({ image_model_id: id })}
                label="图像模型（生格子图）"
                className="min-w-[260px]" />
            </CardBody>
          </Card>

          {/* 故事对话 */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <FileText size={16} />
              <span className="font-medium">① 对话引导写故事</span>
              <Chip size="sm" variant="flat">{detail.turns.length} 轮</Chip>
            </CardHeader>
            <CardBody className="space-y-2">
              <div className="max-h-72 overflow-y-auto space-y-2 p-2 rounded bg-default-50 border border-default-200">
                {detail.turns.length === 0 ? (
                  <p className="text-xs text-default-400">对 AI 说"我想做一个关于..."开始吧</p>
                ) : detail.turns.map((t) => (
                  <div key={t.id} className={`text-sm p-2 rounded ${t.role === "user" ? "bg-primary/10 ml-8" : "bg-default-100 mr-8"}`}>
                    <p className="text-[10px] text-default-500 mb-1">{t.role === "user" ? "你" : "AI 编剧"}</p>
                    <p className="whitespace-pre-wrap">{t.content}</p>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input size="sm" className="flex-1"
                  placeholder='如："我想做一个赛博朋克下小猫咪当侦探的故事"'
                  value={chatMsg} onValueChange={setChatMsg}
                  onKeyDown={(e) => { if (e.key === "Enter" && !chatBusy) handleChat(); }} />
                <Button size="sm" color="primary" startContent={<Send size={14} />}
                  isLoading={chatBusy} isDisabled={!chatMsg.trim()}
                  onPress={handleChat}>发送（扣 comic_story）</Button>
              </div>
            </CardBody>
          </Card>

          {/* 故事梗概 */}
          <Card>
            <CardHeader className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileText size={16} />
                <span className="font-medium">② 故事梗概（定稿后才能拆分镜）</span>
              </div>
              <Button size="sm" color="primary" variant="flat"
                onPress={saveSynopsis}>保存定稿</Button>
            </CardHeader>
            <CardBody>
              <Textarea minRows={5} maxRows={12}
                placeholder="把上面对话定下来的故事写成一段 200-400 字的梗概（也可以让 AI 在对话里说『定稿』给你写好直接复制过来）"
                value={synopsisDraft} onValueChange={setSynopsisDraft} />
            </CardBody>
          </Card>

          {/* 角色卡 */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <UsersIcon size={16} />
              <span className="font-medium">③ 角色卡</span>
              <Chip size="sm" variant="flat">{detail.characters.length}</Chip>
              <span className="text-xs text-default-400">（外貌描述会拼进每格的生图 prompt 保持一致）</span>
            </CardHeader>
            <CardBody className="space-y-2">
              {detail.characters.map((c) => (
                <div key={c.id} className="flex items-start gap-2 p-2 rounded border border-default-200">
                  <div className="flex-1">
                    <p className="font-medium text-sm">{c.name}</p>
                    <p className="text-xs text-default-500">{c.appearance || "（无外貌描述）"}</p>
                  </div>
                  <Button size="sm" variant="light" color="danger" isIconOnly
                    onPress={() => delChar(c.id)}><Trash2 size={14} /></Button>
                </div>
              ))}
              <div className="flex gap-2 flex-wrap items-end">
                <Input label="角色名" size="sm" className="w-32"
                  value={charName} onValueChange={setCharName} placeholder="如：小猫" />
                <Input label="外貌描述" size="sm" className="flex-1 min-w-[260px]"
                  value={charApp} onValueChange={setCharApp}
                  placeholder="如：一只穿着风衣的橘猫，戴着圆框墨镜，叼着小烟斗" />
                <Button size="sm" color="primary" startContent={<Plus size={14} />}
                  onPress={addChar}>添加</Button>
              </div>
            </CardBody>
          </Card>

          {/* 拆分镜 + 格子 */}
          <Card>
            <CardHeader className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <ImageIcon size={16} />
                <span className="font-medium">④ 分镜 & 生图</span>
                <Chip size="sm" variant="flat">{detail.panels.length} 格 / 已生 {detail.panels.filter((p) => p.image_url).length}</Chip>
              </div>
              <div className="flex items-center gap-2">
                <Input size="sm" type="number" className="w-24" label="目标格数" labelPlacement="outside"
                  value={String(nPanels)} onValueChange={(v) => setNPanels(Math.max(4, Math.min(20, Number(v) || 8)))} />
                <Button size="sm" color="warning" variant="flat"
                  startContent={<Sparkles size={14} />}
                  isLoading={storyboarding}
                  isDisabled={!detail.project.synopsis}
                  onPress={doStoryboard}>
                  AI 拆分镜（扣 comic_story）
                </Button>
                <Button size="sm" color="primary"
                  startContent={<ImageIcon size={14} />}
                  isLoading={genAllBusy}
                  isDisabled={!detail.panels.some((p) => p.gen_status !== "done")}
                  onPress={genAll}>
                  全部生图
                </Button>
              </div>
            </CardHeader>
            <CardBody className="space-y-3">
              {!detail.project.synopsis && (
                <p className="text-xs text-warning-600">请先在 ② 定稿故事梗概，才能拆分镜。</p>
              )}
              {detail.panels.length === 0 ? (
                <p className="text-sm text-default-400">还没有分镜。定稿梗概后点上方"AI 拆分镜"。</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                  {detail.panels.map((pn) => (
                    <div key={pn.id} className="rounded border border-default-200 p-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <Chip size="sm" variant="flat">第 {pn.seq} 格</Chip>
                        <Chip size="sm" variant="flat"
                          color={pn.gen_status === "done" ? "success" : pn.gen_status === "error" ? "danger" : pn.gen_status === "generating" ? "primary" : "default"}>
                          {pn.gen_status}
                        </Chip>
                      </div>
                      <div className="aspect-square bg-default-100 rounded overflow-hidden flex items-center justify-center">
                        {pn.image_url ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={pn.image_url} alt={`panel ${pn.seq}`}
                            className="w-full h-full object-cover" />
                        ) : pn.gen_status === "generating" ? (
                          <Spinner size="sm" color="primary" />
                        ) : (
                          <ImageIcon size={28} className="text-default-300" />
                        )}
                      </div>
                      <p className="text-xs whitespace-pre-wrap text-default-700 max-h-24 overflow-y-auto">
                        {pn.script_text}
                      </p>
                      {pn.char_names.length > 0 && (
                        <p className="text-[10px] text-default-500">角色：{pn.char_names.join(" / ")}</p>
                      )}
                      {pn.gen_error && (
                        <p className="text-[10px] text-danger">{pn.gen_error.slice(0, 100)}</p>
                      )}
                      <div className="flex gap-1 pt-1">
                        <Button size="sm" variant="flat" color="primary"
                          startContent={<Sparkles size={12} />}
                          isLoading={genBusyId === pn.id}
                          onPress={() => genOne(pn.id)}>
                          {pn.image_url ? "重生" : "生图"}
                        </Button>
                        {pn.image_url && !pn.image_url.startsWith("data:") && (
                          <Button size="sm" variant="light" as="a" href={pn.image_url}
                            target="_blank" rel="noreferrer" startContent={<Download size={12} />}>
                            下载
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
