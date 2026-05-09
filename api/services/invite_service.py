"""邀请码：admin 生成，用户注册时消费。

设计要点：
- code 用 12 位 base32（去歧义字符），通俗读得出来
- 失效 = 过期 / used_count >= max_uses，不删除（保留审计痕迹）
"""
from __future__ import annotations

import secrets
import string
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import aiosqlite

from . import monitor_db


_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"  # 去 0/O/1/I 歧义


def _gen_code(length: int = 12) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


async def create(
    *, created_by: Optional[int],
    plan: str = "trial", max_uses: int = 1,
    expires_in_days: Optional[int] = None,
    note: str = "",
) -> Dict[str, Any]:
    """生成一条邀请码。冲突自动重试 5 次。"""
    expires_at = ""
    if expires_in_days and expires_in_days > 0:
        expires_at = (datetime.utcnow() + timedelta(days=int(expires_in_days))).isoformat()

    for _ in range(5):
        code = _gen_code()
        try:
            async with aiosqlite.connect(monitor_db.DB_PATH) as db:
                await db.execute(
                    "INSERT INTO invite_codes (code, created_by, plan, max_uses, "
                    "expires_at, note) VALUES (?, ?, ?, ?, ?, ?)",
                    (code, created_by, plan, max_uses,
                     expires_at or None, note or ""),
                )
                await db.commit()
            return {
                "code": code, "plan": plan, "max_uses": max_uses,
                "expires_at": expires_at or None, "note": note,
            }
        except aiosqlite.IntegrityError:
            continue
    raise RuntimeError("生成邀请码 5 次冲突，请重试")


async def get(code: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM invite_codes WHERE code=?", (code,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def consume(code: str) -> Optional[Dict[str, Any]]:
    """注册成功时调：原子 +1 used_count。返回邀请码记录，失效返 None。"""
    code = (code or "").strip().upper()
    if not code:
        return None
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("BEGIN IMMEDIATE")
        async with db.execute(
            "SELECT * FROM invite_codes WHERE code=?", (code,),
        ) as cur:
            row = await cur.fetchone()
        if not row:
            await db.commit()
            return None
        rec = dict(row)
        # 过期检查
        if rec.get("expires_at"):
            try:
                exp = datetime.fromisoformat(rec["expires_at"])
                if datetime.utcnow() > exp:
                    await db.commit()
                    return None
            except Exception:
                pass
        if int(rec.get("used_count") or 0) >= int(rec.get("max_uses") or 1):
            await db.commit()
            return None
        await db.execute(
            "UPDATE invite_codes SET used_count = used_count + 1 WHERE code=?",
            (code,),
        )
        await db.commit()
        return rec


async def list_all(limit: int = 100) -> List[Dict[str, Any]]:
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete(code: str) -> bool:
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        cur = await db.execute("DELETE FROM invite_codes WHERE code=?", (code,))
        await db.commit()
        return (cur.rowcount or 0) > 0
