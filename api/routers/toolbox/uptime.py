# -*- coding: utf-8 -*-
"""服务监控（uptime-kuma 思路简化版）：用户登记 URL → 立即测 / 定期测 →
失败时推飞书群（复用 bitable 通知群，沿用 v1 已有的 ensure_feature_chat）。

不耗 AI，不接计费。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import get_current_user
from ...services import monitor_db
from ...services import db as _db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/toolbox/uptime", tags=["Toolbox-Uptime"])
DB_PATH = monitor_db.DB_PATH


# ── DB helpers ───────────────────────────────────────────────────────────

async def _get_monitor(mid: int, user_id: int):
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM service_monitors WHERE id=? AND user_id=?",
            (int(mid), int(user_id)),
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


# ── 探活实现 ─────────────────────────────────────────────────────────────

def _parse_host_port(url: str) -> tuple[str, int]:
    """从 tcp 监控的 url 取 (host, port)。容忍 tcp:// 前缀 / host:port / 纯 host(默认 80)。"""
    s = (url or "").strip()
    if "://" in s:
        s = s.split("://", 1)[1]
    s = s.split("/", 1)[0].strip()
    if ":" in s:
        host, _, p = s.rpartition(":")
        try:
            return host, int(p)
        except ValueError:
            return s, 80
    return s, 80


async def _probe(url: str, method: str, expected_status: int, timeout: float,
                 monitor_type: str = "http") -> dict:
    """返回 {status, http_status, latency_ms, error}。status ∈ ok/down/error。
    monitor_type=tcp 时只测端口能否在 timeout 内建立 TCP 连接（url=host:port）。"""
    t0 = time.perf_counter()
    if (monitor_type or "http").lower() == "tcp":
        host, port = _parse_host_port(url)
        try:
            fut = asyncio.open_connection(host, port)
            reader, writer = await asyncio.wait_for(fut, timeout=timeout)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"status": "ok", "http_status": 0,
                    "latency_ms": int((time.perf_counter() - t0) * 1000), "error": ""}
        except Exception as e:
            return {"status": "error", "http_status": 0,
                    "latency_ms": int((time.perf_counter() - t0) * 1000),
                    "error": f"TCP {host}:{port} 不可连 — {type(e).__name__}: {str(e)[:160]}"}
    method = (method or "GET").upper()
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as cli:
            if method == "HEAD":
                r = await cli.head(url)
            elif method == "POST":
                r = await cli.post(url)
            else:
                r = await cli.get(url)
        latency = int((time.perf_counter() - t0) * 1000)
        if r.status_code == int(expected_status):
            return {"status": "ok", "http_status": r.status_code, "latency_ms": latency, "error": ""}
        return {"status": "down", "http_status": r.status_code, "latency_ms": latency,
                "error": f"HTTP {r.status_code}（预期 {expected_status}）"}
    except Exception as e:
        return {"status": "error", "http_status": 0,
                "latency_ms": int((time.perf_counter() - t0) * 1000),
                "error": f"{type(e).__name__}: {str(e)[:200]}"}


