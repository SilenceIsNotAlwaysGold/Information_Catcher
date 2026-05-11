"""Admin AI 模型配置 CRUD + 用户可见模型列表 + 用户偏好持久化。

路由前缀:
  /admin/ai/providers   — admin: 渠道增删改查
  /admin/ai/models      — admin: 模型增删改查 + 上下架 + 设为默认
  /admin/ai/usage       — admin: 使用记录聚合
  /ai/models            — user:  查询当前 usage_type 下可用模型（仅 published）
  /ai/preferences       — user:  设置自己的偏好模型
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..services import monitor_db, ai_client, auth_service
from .auth import get_current_user

router = APIRouter(tags=["AI"])


def _require_admin(user: dict):
    if (user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")


# ──────────────────────────────────────────────────────────────
# Provider CRUD
# ──────────────────────────────────────────────────────────────


class ProviderIn(BaseModel):
    name: str = Field(..., min_length=1)
    base_url: str = Field(..., min_length=1)
    api_key: str = Field(..., min_length=1)
    enabled: bool = True
    sort_order: int = 0
    note: str = ""


class ProviderUpdate(BaseModel):
    name: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None     # 不传 → 不改（保留原 key，前端编辑表单不需要回填）
    enabled: Optional[bool] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None


def _mask_key(k: str) -> str:
    if not k:
        return ""
    k = str(k)
    if len(k) <= 8:
        return "•" * len(k)
    return k[:4] + "•" * (len(k) - 8) + k[-4:]


@router.get("/admin/ai/providers", summary="渠道列表")
async def list_providers(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM ai_providers ORDER BY sort_order, id"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    # 不返回明文 key，给前端展示 masked 版本
    for r in rows:
        r["api_key_masked"] = _mask_key(r.get("api_key") or "")
        r.pop("api_key", None)
    return {"providers": rows}


@router.post("/admin/ai/providers", summary="新增渠道")
async def create_provider(body: ProviderIn, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO ai_providers (name, base_url, api_key, enabled, sort_order, note) "
            "VALUES (?,?,?,?,?,?)",
            (body.name, body.base_url, body.api_key,
             1 if body.enabled else 0, int(body.sort_order or 0), body.note or ""),
        )
        await db.commit()
        return {"ok": True, "id": cur.lastrowid}


@router.put("/admin/ai/providers/{pid}", summary="编辑渠道")
async def update_provider(
    pid: int, body: ProviderUpdate, current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    fields, values = [], []
    if body.name is not None: fields.append("name=?"); values.append(body.name)
    if body.base_url is not None: fields.append("base_url=?"); values.append(body.base_url)
    if body.api_key is not None and body.api_key.strip():
        fields.append("api_key=?"); values.append(body.api_key)
    if body.enabled is not None: fields.append("enabled=?"); values.append(1 if body.enabled else 0)
    if body.sort_order is not None: fields.append("sort_order=?"); values.append(int(body.sort_order))
    if body.note is not None: fields.append("note=?"); values.append(body.note)
    if not fields:
        return {"ok": True, "changed": 0}
    values.append(pid)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        await db.execute(f"UPDATE ai_providers SET {', '.join(fields)} WHERE id=?", values)
        await db.commit()
    return {"ok": True}


@router.delete("/admin/ai/providers/{pid}", summary="删除渠道（同时级联删除其下模型）")
async def delete_provider(pid: int, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        # ON DELETE CASCADE 在创建表时已声明，但 SQLite 默认不强制外键，手动开
        await db.execute("PRAGMA foreign_keys = ON")
        # 显式删除 models 更可靠
        await db.execute("DELETE FROM ai_models WHERE provider_id=?", (pid,))
        await db.execute("DELETE FROM ai_providers WHERE id=?", (pid,))
        await db.commit()
    return {"ok": True}


# ──────────────────────────────────────────────────────────────
# Model CRUD
# ──────────────────────────────────────────────────────────────


class ModelIn(BaseModel):
    # pydantic v2 默认把 model_ 前缀视为保留前缀 → 关掉
    model_config = {"protected_namespaces": ()}

    provider_id: int
    model_id: str = Field(..., min_length=1)
    display_name: str = Field(..., min_length=1)
    usage_type: str = Field("text", pattern="^(text|image)$")
    published: bool = False
    is_default: bool = False
    extra_config: Dict[str, Any] = Field(default_factory=dict)
    sort_order: int = 0
    note: str = ""
    max_concurrent: int = 0   # P15.8: 0 = 不限


class ModelUpdate(BaseModel):
    model_config = {"protected_namespaces": ()}

    provider_id: Optional[int] = None
    model_id: Optional[str] = None
    display_name: Optional[str] = None
    usage_type: Optional[str] = Field(None, pattern="^(text|image)$")
    published: Optional[bool] = None
    is_default: Optional[bool] = None
    extra_config: Optional[Dict[str, Any]] = None
    sort_order: Optional[int] = None
    note: Optional[str] = None
    max_concurrent: Optional[int] = None


@router.get("/admin/ai/models", summary="模型列表（按 usage_type 可选过滤）")
async def list_models(
    usage_type: Optional[str] = Query(None, pattern="^(text|image)$"),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    sql = (
        "SELECT m.*, p.name AS provider_name, p.enabled AS provider_enabled "
        "FROM ai_models m JOIN ai_providers p ON m.provider_id=p.id"
    )
    params: List = []
    if usage_type:
        sql += " WHERE m.usage_type=?"
        params.append(usage_type)
    sql += " ORDER BY m.usage_type, m.sort_order, m.id"
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"models": rows}


async def _enforce_single_default(db, model_id: int, usage_type: str):
    """is_default=1 时把同 usage_type 其他模型的 is_default 清零。"""
    await db.execute(
        "UPDATE ai_models SET is_default=0 WHERE usage_type=? AND id<>?",
        (usage_type, model_id),
    )


@router.post("/admin/ai/models", summary="新增模型")
async def create_model(body: ModelIn, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        # provider 存在校验
        async with db.execute(
            "SELECT id FROM ai_providers WHERE id=?", (body.provider_id,),
        ) as c:
            if not await c.fetchone():
                raise HTTPException(status_code=400, detail="provider_id 不存在")
        cur = await db.execute(
            "INSERT INTO ai_models "
            "(provider_id, model_id, display_name, usage_type, published, is_default, "
            " extra_config, sort_order, note, max_concurrent) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                body.provider_id, body.model_id, body.display_name, body.usage_type,
                1 if body.published else 0, 1 if body.is_default else 0,
                json.dumps(body.extra_config or {}, ensure_ascii=False),
                int(body.sort_order or 0), body.note or "",
                max(0, int(body.max_concurrent or 0)),
            ),
        )
        new_id = cur.lastrowid
        if body.is_default:
            await _enforce_single_default(db, new_id, body.usage_type)
        await db.commit()
    return {"ok": True, "id": new_id}


@router.put("/admin/ai/models/{mid}", summary="编辑模型（也用于上下架 / 设为默认）")
async def update_model(
    mid: int, body: ModelUpdate, current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    fields, values = [], []
    if body.provider_id is not None: fields.append("provider_id=?"); values.append(body.provider_id)
    if body.model_id is not None: fields.append("model_id=?"); values.append(body.model_id)
    if body.display_name is not None: fields.append("display_name=?"); values.append(body.display_name)
    if body.usage_type is not None: fields.append("usage_type=?"); values.append(body.usage_type)
    if body.published is not None: fields.append("published=?"); values.append(1 if body.published else 0)
    if body.is_default is not None: fields.append("is_default=?"); values.append(1 if body.is_default else 0)
    if body.extra_config is not None:
        fields.append("extra_config=?"); values.append(json.dumps(body.extra_config, ensure_ascii=False))
    if body.sort_order is not None: fields.append("sort_order=?"); values.append(int(body.sort_order))
    if body.note is not None: fields.append("note=?"); values.append(body.note)
    if body.max_concurrent is not None:
        fields.append("max_concurrent=?"); values.append(max(0, int(body.max_concurrent)))
    if not fields:
        return {"ok": True, "changed": 0}
    values.append(mid)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        await db.execute(f"UPDATE ai_models SET {', '.join(fields)} WHERE id=?", values)
        if body.is_default:
            # 解析 usage_type：要么用 body 传的，要么读已有
            ut = body.usage_type
            if ut is None:
                async with db.execute(
                    "SELECT usage_type FROM ai_models WHERE id=?", (mid,),
                ) as c:
                    r = await c.fetchone()
                    ut = r[0] if r else "text"
            await _enforce_single_default(db, mid, ut)
        await db.commit()
    return {"ok": True}


@router.delete("/admin/ai/models/{mid}", summary="删除模型")
async def delete_model(mid: int, current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        await db.execute("DELETE FROM ai_models WHERE id=?", (mid,))
        # 清掉所有用户偏好里指向这个模型的引用（fallback 到默认）
        await db.commit()
    # users 表是另一个 DB，单独清
    try:
        with auth_service._get_db_connection() as conn:
            conn.execute(
                "UPDATE users SET preferred_text_model_id=NULL WHERE preferred_text_model_id=?",
                (mid,),
            )
            conn.execute(
                "UPDATE users SET preferred_image_model_id=NULL WHERE preferred_image_model_id=?",
                (mid,),
            )
            conn.commit()
    except Exception:
        pass
    return {"ok": True}


# ──────────────────────────────────────────────────────────────
# Usage logs
# ──────────────────────────────────────────────────────────────


@router.get("/admin/ai/usage", summary="使用记录（按日 × 用户 × 模型聚合）")
async def usage_summary(
    days: int = Query(7, ge=1, le=90),
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # 总览
        async with db.execute(
            "SELECT "
            "  COUNT(*) AS total_calls, "
            "  SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_calls, "
            "  SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error_calls, "
            "  SUM(input_tokens) AS total_in, "
            "  SUM(output_tokens) AS total_out, "
            "  SUM(image_count) AS total_images "
            "FROM ai_usage_logs "
            "WHERE created_at >= datetime('now', ?, 'localtime')",
            (f"-{days} days",),
        ) as c:
            summary = dict(await c.fetchone() or {})

        # 按日
        async with db.execute(
            "SELECT date(created_at) AS day, usage_type, "
            "       COUNT(*) AS calls, SUM(input_tokens) AS tokens_in, "
            "       SUM(output_tokens) AS tokens_out, SUM(image_count) AS images "
            "FROM ai_usage_logs "
            "WHERE created_at >= datetime('now', ?, 'localtime') "
            "GROUP BY day, usage_type ORDER BY day DESC, usage_type",
            (f"-{days} days",),
        ) as c:
            by_day = [dict(r) for r in await c.fetchall()]

        # 按用户 × 模型
        async with db.execute(
            "SELECT user_id, model_id_str, usage_type, "
            "       COUNT(*) AS calls, SUM(input_tokens) AS tokens_in, "
            "       SUM(output_tokens) AS tokens_out, SUM(image_count) AS images "
            "FROM ai_usage_logs "
            "WHERE created_at >= datetime('now', ?, 'localtime') "
            "GROUP BY user_id, model_id_str, usage_type "
            "ORDER BY calls DESC LIMIT 100",
            (f"-{days} days",),
        ) as c:
            by_user_model = [dict(r) for r in await c.fetchall()]

    # 把 user_id → username 映射一把
    user_map = {}
    try:
        with auth_service._get_db_connection() as conn:
            for r in conn.execute("SELECT id, username FROM users"):
                user_map[r["id"]] = r["username"]
    except Exception:
        pass
    for r in by_user_model:
        r["username"] = user_map.get(r.get("user_id"), "—") if r.get("user_id") else "—"

    return {
        "summary": summary,
        "by_day": by_day,
        "by_user_model": by_user_model,
    }


# ──────────────────────────────────────────────────────────────
# 用户侧：可见模型 + 偏好
# ──────────────────────────────────────────────────────────────


@router.get("/ai/models", summary="用户可用模型列表（仅 published）")
async def user_visible_models(
    usage: str = Query("text", pattern="^(text|image)$"),
    current_user: dict = Depends(get_current_user),
):
    models = await ai_client.list_user_visible_models(usage, user=current_user)
    # 解析 extra_config 给前端使用（图像 model 的 size 等）
    for m in models:
        try:
            m["extra_config"] = json.loads(m.get("extra_config") or "{}")
        except Exception:
            m["extra_config"] = {}
    # 用户当前的偏好（前端 modal 默认选中用）
    pref_text = current_user.get("preferred_text_model_id")
    pref_image = current_user.get("preferred_image_model_id")
    return {
        "models": models,
        "preferred_text_model_id": pref_text,
        "preferred_image_model_id": pref_image,
    }


class PreferenceIn(BaseModel):
    preferred_text_model_id: Optional[int] = None
    preferred_image_model_id: Optional[int] = None


@router.put("/ai/preferences", summary="设置自己的模型偏好（传 null 重置为系统默认）")
async def set_preferences(
    body: PreferenceIn, current_user: dict = Depends(get_current_user),
):
    uid = int(current_user["id"])
    with auth_service._get_db_connection() as conn:
        if "preferred_text_model_id" in body.__fields_set__:
            conn.execute(
                "UPDATE users SET preferred_text_model_id=? WHERE id=?",
                (body.preferred_text_model_id, uid),
            )
        if "preferred_image_model_id" in body.__fields_set__:
            conn.execute(
                "UPDATE users SET preferred_image_model_id=? WHERE id=?",
                (body.preferred_image_model_id, uid),
            )
        conn.commit()
    return {"ok": True}
