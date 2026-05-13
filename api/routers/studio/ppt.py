# -*- coding: utf-8 -*-
"""AI PPT —— 输入主题 → AI 生大纲 JSON → python-pptx 渲染 .pptx。

计费：
  ppt_outline   — 生成大纲（一次 LLM 调用）
  （渲染本身不耗 AI；不计费）

后续可加：上传用户已有 .pptx 让 AI 改造（按用户指令重写某页/扩充某页/换风格）。
"""
from __future__ import annotations

import io
import json
import logging
import os
import tempfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ...services import ai_client, monitor_db, storage
from ...services import db as _db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio/ppt", tags=["AI-Studio-PPT"])
DB_PATH = monitor_db.DB_PATH

# 用户的 PPTX 缓存目录（不上传到对象存储时直接 file 返）
_PPT_CACHE_DIR = os.path.join(tempfile.gettempdir(), "pulse_ppt_cache")
os.makedirs(_PPT_CACHE_DIR, exist_ok=True)


# ── DB helpers ───────────────────────────────────────────────────────────

async def _get_project(pid: int, user_id: int):
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM ppt_projects WHERE id=? AND user_id=?", (int(pid), int(user_id)),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def _touch(pid: int, **fields):
    sets = ["updated_at=datetime('now','localtime')"]
    vals: List[Any] = []
    for k, v in fields.items():
        sets.append(f"{k}=?"); vals.append(v)
    vals.append(int(pid))
    async with _db.connect(DB_PATH) as db:
        await db.execute(f"UPDATE ppt_projects SET {', '.join(sets)} WHERE id=?", vals)
        await db.commit()


# ── AI 生大纲 ────────────────────────────────────────────────────────────

_OUTLINE_SYSTEM = """你是 PPT 内容策划。根据用户给的主题、目标页数、观众和风格，
输出每页的标题 + 3-5 条要点（bullet points）。
严格只输出 JSON（不要任何代码块标记或解释），格式：
{"title":"整套 PPT 的总标题","pages":[{"title":"页标题","bullets":["要点1","要点2","要点3"]}, ...]}
要点要言之有物（不要"概述"、"介绍"这种空话），每条 12-30 字。
"""


class CreateProjectIn(BaseModel):
    title: str = ""
    topic: str = Field(..., min_length=2, max_length=500)
    target_pages: int = Field(10, ge=3, le=30)
    style_hint: str = ""
    audience: str = ""
    text_model_id: Optional[int] = None


def _strip_codeblock(s: str) -> str:
    t = s.strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t.lower().startswith("json"):
            t = t[4:].strip()
    return t