async def _record_check(monitor_id: int, result: dict, monitor: dict) -> dict:
    """记一笔 check + 更新 monitor 状态 + 触发告警（如需）。返回 result 原样。"""
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO service_monitor_checks(monitor_id, status, http_status, latency_ms, error) "
            "VALUES (?,?,?,?,?)",
            (int(monitor_id), result["status"], int(result.get("http_status", 0)),
             int(result.get("latency_ms", 0)), result.get("error", "")),
        )
        # 更新 monitor 主表
        prev_status = monitor.get("last_status") or "unknown"
        prev_fail = int(monitor.get("consecutive_fail") or 0)
        new_fail = 0 if result["status"] == "ok" else (prev_fail + 1)
        await db.execute(
            "UPDATE service_monitors SET last_check_at=datetime('now','localtime'), "
            "last_status=?, last_latency_ms=?, last_error=?, consecutive_fail=? WHERE id=?",
            (result["status"], int(result.get("latency_ms", 0)),
             result.get("error", ""), new_fail, int(monitor_id)),
        )
        await db.commit()

    # 告警：连续失败达阈值时推飞书（首次达到阈值 / 状态从 ok 变 down）
    threshold = int(monitor.get("notify_after_fails") or 1)
    just_crossed_threshold = (new_fail == threshold)
    recovered = (prev_fail >= threshold and result["status"] == "ok")
    if just_crossed_threshold or recovered:
        try:
            from ...services import auth_service
            user = auth_service.get_user_by_id(int(monitor["user_id"]))
            if user and (user.get("feishu_open_id") or "").strip():
                from ...services.feishu import provisioning as _prov, chat as _chat
                chat_id = await _prov.ensure_feature_chat(user, "bitable") or ""
                if chat_id:
                    if just_crossed_threshold:
                        card = _chat.build_alert_card(
                            f"🚨 服务异常：{monitor['name']}",
                            f"URL: {monitor['url']}\n"
                            f"状态：{result['status']}\n"
                            f"错误：{result.get('error', '')}\n"
                            f"连续失败 {new_fail} 次（阈值 {threshold}）",
                            template="red",
                        )
                    else:
                        card = _chat.build_alert_card(
                            f"✅ 服务恢复：{monitor['name']}",
                            f"URL: {monitor['url']}\n"
                            f"延时：{result['latency_ms']} ms\n"
                            f"上次失败连续 {prev_fail} 次",
                            template="green",
                        )
                    await _chat.send_card(chat_id, card)
        except Exception as e:
            logger.warning(f"[uptime] notify failed monitor={monitor_id}: {e}")
    return result


# ── CRUD ─────────────────────────────────────────────────────────────────

class MonitorIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    url: str = Field(..., min_length=1)
    method: str = "GET"
    expected_status: int = 200
    timeout_seconds: int = 15
    interval_seconds: int = 300
    notify_after_fails: int = 1
    enabled: bool = True
    monitor_type: str = "http"   # http=按状态码 | tcp=按端口可连（url 填 host:port）


@router.post("/monitors", summary="登记一个监控目标")
async def create_monitor(body: MonitorIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    mtype = (body.monitor_type or "http").lower()
    if mtype not in ("http", "tcp"):
        raise HTTPException(400, "monitor_type 只能是 http / tcp")
    if mtype == "http":
        if body.method.upper() not in ("GET", "HEAD", "POST"):
            raise HTTPException(400, "method 只能是 GET / HEAD / POST")
        if not (body.url.startswith("http://") or body.url.startswith("https://")):
            raise HTTPException(400, "http 监控的 url 必须以 http:// 或 https:// 开头")
    else:  # tcp
        _h, _p = _parse_host_port(body.url)
        if not _h or not (0 < _p < 65536):
            raise HTTPException(400, "tcp 监控的 url 应为 host:port（如 db.example.com:5432）")
    async with _db.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO service_monitors(user_id, name, url, method, expected_status, "
            "timeout_seconds, interval_seconds, notify_after_fails, enabled, monitor_type) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (uid, body.name.strip()[:80], body.url.strip()[:500],
             body.method.upper(), int(body.expected_status),
             max(3, min(int(body.timeout_seconds), 120)),
             max(60, min(int(body.interval_seconds), 86400)),
             max(1, min(int(body.notify_after_fails), 10)),
             1 if body.enabled else 0, mtype),
        )
        await db.commit()
        return {"ok": True, "id": cur.lastrowid}


