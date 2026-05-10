# -*- coding: utf-8 -*-
"""Dashboard 首页运营概览：今日告警 + 最近抓取 + 配额状态。

路由前缀 /monitor/dashboard，挂载在 /api 下，最终路径为 /api/monitor/dashboard/...
保持与现有 monitor 路由同 namespace，前端复用 token 一致。
"""
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends

from ..services import monitor_db as db
from .auth import get_current_user
from .monitor import _scope_uid

router = APIRouter(prefix="/monitor/dashboard", tags=["Dashboard"])


# ── 内部工具 ────────────────────────────────────────────────────────────────

def _classify_alert(alert_type: str) -> str:
    """把 scheduler 写入的 alert_type 折叠成前端三类：surge / comment / trending。

    现有 alert_type 取值（见 services/scheduler.py）：
      - "likes" / "collects"                                 → surge
      - "likes_delta" / "collects_delta"                     → surge
      - "likes_cum_<thr>" / "collects_cum_<thr>"             → surge
      - "likes_pct" / "collects_pct"                         → surge
      - "comment" / "comment_delta" / "comment_*"            → comment
      - 预留 trending* 前缀                                   → trending
    其余落到 surge（默认偏向涨幅类）。
    """
    t = (alert_type or "").lower().strip()
    if t.startswith("trending"):
        return "trending"
    if t.startswith("comment"):
        return "comment"
    return "surge"


async def _today_alerts_summary(scope_uid: Optional[int]) -> Dict[str, Any]:
    """直查 monitor_alerts，按当地今日 0 点过滤；user_id 隔离。"""
    out_total = 0
    out_by_type = {"surge": 0, "comment": 0, "trending": 0}
    out_top: List[Dict[str, Any]] = []
    try:
        async with aiosqlite.connect(db.DB_PATH) as conn:
            conn.row_factory = aiosqlite.Row
            sql = (
                "SELECT id, note_id, title, alert_type, message, created_at "
                "FROM monitor_alerts "
                "WHERE created_at >= date('now','localtime') "
            )
            params: list = []
            if scope_uid is not None:
                sql += "AND user_id = ? "
                params.append(scope_uid)
            sql += "ORDER BY created_at DESC"
            async with conn.execute(sql, params) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
        out_total = len(rows)
        for r in rows:
            cls = _classify_alert(r.get("alert_type") or "")
            out_by_type[cls] = out_by_type.get(cls, 0) + 1
        out_top = rows[:5]
    except Exception:
        # 静默吞，dashboard 永远不应 500
        pass
    return {
        "total": out_total,
        "by_type": out_by_type,
        "top": out_top,
    }


async def _recent_fetches(scope_uid: Optional[int], limit: int = 8) -> List[Dict[str, Any]]:
    """直查 fetch_log。schema 是单行单 fetch（status ok/error/login_required/deleted），
    本接口把它折叠成前端期望的 success/fail + ok_count/fail_count（单行 1/0）。

    fetch_log 没有 user_id 列，按照规约通过 monitor_posts.note_id → user_id 过滤；
    没有 note_id 的（trending/anonymous 抓取）对普通用户隐藏，只在 admin 全量视图里出现。
    """
    out: List[Dict[str, Any]] = []
    try:
        async with aiosqlite.connect(db.DB_PATH) as conn:
            conn.row_factory = aiosqlite.Row
            if scope_uid is None:
                sql = (
                    "SELECT platform, task_type, status, note_id, created_at "
                    "FROM fetch_log "
                    "ORDER BY created_at DESC "
                    "LIMIT ?"
                )
                params: list = [limit]
            else:
                # 通过 monitor_posts 反查 user_id；多个用户可能复用同 note_id
                # （add_post 不去重 user_id），用 EXISTS 子查询足够。
                sql = (
                    "SELECT l.platform, l.task_type, l.status, l.note_id, l.created_at "
                    "FROM fetch_log l "
                    "WHERE l.note_id IS NOT NULL "
                    "  AND EXISTS ("
                    "    SELECT 1 FROM monitor_posts p "
                    "    WHERE p.note_id = l.note_id AND p.user_id = ?"
                    "  ) "
                    "ORDER BY l.created_at DESC "
                    "LIMIT ?"
                )
                params = [scope_uid, limit]
            async with conn.execute(sql, params) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
        for r in rows:
            ok = (r.get("status") == "ok")
            out.append({
                "platform": r.get("platform") or "",
                "fetch_type": r.get("task_type") or "",
                "status": "success" if ok else "fail",
                "ok_count": 1 if ok else 0,
                "fail_count": 0 if ok else 1,
                "started_at": r.get("created_at") or "",
                "note_id": r.get("note_id") or "",
            })
    except Exception:
        pass
    return out


# ── 主接口 ──────────────────────────────────────────────────────────────────

@router.get("/overview", summary="Dashboard 首页运营概览")
async def dashboard_overview(current_user: dict = Depends(get_current_user)):
    """返回今日告警 / 最近抓取 / 配额状态 / 全量指标合计。

    异常路径全部静默吞，返回零值，避免 dashboard 因任一子查询失败 500。
    """
    scope_uid = _scope_uid(current_user)

    # 1. 监控帖子（含最新 snapshot 聚合的 liked/collected/comment）
    posts: List[Dict[str, Any]] = []
    try:
        posts = await db.get_posts(user_id=scope_uid)
    except Exception:
        posts = []

    posts_by_platform = {"xhs": 0, "douyin": 0, "mp": 0}
    likes_sum = 0
    collects_sum = 0
    comments_sum = 0
    for p in posts:
        plat = (p.get("platform") or "xhs").lower()
        if plat in posts_by_platform:
            posts_by_platform[plat] += 1
        else:
            posts_by_platform[plat] = posts_by_platform.get(plat, 0) + 1
        likes_sum += int(p.get("liked_count") or 0)
        collects_sum += int(p.get("collected_count") or 0)
        comments_sum += int(p.get("comment_count") or 0)

    # 2. 账号（按 cookie_status 拆 valid / expired / 其他）
    accounts: List[Dict[str, Any]] = []
    try:
        accounts = await db.get_accounts(user_id=scope_uid)
    except Exception:
        accounts = []
    acc_total = len(accounts)
    acc_valid = sum(1 for a in accounts if (a.get("cookie_status") or "") == "valid")
    acc_expired = sum(1 for a in accounts if (a.get("cookie_status") or "") == "expired")

    # 3. 创作者订阅
    creators: List[Dict[str, Any]] = []
    try:
        creators = await db.list_creators(user_id=scope_uid)
    except Exception:
        creators = []

    # 4. 今日告警 + Top 5
    alerts_summary = await _today_alerts_summary(scope_uid)

    # 5. 最近抓取 Top 8
    recent = await _recent_fetches(scope_uid, limit=8)

    return {
        "today_alerts": {
            "total": alerts_summary["total"],
            "by_type": alerts_summary["by_type"],
            "top": alerts_summary["top"],
        },
        "recent_fetches": recent,
        "quota": {
            "accounts": {
                "total": acc_total,
                "valid": acc_valid,
                "expired": acc_expired,
            },
            "posts": {
                "total": len(posts),
                "by_platform": posts_by_platform,
            },
            "creators": len(creators),
        },
        "metric_totals": {
            "likes": likes_sum,
            "collects": collects_sum,
            "comments": comments_sum,
        },
    }