@router.post("/projects", summary="新建项目 + AI 生大纲（扣 ppt_outline 点）")
async def create_project(body: CreateProjectIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    user_prompt = (
        f"PPT 主题：{body.topic.strip()}\n"
        f"目标页数：{body.target_pages} 页\n"
        f"目标观众：{body.audience or '通用'}\n"
        f"风格：{body.style_hint or '商务简洁'}\n\n"
        f"请输出大纲 JSON。"
    )
    raw = await ai_client.call_text(
        user_prompt, model_id=body.text_model_id, user_id=uid,
        feature="ppt_outline", system_prompt=_OUTLINE_SYSTEM,
        temperature=0.7, max_tokens=3000,
    )
    txt = _strip_codeblock(raw)
    try:
        plan = json.loads(txt)
        if not isinstance(plan, dict) or not isinstance(plan.get("pages"), list) or not plan["pages"]:
            raise ValueError("缺 pages")
    except Exception as e:
        raise HTTPException(
            502,
            f"AI 返回的大纲不是合法 JSON：{str(e)[:100]}；原始（前 200 字符）：{raw[:200]}",
        )
    title = (body.title or plan.get("title") or body.topic).strip()[:100]
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO ppt_projects(user_id, title, topic, target_pages, style_hint, audience, "
            "plan_json, status, text_model_id) VALUES (?,?,?,?,?,?,?, 'outlined', ?)",
            (uid, title, body.topic.strip()[:500], int(body.target_pages),
             body.style_hint.strip()[:80], body.audience.strip()[:80],
             json.dumps(plan, ensure_ascii=False), body.text_model_id),
        )
        await db.commit()
        pid = cur.lastrowid
    return {"ok": True, "id": pid, "title": title, "plan": plan}


@router.get("/projects", summary="我的 PPT 项目列表")
async def list_projects(current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT id, title, topic, target_pages, style_hint, audience, status, "
            "pptx_url, created_at, updated_at "
            "FROM ppt_projects WHERE user_id=? ORDER BY updated_at DESC, id DESC",
            (uid,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"projects": rows}


@router.get("/projects/{pid}", summary="项目详情（含大纲 JSON）")
async def get_project_detail(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _get_project(pid, uid)
    if not p:
        raise HTTPException(404, "PPT 项目不存在或无权访问")
    try:
        p["plan"] = json.loads(p.get("plan_json") or "{}")
    except Exception:
        p["plan"] = {}
    p.pop("plan_json", None)
    return p


class UpdatePlanIn(BaseModel):
    plan: Dict[str, Any]


@router.put("/projects/{pid}/plan", summary="手工编辑大纲 JSON")
async def update_plan(pid: int, body: UpdatePlanIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _get_project(pid, uid)
    if not p:
        raise HTTPException(404, "PPT 项目不存在或无权访问")
    if not isinstance(body.plan, dict) or not isinstance(body.plan.get("pages"), list):
        raise HTTPException(400, "plan 必须是 {title, pages:[{title,bullets[]}]}")
    await _touch(pid, plan_json=json.dumps(body.plan, ensure_ascii=False))
    return {"ok": True}


@router.delete("/projects/{pid}", summary="删除 PPT 项目")
async def delete_project(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _get_project(pid, uid)
    if not p:
        raise HTTPException(404, "PPT 项目不存在或无权访问")
    async with _db.connect(DB_PATH) as db:
        await db.execute("DELETE FROM ppt_projects WHERE id=?", (int(pid),))
        await db.commit()
    return {"ok": True}


# ── 渲染 .pptx ───────────────────────────────────────────────────────────

def _build_pptx(plan: Dict[str, Any], style_hint: str = "") -> bytes:
    """用 python-pptx 把大纲渲染成 .pptx 二进制。简单版：标题页 + 每页（标题 + bullets）。"""
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    # 配色（简单两套：商务深蓝 / 极简白底）
    is_dark = ("商务" in style_hint) or ("严肃" in style_hint) or ("dark" in style_hint.lower())
    bg = RGBColor(0x10, 0x21, 0x3F) if is_dark else RGBColor(0xFF, 0xFF, 0xFF)
    fg = RGBColor(0xFF, 0xFF, 0xFF) if is_dark else RGBColor(0x18, 0x20, 0x33)
    accent = RGBColor(0x4F, 0x9C, 0xF5)

    # 标题页
    cover_layout = prs.slide_layouts[6]  # blank
    slide = prs.slides.add_slide(cover_layout)
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = bg
    title_text = (plan.get("title") or "PPT").strip()
    tx = slide.shapes.add_textbox(Inches(0.8), Inches(2.6), Inches(11.7), Inches(2.2))
    tf = tx.text_frame
    tf.text = title_text
    p = tf.paragraphs[0]
    p.alignment = 1  # center
    run = p.runs[0]
    run.font.size = Pt(60)
    run.font.bold = True
    run.font.color.rgb = fg

    # 副标题：用 style_hint 或留空
    if style_hint:
        sub = slide.shapes.add_textbox(Inches(0.8), Inches(5.0), Inches(11.7), Inches(0.6))
        sf = sub.text_frame
        sf.text = style_hint
        sf.paragraphs[0].alignment = 1
        sf.paragraphs[0].runs[0].font.size = Pt(20)
        sf.paragraphs[0].runs[0].font.color.rgb = accent

    # 内容页
    pages = plan.get("pages") or []
    for i, pg in enumerate(pages, start=1):
        slide = prs.slides.add_slide(cover_layout)
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = bg
        # 页码（左下）
        page_tx = slide.shapes.add_textbox(Inches(0.5), Inches(7.0), Inches(2), Inches(0.4))
        page_tx.text_frame.text = f"{i:02d} / {len(pages):02d}"
        page_tx.text_frame.paragraphs[0].runs[0].font.size = Pt(12)
        page_tx.text_frame.paragraphs[0].runs[0].font.color.rgb = accent
        # 标题
        title_box = slide.shapes.add_textbox(Inches(0.7), Inches(0.5), Inches(12), Inches(1.0))
        tt = title_box.text_frame
        tt.text = (pg.get("title") or f"Slide {i}").strip()[:80]
        ttp = tt.paragraphs[0]
        ttp.runs[0].font.size = Pt(36)
        ttp.runs[0].font.bold = True
        ttp.runs[0].font.color.rgb = fg
        # 左侧装饰条
        from pptx.enum.shapes import MSO_SHAPE
        bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.4), Inches(0.6), Inches(0.12), Inches(0.8))
        bar.fill.solid()
        bar.fill.fore_color.rgb = accent
        bar.line.fill.background()
        # 要点
        bullets = pg.get("bullets") or []
        content_box = slide.shapes.add_textbox(Inches(0.7), Inches(1.8), Inches(12), Inches(5.0))
        cf = content_box.text_frame
        cf.word_wrap = True
        for j, b in enumerate(bullets[:8]):
            if j == 0:
                p_ = cf.paragraphs[0]
            else:
                p_ = cf.add_paragraph()
            p_.text = f"•  {str(b).strip()}"
            p_.space_after = Pt(14)
            for r in p_.runs:
                r.font.size = Pt(22)
                r.font.color.rgb = fg

    bio = io.BytesIO()
    prs.save(bio)
    return bio.getvalue()


@router.post("/projects/{pid}/render", summary="把大纲渲染成 .pptx 文件")
async def render_project(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _get_project(pid, uid)
    if not p:
        raise HTTPException(404, "PPT 项目不存在或无权访问")
    try:
        plan = json.loads(p.get("plan_json") or "{}")
    except Exception:
        raise HTTPException(400, "大纲 JSON 异常")
    if not plan.get("pages"):
        raise HTTPException(400, "大纲为空，先调用 create_project 或 PUT /plan 设大纲")
    await _touch(pid, status="rendering")
    try:
        data = _build_pptx(plan, style_hint=p.get("style_hint") or "")
    except Exception as e:
        logger.exception(f"[ppt] render failed pid={pid}: {e}")
        await _touch(pid, status="outlined")
        raise HTTPException(500, f"渲染失败：{type(e).__name__}: {str(e)[:200]}")
    # 存到本地缓存目录（next 一步如果配了 storage 也可上传，但 .pptx 比较大，本地先够用）
    fname = f"ppt_{uid}_{pid}.pptx"
    fpath = os.path.join(_PPT_CACHE_DIR, fname)
    with open(fpath, "wb") as f:
        f.write(data)
    download_url = f"/api/studio/ppt/projects/{pid}/download"
    await _touch(pid, status="done", pptx_url=download_url)
    return {"ok": True, "download_url": download_url, "size_bytes": len(data)}


@router.get("/projects/{pid}/download", summary="下载渲染好的 .pptx")
async def download_project(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _get_project(pid, uid)
    if not p:
        raise HTTPException(404, "PPT 项目不存在或无权访问")
    fname = f"ppt_{uid}_{pid}.pptx"
    fpath = os.path.join(_PPT_CACHE_DIR, fname)
    if not os.path.exists(fpath):
        raise HTTPException(404, "请先调用 /render 渲染")
    safe_name = (p.get("title") or "ppt").replace("/", "_")[:60]
    return FileResponse(
        fpath,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=f"{safe_name}.pptx",
    )