@router.get("/monitors", summary="我的监控列表")
async def list_monitors(current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM service_monitors WHERE user_id=? ORDER BY id DESC", (uid,),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"monitors": rows}


@router.put("/monitors/{mid}", summary="改监控配置")
async def update_monitor(mid: int, body: MonitorIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    m = await _get_monitor(mid, uid)
    if not m:
        raise HTTPException(404, "监控不存在或无权访问")
    async with _db.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE service_monitors SET name=?, url=?, method=?, expected_status=?, "
            "timeout_seconds=?, interval_seconds=?, notify_after_fails=?, enabled=?, "
            "monitor_type=? WHERE id=?",
            (body.name.strip()[:80], body.url.strip()[:500], body.method.upper(),
             int(body.expected_status),
             max(3, min(int(body.timeout_seconds), 120)),
             max(60, min(int(body.interval_seconds), 86400)),
             max(1, min(int(body.notify_after_fails), 10)),
             1 if body.enabled else 0,
             (body.monitor_type or "http").lower() if (body.monitor_type or "http").lower() in ("http", "tcp") else "http",
             int(mid)),
        )
        await db.commit()
    return {"ok": True}


@router.delete("/monitors/{mid}", summary="删除监控")
async def delete_monitor(mid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    m = await _get_monitor(mid, uid)
    if not m:
        raise HTTPException(404, "监控不存在或无权访问")
    async with _db.connect(DB_PATH) as db:
        await db.execute("DELETE FROM service_monitor_checks WHERE monitor_id=?", (int(mid),))
        await db.execute("DELETE FROM service_monitors WHERE id=?", (int(mid),))
        await db.commit()
    return {"ok": True}


@router.post("/monitors/{mid}/check-now", summary="立即探活一次")
async def check_now(mid: int, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    m = await _get_monitor(mid, uid)
    if not m:
        raise HTTPException(404, "监控不存在或无权访问")
    result = await _probe(
        m["url"], m["method"], int(m["expected_status"]),
        float(m["timeout_seconds"]),
        monitor_type=(m.get("monitor_type") or "http"),
    )
    await _record_check(int(mid), result, m)
    return {"ok": True, **result}


@router.get("/monitors/{mid}/checks", summary="某监控的历史探活记录")
async def list_checks(
    mid: int, limit: int = 100,
    current_user: dict = Depends(get_current_user),
):
    uid = int(current_user["id"])
    m = await _get_monitor(mid, uid)
    if not m:
        raise HTTPException(404, "监控不存在或无权访问")
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT id, status, http_status, latency_ms, error, checked_at "
            "FROM service_monitor_checks WHERE monitor_id=? "
            "ORDER BY id DESC LIMIT ?",
            (int(mid), int(min(limit, 1000))),
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    return {"checks": rows, "monitor": m}


# ── 定时任务入口（供 worker 调）─────────────────────────────────────────────

async def run_all_due_checks() -> dict:
    """worker cron 调：扫所有 enabled + 到时间的 monitor，串行探活。
    判定"到时间"：last_check_at + interval_seconds <= now。
    """
    from datetime import datetime, timedelta
    now = datetime.now()
    async with _db.connect(DB_PATH) as db:
        db.row_factory = _db.Row
        async with db.execute(
            "SELECT * FROM service_monitors WHERE enabled=1",
        ) as cur:
            all_monitors = [dict(r) for r in await cur.fetchall()]
    due = []
    for m in all_monitors:
        try:
            last_at = m.get("last_check_at") or ""
            if not last_at:
                due.append(m); continue
            last_dt = datetime.fromisoformat(last_at.replace(" ", "T"))
            if (now - last_dt) >= timedelta(seconds=int(m.get("interval_seconds") or 300)):
                due.append(m)
        except Exception:
            due.append(m)
    for m in due:
        try:
            r = await _probe(m["url"], m["method"], int(m["expected_status"]), float(m["timeout_seconds"]),
                             monitor_type=(m.get("monitor_type") or "http"))
            await _record_check(int(m["id"]), r, m)
        except Exception as e:
            logger.warning(f"[uptime.run_all_due_checks] monitor={m['id']} 异常: {e}")
    return {"scanned": len(all_monitors), "checked": len(due)}
