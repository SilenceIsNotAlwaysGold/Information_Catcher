"use client";

/**
 * AI 小说工坊 —— 项目 + 大纲 + 角色 + 一章一章生成。
 * 参考 NovelMaker 的工作流（精简版）。计费：novel_outline / novel_chapter。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import {
  ScrollText, Plus, Trash2, Sparkles, RefreshCw, FileText, Users as UsersIcon, Download,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/studio/novel${p}`;

const GENRES = [
  ["xuanhuan", "玄幻"], ["dushi", "都市"], ["xuanyi", "悬疑"],
  ["yanqing", "言情"], ["wuxia", "武侠"], ["kehuan", "科幻"],
  ["lishi", "历史"], ["qihuan", "奇幻"], ["qingchun", "青春"], ["qita", "其它"],
] as const;

type Project = {
  id: number; user_id: number; title: string; genre: string; premise: string;
  outline: string; style_hint: string; status: string;
  text_model_id: number | null;
  created_at: string; updated_at: string;
  chapter_count: number; total_chars: number;
};
type Chapter = { id: number; seq: number; title: string; summary: string; char_count: number; created_at: string };
type Character = { id: number; name: string; role: string; profile: string };
type Detail = { project: Project; characters: Character[]; chapters: Chapter[] };

export default function NovelStudioPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 新建表单
  const [newTitle, setNewTitle] = useState("");
  const [newGenre, setNewGenre] = useState("dushi");
  const [newPremise, setNewPremise] = useState("");
  const [newStyle, setNewStyle] = useState("网文白话");
  const [creating, setCreating] = useState(false);

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoadingList(true);
    try {
      const r = await fetch(API("/projects"), { headers });
      if (r.ok) {
        const d = await r.json();
        setProjects(d.projects || []);
        if (selectedId === null && typeof window !== "undefined") {
          const id = new URL(window.location.href).searchParams.get("id");
          if (id) setSelectedId(Number(id));
          else if (d.projects?.length) setSelectedId(d.projects[0].id);
        }
      }
    } finally { setLoadingList(false); }
  }, [token, headers, selectedId]);
  useEffect(() => { loadList(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  useEffect(() => {
    if (typeof window === "undefined" || selectedId === null) return;
    const u = new URL(window.location.href);
    u.searchParams.set("id", String(selectedId));
    window.history.replaceState({}, "", u.toString());
  }, [selectedId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) { setDetail(null); return; }
    setLoadingDetail(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}`), { headers });
      if (r.ok) setDetail(await r.json());
    } finally { setLoadingDetail(false); }
  }, [selectedId, headers]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  const handleCreate = async () => {
    if (!newPremise.trim()) { toastErr("请写一句话 premise"); return; }
    setCreating(true);
    try {
      const r = await fetch(API("/projects"), {
        method: "POST", headers,
        body: JSON.stringify({
          title: newTitle, genre: newGenre, premise: newPremise, style_hint: newStyle,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toastErr(d.detail || "创建失败"); return; }
      setNewTitle(""); setNewPremise("");
      await loadList(); setSelectedId(d.id);
      toastOk("项目已创建，下一步：生大纲");
    } finally { setCreating(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("删除该小说项目？章节/角色都会一起删掉，无法恢复。")) return;
    const r = await fetch(API(`/projects/${id}`), { method: "DELETE", headers });
    if (r.ok) {
      if (selectedId === id) setSelectedId(null);
      await loadList();
    }
  };

  // ── 大纲 ───────────────────────────────────────────────────────────────
  const [outlineDraft, setOutlineDraft] = useState("");
  useEffect(() => { setOutlineDraft(detail?.project.outline || ""); }, [detail?.project.id]);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const aiGenOutline = async () => {
    if (!selectedId) return;
    setOutlineBusy(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/outline/generate`), {
        method: "POST", headers,
      });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!r.ok) { toastErr(d.detail || "生大纲失败"); return; }
      setOutlineDraft(d.outline || "");
      toastOk("大纲已生成（已保存到项目）");
      await loadDetail();
    } finally { setOutlineBusy(false); }
  };
  const saveOutline = async () => {
    if (!selectedId) return;
    const r = await fetch(API(`/projects/${selectedId}/outline`), {
      method: "PUT", headers, body: JSON.stringify({ outline: outlineDraft }),
    });
    if (r.ok) { toastOk("大纲已保存"); await loadDetail(); }
  };

  // ── 角色卡 ─────────────────────────────────────────────────────────────
  const [cName, setCName] = useState("");
  const [cRole, setCRole] = useState("");
  const [cProfile, setCProfile] = useState("");
  const addChar = async () => {
    if (!selectedId || !cName.trim()) { toastErr("角色名必填"); return; }
    const r = await fetch(API(`/projects/${selectedId}/characters`), {
      method: "POST", headers,
      body: JSON.stringify({ name: cName.trim(), role: cRole.trim(), profile: cProfile.trim() }),
    });
    if (r.ok) { setCName(""); setCRole(""); setCProfile(""); await loadDetail(); }
  };
  const delChar = async (cid: number) => {
    if (!selectedId) return;
    const r = await fetch(API(`/projects/${selectedId}/characters/${cid}`), { method: "DELETE", headers });
    if (r.ok) await loadDetail();
  };

  // ── 章节 ───────────────────────────────────────────────────────────────
  const [hint, setHint] = useState("");
  const [targetChars, setTargetChars] = useState(2000);
  const [chapterBusy, setChapterBusy] = useState(false);
  const [openedChapter, setOpenedChapter] = useState<{ id: number; title: string; content: string } | null>(null);

  const genNextChapter = async () => {
    if (!selectedId) return;
    setChapterBusy(true);
    try {
      const r = await fetch(API(`/projects/${selectedId}/chapters/generate-next`), {
        method: "POST", headers,
        body: JSON.stringify({ hint, target_chars: targetChars }),
      });
      const d = await r.json();
      if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
      if (!r.ok) { toastErr(d.detail || "生章节失败"); return; }
      toastOk(`第 ${d.seq} 章「${d.title}」已生成（${d.char_count} 字）`);
      setHint("");
      setOpenedChapter({ id: d.id, title: d.title, content: d.content });
      await loadDetail();
    } finally { setChapterBusy(false); }
  };

  const openChapter = async (cid: number) => {
    const r = await fetch(API(`/chapters/${cid}`), { headers });
    if (r.ok) {
      const d = await r.json();
      setOpenedChapter({ id: d.id, title: d.title || `第${d.seq}章`, content: d.content || "" });
    }
  };
  const saveChapter = async () => {
    if (!openedChapter) return;
    const r = await fetch(API(`/chapters/${openedChapter.id}`), {
      method: "PUT", headers,
      body: JSON.stringify({ title: openedChapter.title, content: openedChapter.content }),
    });
    if (r.ok) { toastOk("已保存"); await loadDetail(); }
  };
  const summarizeChapter = async (cid: number) => {
    const r = await fetch(API(`/chapters/${cid}/summarize`), { method: "POST", headers });
    const d = await r.json();
    if (r.status === 402) { toastErr(`余额不足：${d.detail || ""}`); return; }
    if (r.ok) { toastOk("摘要已生成"); await loadDetail(); }
    else toastErr(d.detail || "总结失败");
  };
  const delChapter = async (cid: number) => {
    if (!confirm("删除这一章？")) return;
    const r = await fetch(API(`/chapters/${cid}`), { method: "DELETE", headers });
    if (r.ok) {
      if (openedChapter?.id === cid) setOpenedChapter(null);
      await loadDetail();
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 text-primary p-3"><ScrollText size={24} /></div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            AI 小说工坊 <Chip size="sm" variant="flat" color="primary">Beta</Chip>
          </h1>
          <p className="text-sm text-default-500 mt-1">
            题材 + premise → AI 生大纲 → 加角色 → 一章一章生（基于大纲 + 前章摘要保持连贯）。
            扣 <b>novel_outline</b>（大纲/总结）和 <b>novel_chapter</b>（一章正文）点。
          </p>
        </div>
      </div>

      {/* 新建项目 */}
      <Card>
        <CardHeader className="flex items-center gap-2">
          <Plus size={16} /><span className="font-medium">新建小说项目</span>
        </CardHeader>
        <CardBody className="space-y-2">
          <div className="flex gap-2 flex-wrap items-end">
            <Input label="标题" size="sm" className="w-44"
              value={newTitle} onValueChange={setNewTitle} placeholder="未命名小说" />
            <Select label="题材" size="sm" className="w-32"
              selectedKeys={[newGenre]}
              onSelectionChange={(k) => { const v = Array.from(k)[0]; if (v) setNewGenre(String(v)); }}>
              {GENRES.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </Select>
            <Input label="文风" size="sm" className="w-44"
              value={newStyle} onValueChange={setNewStyle} placeholder="网文白话 / 古风 / 文学化" />
          </div>
          <Textarea minRows={2} maxRows={4} size="sm"
            label="premise（一句话核心设定，必填）" labelPlacement="outside"
            value={newPremise} onValueChange={setNewPremise}
            placeholder="如：一个穿越到末世的程序员，靠会修电脑反差崛起；女主是丧尸物种学家" />
          <Button color="primary" startContent={<Plus size={14} />}
            isLoading={creating} isDisabled={!newPremise.trim()}
            onPress={handleCreate}>创建</Button>
        </CardBody>
      </Card>

      {/* 项目列表 */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText size={16} />
            <span className="font-medium">我的项目</span>
            <Chip size="sm" variant="flat">{projects.length}</Chip>
          </div>
          <Button size="sm" variant="light" isIconOnly onPress={loadList}><RefreshCw size={14} /></Button>
        </CardHeader>
        <CardBody>
          {loadingList ? (
            <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载中…</div>
          ) : projects.length === 0 ? (
            <p className="text-sm text-default-400">还没有项目，上方填表创建第一个。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {projects.map((p) => {
                const on = p.id === selectedId;
                const g = GENRES.find((x) => x[0] === p.genre)?.[1] || p.genre;
                return (
                  <div key={p.id}
                    className={`p-3 rounded-md border-2 cursor-pointer transition ${on ? "border-primary bg-primary/5" : "border-default-200 hover:border-default-400"}`}
                    onClick={() => setSelectedId(p.id)}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium truncate">{p.title || "未命名"}</span>
                      <Chip size="sm" variant="flat">{g}</Chip>
                    </div>
                    <p className="text-xs text-default-500">{p.chapter_count} 章 · {p.total_chars.toLocaleString()} 字</p>
                    <p className="text-[10px] text-default-400 mt-0.5">{p.updated_at?.slice(5, 16)}</p>
                    <button type="button" className="text-[11px] text-danger mt-1 hover:underline"
                      onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}>删除</button>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {selectedId && loadingDetail && (
        <div className="flex items-center gap-2 text-sm text-default-400"><Spinner size="sm" /> 加载项目…</div>
      )}

      {detail && (
        <>
          {/* 大纲 */}
          <Card>
            <CardHeader className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FileText size={16} /><span className="font-medium">① 大纲</span>
                <Chip size="sm" variant="flat">{outlineDraft.length} 字</Chip>
              </div>
              <div className="flex gap-2">
                <Button size="sm" color="secondary" variant="flat"
                  startContent={<Sparkles size={14} />}
                  isLoading={outlineBusy}
                  isDisabled={!detail.project.premise}
                  onPress={aiGenOutline}>AI 生大纲</Button>
                <Button size="sm" color="primary" onPress={saveOutline}>保存</Button>
              </div>
            </CardHeader>
            <CardBody>
              <Textarea minRows={6} maxRows={20}
                placeholder="点上方「AI 生大纲」让 AI 写，也可以手敲（800-1500 字，含主要人物 + 三幕情节 + 转折点）"
                value={outlineDraft} onValueChange={setOutlineDraft} />
              <p className="text-[11px] text-default-400 mt-1">
                premise：{detail.project.premise || "（项目没填）"}
              </p>
            </CardBody>
          </Card>

          {/* 角色 */}
          <Card>
            <CardHeader className="flex items-center gap-2">
              <UsersIcon size={16} /><span className="font-medium">② 角色卡</span>
              <Chip size="sm" variant="flat">{detail.characters.length}</Chip>
              <span className="text-xs text-default-400">（profile 会拼进章节生成的 prompt 保持人物一致）</span>
            </CardHeader>
            <CardBody className="space-y-2">
              {detail.characters.map((c) => (
                <div key={c.id} className="flex items-start gap-2 p-2 rounded border border-default-200">
                  <div className="flex-1">
                    <p className="text-sm"><b>{c.name}</b>{c.role ? <span className="text-default-400 ml-2">{c.role}</span> : null}</p>
                    <p className="text-xs text-default-500 whitespace-pre-wrap">{c.profile || "（无 profile）"}</p>
                  </div>
                  <Button size="sm" variant="light" color="danger" isIconOnly
                    onPress={() => delChar(c.id)}><Trash2 size={14} /></Button>
                </div>
              ))}
              <div className="flex gap-2 flex-wrap items-end">
                <Input label="角色名" size="sm" className="w-32"
                  value={cName} onValueChange={setCName} placeholder="陈余" />
                <Input label="角色定位" size="sm" className="w-28"
                  value={cRole} onValueChange={setCRole} placeholder="主角/配角/反派" />
                <Input label="profile（性格/背景/外貌/关系）" size="sm" className="flex-1 min-w-[260px]"
                  value={cProfile} onValueChange={setCProfile} placeholder="冷静、刀子嘴豆腐心；前世程序员；中等身材；与女主青梅竹马" />
                <Button size="sm" color="primary" startContent={<Plus size={14} />}
                  onPress={addChar}>添加</Button>
              </div>
            </CardBody>
          </Card>

          {/* 章节列表 + 生成下一章 */}
          <Card>
            <CardHeader className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <FileText size={16} /><span className="font-medium">③ 章节</span>
                <Chip size="sm" variant="flat">{detail.chapters.length} 章 · {detail.chapters.reduce((s, c) => s + c.char_count, 0).toLocaleString()} 字</Chip>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Input size="sm" className="w-64" placeholder="本章引导（可空，如：让主角遇到第一个反派）"
                  value={hint} onValueChange={setHint} />
                <Input size="sm" type="number" className="w-24" label="目标字数" labelPlacement="outside"
                  value={String(targetChars)}
                  onValueChange={(v) => setTargetChars(Math.max(800, Math.min(5000, Number(v) || 2000)))} />
                <Button size="sm" color="primary" startContent={<Sparkles size={14} />}
                  isLoading={chapterBusy}
                  isDisabled={!detail.project.outline}
                  onPress={genNextChapter}>AI 生下一章</Button>
              </div>
            </CardHeader>
            <CardBody className="space-y-2">
              {!detail.project.outline && (
                <p className="text-xs text-warning-600">请先在 ① 生大纲或手写大纲，才能写章节。</p>
              )}
              {detail.chapters.length === 0 ? (
                <p className="text-sm text-default-400">还没章节，点上面"AI 生下一章"开始。</p>
              ) : (
                <div className="space-y-1">
                  {detail.chapters.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2 p-2 rounded border border-default-200 hover:bg-default-50">
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openChapter(c.id)}>
                        <p className="font-medium text-sm">第 {c.seq} 章 · {c.title}</p>
                        <p className="text-xs text-default-500 truncate">{c.summary || "（无摘要，点摘要按钮生成）"}</p>
                      </div>
                      <Chip size="sm" variant="flat" className="shrink-0">{c.char_count.toLocaleString()} 字</Chip>
                      <Button size="sm" variant="light" onPress={() => summarizeChapter(c.id)}>
                        摘要
                      </Button>
                      <Button size="sm" variant="light" color="danger" isIconOnly
                        onPress={() => delChapter(c.id)}><Trash2 size={14} /></Button>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* 当前打开的章节正文编辑 */}
          {openedChapter && (
            <Card>
              <CardHeader className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Input size="sm" value={openedChapter.title}
                    onValueChange={(v) => setOpenedChapter((s) => s ? { ...s, title: v } : null)}
                    placeholder="章节标题" className="w-64" />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" color="primary" onPress={saveChapter}>保存</Button>
                  <Button size="sm" variant="light"
                    as="a" href={`data:text/plain;charset=utf-8,${encodeURIComponent(openedChapter.title + "\n\n" + openedChapter.content)}`}
                    download={`${openedChapter.title || "chapter"}.txt`}
                    startContent={<Download size={14} />}>下载 txt</Button>
                  <Button size="sm" variant="light" onPress={() => setOpenedChapter(null)}>关闭</Button>
                </div>
              </CardHeader>
              <CardBody>
                <Textarea minRows={12} maxRows={40}
                  value={openedChapter.content}
                  onValueChange={(v) => setOpenedChapter((s) => s ? { ...s, content: v } : null)} />
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
