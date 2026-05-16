# -*- coding: utf-8 -*-
"""AI 漫画 —— 对话引导写故事 → 定稿梗概 → 角色卡 → AI 拆分镜 → 逐格生图。

参考 LoreVista 的创作流程，用本项目的 FastAPI + ai_client（走平台模型 + 计费）实现。
路由前缀 /studio/comic。所有 AI 调用 user_id=当前用户，按 feature 扣点：
  comic_story  — 对话引导一轮 / 拆分镜一次（文本生成）
  comic_panel  — 生一格图

余额不足由 ai_client 抛 InsufficientCredits → 全局 handler 自动 402，
前端可据此弹"去充值"，无需在每个端点单独 catch。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import ai_client, monitor_db, storage
from ...services import db as _db
from ...services.billing_service import InsufficientCredits

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio/comic", tags=["AI-Studio-Comic"])

DB_PATH = monitor_db.DB_PATH


# ── 内部小工具 ───────────────────────────────────────────────────────────

async def _get_project(pid: int, user_id: int) -> Optional[Dict[str, Any]]:
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM comic_projects WHERE id=? AND user_id=?",
            (int(pid), int(user_id)),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def _project_or_404(pid: int, user_id: int) -> Dict[str, Any]:
    p = await _get_project(pid, user_id)
    if not p:
        raise HTTPException(404, "漫画项目不存在或无权访问")
    return p


async def _touch_project(pid: int, **fields):
    """更新项目某些字段，并刷 updated_at。"""
    sets = ["updated_at=datetime('now','localtime')"]
    vals: List[Any] = []
    for k, v in fields.items():
        sets.append(f"{k}=?")
        vals.append(v)
    vals.append(int(pid))
    async with _db.connect(DB_PATH) as db:
        await db.execute(f"UPDATE comic_projects SET {', '.join(sets)} WHERE id=?", vals)
        await db.commit()


# ── 项目 CRUD ────────────────────────────────────────────────────────────

class CreateProjectIn(BaseModel):
    title: str = ""
    style_hint: str = ""
    text_model_id: Optional[int] = None
    image_model_id: Optional[int] = None


@router.post("/projects", summary="新建漫画项目")
async def create_project(body: CreateProjectIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO comic_projects(user_id, title, style_hint, text_model_id, image_model_id, status) "
            "VALUES (?,?,?,?,?, 'drafting')",
            (uid,
             (body.title or "未命名漫画").strip()[:80],
             (body.style_hint or "").strip()[:200],
             body.text_model_id, body.image_model_id),
        )
        await db.commit()
        return {"ok": True, "id": cur.lastrowid}


@router.get("/projects", summary="我的漫画项目列表")
async def list_projects(current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT p.*, "
            " (SELECT COUNT(*) FROM comic_panels WHERE project_id=p.id) AS panel_count, "
            " (SELECT COUNT(*) FROM comic_panels WHERE project_id=p.id AND image_url != '') AS done_count "
            "FROM comic_projects p WHERE p.user_id=? "
            "ORDER BY p.updated_at DESC, p.id DESC",
            (uid,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"projects": rows}


@router.get("/projects/{pid}", summary="项目详情（含对话/角色/分镜）")
async def get_project_detail(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT id, role, content, created_at FROM comic_story_turns "
            "WHERE project_id=? ORDER BY id", (int(pid),),
        ) as cur:
            turns = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT id, name, appearance, ref_image_url FROM comic_characters "
            "WHERE project_id=? ORDER BY id", (int(pid),),
        ) as cur:
            chars = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT id, seq, script_text, char_names, image_url, image_prompt, "
            "       gen_status, gen_error "
            "FROM comic_panels WHERE project_id=? ORDER BY seq, id", (int(pid),),
        ) as cur:
            panels = []
            for r in await cur.fetchall():
                d = dict(r)
                try:
                    d["char_names"] = json.loads(d.get("char_names") or "[]")
                except Exception:
                    d["char_names"] = []
                panels.append(d)
    return {"project": p, "turns": turns, "characters": chars, "panels": panels}


class UpdateProjectIn(BaseModel):
    title: Optional[str] = None
    style_hint: Optional[str] = None
    text_model_id: Optional[int] = None
    image_model_id: Optional[int] = None


@router.put("/projects/{pid}", summary="改项目元信息")
async def update_project(pid: int, body: UpdateProjectIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    fields = {}
    if body.title is not None:
        fields["title"] = body.title.strip()[:80]
    if body.style_hint is not None:
        fields["style_hint"] = body.style_hint.strip()[:200]
    if body.text_model_id is not None:
        fields["text_model_id"] = body.text_model_id
    if body.image_model_id is not None:
        fields["image_model_id"] = body.image_model_id
    if fields:
        await _touch_project(pid, **fields)
    return {"ok": True}


@router.delete("/projects/{pid}", summary="删除漫画项目（连同对话/角色/分镜）")
async def delete_project(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        await db.execute("DELETE FROM comic_panels WHERE project_id=?", (int(pid),))
        await db.execute("DELETE FROM comic_characters WHERE project_id=?", (int(pid),))
        await db.execute("DELETE FROM comic_story_turns WHERE project_id=?", (int(pid),))
        await db.execute("DELETE FROM comic_projects WHERE id=?", (int(pid),))
        await db.commit()
    return {"ok": True}


# ── 对话引导写故事 ───────────────────────────────────────────────────────

_STORY_SYSTEM = (
    "你是一位资深漫画编剧。和用户对话，一步步帮 ta 构思出一个适合改编成短漫画的故事。"
    "原则：每次回复简洁（150 字内），主动推进——提出 1 个具体问题或给 2-3 个选项让用户选；"
    "适时建议主要角色（名字 + 一句话外貌 + 性格）；不要一次写完整故事。"
    "当用户说「定稿」「就这样」之类，给出一段 200-400 字的完整故事梗概作为收尾。"
)


class ChatIn(BaseModel):
    message: str


@router.post("/projects/{pid}/chat", summary="对话引导写故事（扣 comic_story 点）")
async def story_chat(pid: int, body: ChatIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _project_or_404(pid, uid)
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(400, "消息不能为空")
    # 取最近 12 轮历史
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT role, content FROM comic_story_turns WHERE project_id=? ORDER BY id",
            (int(pid),),
        ) as cur:
            hist = [dict(r) for r in await cur.fetchall()]
    convo = "\n".join(
        f"{'用户' if h['role']=='user' else '编剧'}：{h['content']}"
        for h in hist[-12:]
    )
    full_prompt = (
        (f"已有对话：\n{convo}\n\n" if convo else "")
        + f"用户：{msg}\n\n请作为编剧回复："
    )
    # 调 AI（扣 comic_story 点；余额不足 → InsufficientCredits → 402）
    reply = await ai_client.call_text(
        full_prompt, model_id=p.get("text_model_id"), user_id=uid,
        feature="comic_story", system_prompt=_STORY_SYSTEM,
        temperature=0.9, max_tokens=600,
    )
    # 落两轮
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO comic_story_turns(project_id, role, content) VALUES (?, 'user', ?)",
            (int(pid), msg),
        )
        await db.execute(
            "INSERT INTO comic_story_turns(project_id, role, content) VALUES (?, 'assistant', ?)",
            (int(pid), reply),
        )
        await db.commit()
    await _touch_project(pid)
    return {"reply": reply}


class SynopsisIn(BaseModel):
    synopsis: str


@router.put("/projects/{pid}/synopsis", summary="定稿故事梗概，进入分镜阶段")
async def set_synopsis(pid: int, body: SynopsisIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    syn = (body.synopsis or "").strip()
    if not syn:
        raise HTTPException(400, "梗概不能为空")
    await _touch_project(pid, synopsis=syn[:5000], status="scripting")
    return {"ok": True}


# ── 角色卡 ───────────────────────────────────────────────────────────────

class CharIn(BaseModel):
    name: str
    appearance: str = ""
    ref_image_url: str = ""


@router.post("/projects/{pid}/characters", summary="加角色卡")
async def add_character(pid: int, body: CharIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    if not body.name.strip():
        raise HTTPException(400, "角色名不能为空")
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO comic_characters(project_id, name, appearance, ref_image_url) VALUES (?,?,?,?)",
            (int(pid), body.name.strip()[:40],
             (body.appearance or "").strip()[:1000],
             (body.ref_image_url or "").strip()),
        )
        await db.commit()
        return {"ok": True, "id": cur.lastrowid}


@router.put("/projects/{pid}/characters/{cid}", summary="改角色卡")
async def update_character(pid: int, cid: int, body: CharIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE comic_characters SET name=?, appearance=?, ref_image_url=? "
            "WHERE id=? AND project_id=?",
            (body.name.strip()[:40], (body.appearance or "").strip()[:1000],
             (body.ref_image_url or "").strip(), int(cid), int(pid)),
        )
        await db.commit()
    return {"ok": True}


@router.delete("/projects/{pid}/characters/{cid}", summary="删角色卡")
async def delete_character(pid: int, cid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM comic_characters WHERE id=? AND project_id=?",
            (int(cid), int(pid)),
        )
        await db.commit()
    return {"ok": True}


# ── AI 拆分镜 ────────────────────────────────────────────────────────────

_STORYBOARD_SYSTEM = (
    "你是漫画分镜师。根据给定的故事梗概和角色，把它拆成一组连续的漫画分镜（panel）。"
    "每个 panel 包含：场景/构图、人物动作、对白（如有）。语言精炼，画面感强。"
    "严格只输出 JSON（不要任何代码块标记，不要解释），格式："
    '{"panels":[{"seq":1,"script_text":"…","char_names":["角色A"]}, …]}。'
    "char_names 只能用给定的角色名（没有角色时给空数组）。panel 数量按用户指定的目标值合理控制。"
)


class StoryboardIn(BaseModel):
    n_panels: int = 8       # 期望格子数（4-20）
    replace: bool = True    # True = 清掉现有 panels 重拆


@router.post("/projects/{pid}/storyboard", summary="AI 拆分镜（扣 comic_story 点）")
async def make_storyboard(pid: int, body: StoryboardIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    p = await _project_or_404(pid, uid)
    syn = (p.get("synopsis") or "").strip()
    if not syn:
        raise HTTPException(400, "请先定稿故事梗概再拆分镜")
    n = max(4, min(int(body.n_panels or 8), 20))
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT name, appearance FROM comic_characters WHERE project_id=? ORDER BY id",
            (int(pid),),
        ) as cur:
            chars = [dict(r) for r in await cur.fetchall()]
        async with db.execute(
            "SELECT COUNT(*) AS c FROM comic_panels WHERE project_id=?", (int(pid),),
        ) as cur:
            existing = (await cur.fetchone())["c"]
    if existing and not body.replace:
        raise HTTPException(400, "已有分镜，传 replace=true 才会重拆")
    chars_txt = "；".join(
        f"{c['name']}（{c['appearance'] or '无外貌描述'}）" for c in chars
    ) or "（未定义角色，由你按梗概设定即可）"
    prompt = (
        f"故事梗概：\n{syn}\n\n角色：{chars_txt}\n\n"
        f"目标分镜数：约 {n} 格。只输出 JSON。"
    )
    raw = await ai_client.call_text(
        prompt, model_id=p.get("text_model_id"), user_id=uid,
        feature="comic_story", system_prompt=_STORYBOARD_SYSTEM,
        temperature=0.7, max_tokens=2500,
    )
    # 解析 JSON（容错：模型可能裹 ```json ）
    txt = raw.strip()
    if txt.startswith("```"):
        # 去掉首尾代码块
        txt = txt.strip("`")
        if txt.lower().startswith("json"):
            txt = txt[4:].strip()
    try:
        data = json.loads(txt)
        panels = data.get("panels") if isinstance(data, dict) else data
        if not isinstance(panels, list) or not panels:
            raise ValueError("空 panels")
    except Exception as e:
        raise HTTPException(
            502,
            f"AI 返回的分镜不是合法 JSON：{str(e)[:100]}；原始（前 200 字符）：{raw[:200]}",
        )
    async with _db.connect(DB_PATH) as db:
        if existing:
            await db.execute("DELETE FROM comic_panels WHERE project_id=?", (int(pid),))
        for i, pn in enumerate(panels[:20], start=1):
            seq = int(pn.get("seq") or i)
            st = (pn.get("script_text") or "").strip()[:2000]
            cn = pn.get("char_names") or []
            if not isinstance(cn, list):
                cn = []
            await db.execute(
                "INSERT INTO comic_panels(project_id, seq, script_text, char_names, gen_status) "
                "VALUES (?,?,?,?, 'pending')",
                (int(pid), seq, st, json.dumps(cn, ensure_ascii=False)),
            )
        await db.commit()
    await _touch_project(pid, status="drawing")
    return {"ok": True, "n_panels": min(len(panels), 20)}


# ── panel 编辑 + 生图 ────────────────────────────────────────────────────

class PanelUpdateIn(BaseModel):
    script_text: Optional[str] = None
    char_names: Optional[List[str]] = None


@router.put("/panels/{panel_id}", summary="编辑某格分镜脚本")
async def update_panel(panel_id: int, body: PanelUpdateIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT pn.id FROM comic_panels pn "
            "JOIN comic_projects p ON pn.project_id=p.id "
            "WHERE pn.id=? AND p.user_id=?",
            (int(panel_id), uid),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "分镜格不存在或无权访问")
        sets, vals = [], []
        if body.script_text is not None:
            sets.append("script_text=?")
            vals.append(body.script_text.strip()[:2000])
        if body.char_names is not None:
            sets.append("char_names=?")
            vals.append(json.dumps(body.char_names, ensure_ascii=False))
        if sets:
            vals.append(int(panel_id))
            await db.execute(
                f"UPDATE comic_panels SET {', '.join(sets)} WHERE id=?", vals,
            )
            await db.commit()
    return {"ok": True}


async def _load_panel_ctx(panel_id: int, user_id: int):
    """拿 panel + 所属 project + 项目内角色 map（{name: appearance}）。"""
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT pn.*, p.user_id AS owner FROM comic_panels pn "
            "JOIN comic_projects p ON pn.project_id=p.id WHERE pn.id=?",
            (int(panel_id),),
        ) as cur:
            pn = await cur.fetchone()
        if not pn or int(pn["owner"]) != int(user_id):
            return None, None, None
        proj = await _get_project(int(pn["project_id"]), user_id)
        async with db.execute(
            "SELECT name, appearance FROM comic_characters WHERE project_id=?",
            (int(pn["project_id"]),),
        ) as cur:
            chars = {r["name"]: r["appearance"] for r in await cur.fetchall()}
    return dict(pn), proj, chars


async def _gen_one_panel(panel: Dict[str, Any], project: Dict[str, Any],
                         chars_map: Dict[str, str], user_id: int) -> Dict[str, Any]:
    """生一格图：拼 prompt → call_image → 上传存储 → 写 image_url。

    余额不足（InsufficientCredits）会向上抛，让全局 handler 返 402。
    其它失败标 gen_status='error'，返回 {ok: False, error}。
    """
    pid = panel["id"]
    try:
        cn = json.loads(panel.get("char_names") or "[]")
    except Exception:
        cn = []
    char_desc = "；".join(f"{n}: {chars_map.get(n, '')}" for n in cn if chars_map.get(n))
    style = (project.get("style_hint") or "").strip()
    prompt = " ".join(filter(None, [
        f"漫画风格：{style}。" if style else "漫画风格。",
        f"画面：{panel.get('script_text') or ''}",
        f"角色外貌参考——{char_desc}。" if char_desc else "",
        "高质量、清晰、构图完整。",
    ]))
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE comic_panels SET gen_status='generating', gen_error='', image_prompt=? WHERE id=?",
            (prompt[:2000], int(pid)),
        )
        await db.commit()
    try:
        b64s = await ai_client.call_image(
            prompt, model_id=project.get("image_model_id"), user_id=user_id,
            feature="comic_panel", n=1,
        )
        if not b64s:
            raise RuntimeError("图像模型未返回图片")
        url, _err = await storage.upload_b64(b64s[0], user_id=user_id)
        if not url:
            # 没配存储 → 退而求其次存 data URI（小漫画格子可接受，但前端流量大）
            url = f"data:image/png;base64,{b64s[0]}"
        async with _db.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE comic_panels SET gen_status='done', image_url=?, gen_error='' WHERE id=?",
                (url, int(pid)),
            )
            await db.commit()
        return {"ok": True, "panel_id": pid, "image_url": url}
    except InsufficientCredits:
        # 余额不足：标 pending（未消耗，重试可继续），把 generating 状态回退
        async with _db.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE comic_panels SET gen_status='pending', gen_error='余额不足' WHERE id=?",
                (int(pid),),
            )
            await db.commit()
        raise
    except Exception as e:
        emsg = str(e)[:300]
        async with _db.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE comic_panels SET gen_status='error', gen_error=? WHERE id=?",
                (emsg, int(pid)),
            )
            await db.commit()
        return {"ok": False, "panel_id": pid, "error": emsg}


@router.post("/panels/{panel_id}/generate", summary="生这一格图（扣 comic_panel 点）")
async def generate_panel(panel_id: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    pn, proj, chars = await _load_panel_ctx(panel_id, uid)
    if not pn:
        raise HTTPException(404, "分镜格不存在或无权访问")
    return await _gen_one_panel(pn, proj, chars, uid)


@router.post("/projects/{pid}/generate-all", summary="批量生所有 pending/error 格子")
async def generate_all(pid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    proj = await _project_or_404(pid, uid)
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT name, appearance FROM comic_characters WHERE project_id=?",
            (int(pid),),
        ) as cur:
            chars = {r["name"]: r["appearance"] for r in await cur.fetchall()}
        async with db.execute(
            "SELECT * FROM comic_panels WHERE project_id=? "
            "AND gen_status IN ('pending','error') ORDER BY seq, id",
            (int(pid),),
        ) as cur:
            todo = [dict(r) for r in await cur.fetchall()]
    if not todo:
        return {"ok": True, "generated": 0, "msg": "没有待生成的格子"}
    results = []
    # 串行生成（图像 API 慢，且控制扣点节奏便于失败时止损）
    for pn in todo:
        try:
            r = await _gen_one_panel(pn, proj, chars, uid)
            results.append(r)
        except InsufficientCredits as e:
            # 批量过程中余额用完：返回已生成的 + 提示
            return {
                "ok": False, "stopped": "insufficient_credits",
                "generated": sum(1 for x in results if x.get("ok")),
                "total": len(todo),
                "detail": str(e),
            }
    ok_n = sum(1 for x in results if x.get("ok"))
    if ok_n == len(todo):
        await _touch_project(pid, status="done")
    return {"ok": True, "generated": ok_n, "total": len(todo), "results": results}
