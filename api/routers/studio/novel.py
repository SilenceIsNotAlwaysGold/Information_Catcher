# -*- coding: utf-8 -*-
"""AI 小说 —— 项目 + 大纲 + 角色 + 一章一章生成（基于大纲 + 前章 summary 连贯）。

参考 NovelMaker 的工作流（精简版），走 ai_client 平台模型 + 计费：
  novel_outline — 生大纲 / 总结某章
  novel_chapter — 生一章正文
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ...services import ai_client, monitor_db
from ...services import db as _db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio/novel", tags=["AI-Studio-Novel"])
DB_PATH = monitor_db.DB_PATH


GENRE_LABEL = {
    "xuanhuan": "玄幻", "dushi": "都市", "xuanyi": "悬疑",
    "yanqing": "言情", "wuxia": "武侠", "kehuan": "科幻", "lishi": "历史",
    "qihuan": "奇幻", "qingchun": "青春", "qita": "其它",
}


async def _project_or_404(pid: int, user_id: int) -> Dict[str, Any]:
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM novel_projects WHERE id=? AND user_id=?", (int(pid), int(user_id)),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "小说项目不存在或无权访问")
    return dict(row)


async def _touch(pid: int, **fields):
    sets = ["updated_at=datetime('now','localtime')"]
    vals: List[Any] = []
    for k, v in fields.items():
        sets.append(f"{k}=?"); vals.append(v)
    vals.append(int(pid))
    async with _db.connect(DB_PATH) as db:
        await db.execute(f"UPDATE novel_projects SET {', '.join(sets)} WHERE id=?", vals)
        await db.commit()


# ── 项目 CRUD ────────────────────────────────────────────────────────────

class CreateProjectIn(BaseModel):
    title: str = ""
    genre: str = "qita"
    premise: str = Field("", max_length=1000)
    style_hint: str = ""
    text_model_id: Optional[int] = None


@router.post("/projects", summary="新建小说项目")
async def create_project(body: CreateProjectIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO novel_projects(user_id, title, genre, premise, style_hint, text_model_id, status) "
            "VALUES (?,?,?,?,?,?, 'planning')",
            (uid, (body.title or "未命名小说").strip()[:80], (body.genre or "qita").strip()[:20],
             (body.premise or "").strip()[:1000], (body.style_hint or "").strip()[:200],
             body.text_model_id),
        )
        await db.commit()
        return {"ok": True, "id": cur.lastrowid}


@router.get("/projects", summary="我的小说项目列表")
async def list_projects(current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT p.*, "
            " (SELECT COUNT(*) FROM novel_chapters WHERE project_id=p.id) AS chapter_count, "
            " (SELECT COALESCE(SUM(char_count),0) FROM novel_chapters WHERE project_id=p.id) AS total_chars "
            "FROM novel_projects p WHERE p.user_id=? "
            "ORDER BY p.updated_at DESC, p.id DESC",
            (uid,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"projects": rows}


@router.get("/projects/{pid}", summary="项目详情（含大纲+角色+章节列表）")
async def get_project_detail(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT id, name, role, profile FROM novel_characters WHERE project_id=? ORDER BY id",
            (int(pid),),
        ) as cur:
            chars = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT id, seq, title, summary, char_count, created_at FROM novel_chapters "
            "WHERE project_id=? ORDER BY seq, id",
            (int(pid),),
        ) as cur:
            chapters = [dict(r) for r in await cur.fetchall()]
    return {"project": p, "characters": chars, "chapters": chapters}


@router.delete("/projects/{pid}", summary="删除小说项目（连同章节/角色）")
async def delete_project(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        await db.execute("DELETE FROM novel_chapters WHERE project_id=?", (int(pid),))
        await db.execute("DELETE FROM novel_characters WHERE project_id=?", (int(pid),))
        await db.execute("DELETE FROM novel_projects WHERE id=?", (int(pid),))
        await db.commit()
    return {"ok": True}


class UpdateOutlineIn(BaseModel):
    outline: str


@router.put("/projects/{pid}/outline", summary="编辑大纲（手写）")
async def edit_outline(pid: int, body: UpdateOutlineIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    await _touch(pid, outline=(body.outline or "").strip()[:20000], status="writing")
    return {"ok": True}


# ── AI 生大纲 ────────────────────────────────────────────────────────────

_OUTLINE_SYSTEM = (
    "你是网络小说大纲师。根据用户给的题材、文风、premise（核心设定），"
    "写一份可执行的大纲：包含主要人物（一两句话外貌+性格+核心动机）、"
    "至少三幕的情节走向（开端 → 发展冲突 → 高潮反转 → 收尾）、"
    "若干关键转折点（用 *** 标记）。语言精炼，画面感强，长度 800-1500 字。"
    "直接输出大纲正文，不要 Markdown 标题，不要多余解释。"
)


@router.post("/projects/{pid}/outline/generate", summary="AI 生大纲（扣 novel_outline 点）")
async def generate_outline(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _project_or_404(pid, uid)
    premise = (p.get("premise") or "").strip()
    if not premise:
        raise HTTPException(400, "请先在项目里写一句话 premise 再生大纲")
    g = GENRE_LABEL.get(p.get("genre") or "", p.get("genre") or "")
    style = (p.get("style_hint") or "").strip()
    prompt = (
        f"题材：{g}\n文风：{style or '网文白话'}\n\n核心设定（premise）：\n{premise}\n\n"
        "请输出大纲。"
    )
    outline = await ai_client.call_text(
        prompt, model_id=p.get("text_model_id"), user_id=uid,
        feature="novel_outline", system_prompt=_OUTLINE_SYSTEM,
        temperature=0.85, max_tokens=2500,
        task_ref=ai_client.make_task_ref("novel_outline", pid),
    )
    await _touch(pid, outline=outline.strip()[:20000], status="writing")
    return {"ok": True, "outline": outline}


# ── 角色卡 ───────────────────────────────────────────────────────────────

class CharIn(BaseModel):
    name: str
    role: str = ""
    profile: str = ""


@router.post("/projects/{pid}/characters", summary="加角色卡")
async def add_character(pid: int, body: CharIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    if not body.name.strip():
        raise HTTPException(400, "角色名不能为空")
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO novel_characters(project_id, name, role, profile) VALUES (?,?,?,?)",
            (int(pid), body.name.strip()[:40], (body.role or "").strip()[:40],
             (body.profile or "").strip()[:2000]),
        )
        await db.commit()
        return {"ok": True, "id": cur.lastrowid}


@router.put("/projects/{pid}/characters/{cid}", summary="改角色卡")
async def update_character(pid: int, cid: int, body: CharIn,
                           current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE novel_characters SET name=?, role=?, profile=? "
            "WHERE id=? AND project_id=?",
            (body.name.strip()[:40], (body.role or "").strip()[:40],
             (body.profile or "").strip()[:2000], int(cid), int(pid)),
        )
        await db.commit()
    return {"ok": True}


@router.delete("/projects/{pid}/characters/{cid}", summary="删角色卡")
async def delete_character(pid: int, cid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM novel_characters WHERE id=? AND project_id=?", (int(cid), int(pid)),
        )
        await db.commit()
    return {"ok": True}


# ── 章节生成 ─────────────────────────────────────────────────────────────

_CHAPTER_SYSTEM = (
    "你是网络小说作者。根据给定的大纲、角色设定和前几章的剧情摘要，写下一章。"
    "要点：开篇接得上前一章，章节内有起承转合，对话生动，环境刻画到位，"
    "推进至少一个剧情节点。章节标题简洁有钩子。长度 1500-3000 字。"
    "输出格式：第一行是【章节标题】，空一行后是正文，正文中不要加章节号。"
)


class GenChapterIn(BaseModel):
    hint: str = ""           # 用户给的本章引导："写到主角偶遇神秘老人 / 让女主黑化"
    target_chars: int = 2000  # 期望字数


def _approx_char_count(s: str) -> int:
    return len([c for c in s if c.strip()])


@router.post("/projects/{pid}/chapters/generate-next", summary="AI 生下一章（扣 novel_chapter 点）")
async def generate_next_chapter(
    pid: int, body: GenChapterIn,
    current_user: dict = Depends(get_current_user),
):
    uid = int(current_user["id"])
    p = await _project_or_404(pid, uid)
    outline = (p.get("outline") or "").strip()
    if not outline:
        raise HTTPException(400, "请先生大纲或手写大纲再生章节")
    # 取角色 + 前章 summary
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT name, role, profile FROM novel_characters WHERE project_id=? ORDER BY id",
            (int(pid),),
        ) as cur:
            chars = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT seq, title, summary FROM novel_chapters WHERE project_id=? ORDER BY seq",
            (int(pid),),
        ) as cur:
            prev = [dict(r) for r in await cur.fetchall()]
    next_seq = (prev[-1]["seq"] + 1) if prev else 1
    chars_txt = "\n".join(
        f"- {c['name']}（{c['role'] or '配角'}）: {c['profile'] or '无设定'}" for c in chars
    ) or "（暂无角色卡）"
    prev_txt = "\n".join(
        f"第 {c['seq']} 章「{c['title'] or '?'}」: {c['summary'] or '无摘要'}"
        for c in prev[-5:]   # 只喂最近 5 章 summary
    ) or "（这是第 1 章）"
    style = (p.get("style_hint") or "").strip()
    user_prompt = (
        f"小说题材：{GENRE_LABEL.get(p.get('genre') or '', p.get('genre') or '')}\n"
        f"文风：{style or '网文白话'}\n\n"
        f"大纲（必须遵循推进）：\n{outline}\n\n"
        f"角色：\n{chars_txt}\n\n"
        f"前几章摘要：\n{prev_txt}\n\n"
        f"现在写第 {next_seq} 章。{('本章引导：' + body.hint) if body.hint else ''}"
        f"目标字数约 {max(800, min(int(body.target_chars or 2000), 5000))} 字。"
    )
    out = await ai_client.call_text(
        user_prompt, model_id=p.get("text_model_id"), user_id=uid,
        feature="novel_chapter", system_prompt=_CHAPTER_SYSTEM,
        temperature=0.95, max_tokens=4500,
        task_ref=ai_client.make_task_ref("novel_chapter", pid, next_seq),
    )
    # 拆标题（第一行是【标题】）
    lines = (out or "").strip().split("\n", 1)
    title = ""
    content = out or ""
    if lines:
        first = lines[0].strip().strip("【】").strip()
        if first and len(first) < 40:
            title = first
            content = lines[1].strip() if len(lines) > 1 else ""
    if not content:
        raise HTTPException(502, "AI 没产出章节正文")
    cc = _approx_char_count(content)
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO novel_chapters(project_id, seq, title, content, char_count) VALUES (?,?,?,?,?)",
            (int(pid), int(next_seq), title or f"第{next_seq}章", content[:30000], cc),
        )
        await db.commit()
        ch_id = cur.lastrowid
    await _touch(pid)
    return {"ok": True, "id": ch_id, "seq": next_seq, "title": title, "content": content, "char_count": cc}


@router.get("/chapters/{cid}", summary="某章正文")
async def get_chapter(cid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT c.* FROM novel_chapters c JOIN novel_projects p ON c.project_id=p.id "
            "WHERE c.id=? AND p.user_id=?",
            (int(cid), uid),
        ) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "章节不存在或无权访问")
    return dict(row)


class UpdateChapterIn(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    summary: Optional[str] = None


@router.put("/chapters/{cid}", summary="编辑章节")
async def update_chapter(cid: int, body: UpdateChapterIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT c.id, c.project_id FROM novel_chapters c "
            "JOIN novel_projects p ON c.project_id=p.id WHERE c.id=? AND p.user_id=?",
            (int(cid), uid),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "章节不存在或无权访问")
        sets, vals = [], []
        if body.title is not None:
            sets.append("title=?"); vals.append(body.title.strip()[:80])
        if body.content is not None:
            cc = _approx_char_count(body.content)
            sets.append("content=?"); vals.append(body.content[:30000])
            sets.append("char_count=?"); vals.append(cc)
        if body.summary is not None:
            sets.append("summary=?"); vals.append(body.summary.strip()[:2000])
        if sets:
            vals.append(int(cid))
            await db.execute(f"UPDATE novel_chapters SET {', '.join(sets)} WHERE id=?", vals)
            await db.commit()
        # touch project
        async with db.execute("SELECT project_id FROM novel_chapters WHERE id=?", (int(cid),)) as cur:
            r = await cur.fetchone()
    if r:
        await _touch(int(r["project_id"]))
    return {"ok": True}


@router.delete("/chapters/{cid}", summary="删章节")
async def delete_chapter(cid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT c.id FROM novel_chapters c JOIN novel_projects p ON c.project_id=p.id "
            "WHERE c.id=? AND p.user_id=?",
            (int(cid), uid),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "章节不存在或无权访问")
        await db.execute("DELETE FROM novel_chapters WHERE id=?", (int(cid),))
        await db.commit()
    return {"ok": True}


_SUMMARY_SYSTEM = (
    "你是小说编辑。请给下面这章正文写一段 100-200 字的剧情摘要，"
    "重点抓：发生了什么、人物动机变化、留下的钩子。只输出摘要本身。"
)


@router.post("/chapters/{cid}/summarize", summary="AI 总结某章为摘要（扣 novel_outline 点）")
async def summarize_chapter(cid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT c.*, p.text_model_id, p.user_id AS owner FROM novel_chapters c "
            "JOIN novel_projects p ON c.project_id=p.id WHERE c.id=?",
            (int(cid),),
        ) as cur:
            row = await cur.fetchone()
        if not row or int(row["owner"]) != uid:
            raise HTTPException(404, "章节不存在或无权访问")
    content = (row["content"] or "").strip()
    if not content:
        raise HTTPException(400, "章节没有正文")
    summary = await ai_client.call_text(
        content[:8000], model_id=row["text_model_id"], user_id=uid,
        feature="novel_outline", system_prompt=_SUMMARY_SYSTEM,
        temperature=0.4, max_tokens=400,
        task_ref=ai_client.make_task_ref("novel_summary", cid),
    )
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE novel_chapters SET summary=? WHERE id=?", (summary.strip()[:2000], int(cid)),
        )
        await db.commit()
    return {"ok": True, "summary": summary}
