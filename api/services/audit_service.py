"""操作审计日志：登录 / 注册 / admin 操作 / 配额超限。

不抛异常 —— 审计失败不影响业务路径。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

import aiosqlite

from . import monitor_db

logger = logging.getLogger(__name__)


async def log(
    *,
    actor: Optional[Dict[str, Any]] = None,
    actor_id: Optional[int] = None,
    actor_username: str = "",
    action: str,
    target_type: str = "",
    target_id: Any = "",
    metadata: Optional[Dict[str, Any]] = None,
    ip: str = "",
    user_agent: str = "",
) -> None:
    """写一条审计。actor 优先，没有就用 actor_id/username 单独传。"""
    try:
        if actor:
            actor_id = actor.get("id")
            actor_username = actor.get("username") or ""

        meta = ""
        if metadata is not None:
            try:
                meta = json.dumps(metadata, ensure_ascii=False, default=str)[:2000]
            except Exception:
                meta = str(metadata)[:2000]

        async with aiosqlite.connect(monitor_db.DB_PATH) as db:
            await db.execute(
                "INSERT INTO audit_logs (actor_id, actor_username, action, target_type, "
                "target_id, metadata, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    actor_id, actor_username or "",
                    action, target_type or "", str(target_id or ""),
                    meta, ip or "", (user_agent or "")[:300],
                ),
            )
            await db.commit()
    except Exception as e:
        logger.warning(f"[audit] write failed: {e}")


async def list_logs(
    *,
    actor_id: Optional[int] = None,
    action: Optional[str] = None,
    target_type: Optional[str] = None,
    since: Optional[str] = None,
    limit: int = 100, offset: int = 0,
) -> list:
    where, args = [], []
    if actor_id is not None:
        where.append("actor_id=?"); args.append(actor_id)
    if action:
        where.append("action LIKE ?"); args.append(f"{action}%")
    if target_type:
        where.append("target_type=?"); args.append(target_type)
    if since:
        where.append("created_at >= ?"); args.append(since)
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""

    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT * FROM audit_logs {where_clause} "
            f"ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def count_logs(
    *,
    actor_id: Optional[int] = None,
    action: Optional[str] = None,
    target_type: Optional[str] = None,
    since: Optional[str] = None,
) -> int:
    where, args = [], []
    if actor_id is not None:
        where.append("actor_id=?"); args.append(actor_id)
    if action:
        where.append("action LIKE ?"); args.append(f"{action}%")
    if target_type:
        where.append("target_type=?"); args.append(target_type)
    if since:
        where.append("created_at >= ?"); args.append(since)
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""

    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        async with db.execute(
            f"SELECT COUNT(*) FROM audit_logs {where_clause}", tuple(args),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0
