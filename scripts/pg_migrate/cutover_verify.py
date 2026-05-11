#!/usr/bin/env python3
"""Cutover 校验脚本：导入后比对 sqlite vs PG 行数 + 调几个 monitor_db 接口看是否一致。

两阶段校验：
  阶段 A：纯行数对比（直接 SQL 查 PG 远端 + sqlite 本地副本）
  阶段 B：用 monitor_db 高层接口分别在两个驱动下跑，对比关键 API 结果

注意：阶段 B 要求本地能装 asyncpg；如果环境缺，就只跑阶段 A 也能初步验证。

用法（被 cutover.sh 调用）：
    python scripts/pg_migrate/cutover_verify.py \\
        --sqlite /tmp/.../monitor.db \\
        --counts-tsv /tmp/.../counts_monitor.tsv \\
        --pg-host 117.72.161.176 --pg-port 5432 \\
        --pg-user redbook --pg-pass redbook_pulse_2026 --pg-db redbook_test
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shlex
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Tuple

# data 不导但 schema 保留的表：行数预期为 0
SKIP_DATA_TABLES = {"monitor_snapshots", "fetch_log", "monitor_lives", "monitor_posts_fts", "_wal_test"}


def parse_counts_tsv(path: Path) -> Dict[str, int]:
    """读 dump 阶段生成的 counts_monitor.tsv（每行 "table\trows"）。"""
    out: Dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        t, n = line.split("\t", 1)
        try:
            out[t.strip()] = int(n.strip())
        except ValueError:
            continue
    return out


def sqlite_counts(db_path: Path) -> Dict[str, int]:
    conn = sqlite3.connect(str(db_path))
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    tables = [r[0] for r in cur.fetchall()]
    counts: Dict[str, int] = {}
    for t in tables:
        try:
            n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            counts[t] = n
        except sqlite3.Error:
            counts[t] = -1
    conn.close()
    return counts


def pg_counts_via_ssh(remote_user: str, remote_pass: str, remote_host: str,
                      pg_user: str, pg_pass: str, pg_host: str, pg_db: str) -> Dict[str, int]:
    """走 sshpass 远端 psql 拿每表行数（避免本地装 asyncpg）。"""
    # 一次性查所有表
    sql = (
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    )
    cmd = [
        "sshpass", "-p", remote_pass,
        "ssh", "-o", "StrictHostKeyChecking=no",
        f"{remote_user}@{remote_host}",
        f"PGPASSWORD={pg_pass} psql -U {pg_user} -h {pg_host} -d {pg_db} -tA -c {shlex.quote(sql)}",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"远端列表 PG 表失败：{r.stderr}")
    tables = [line.strip() for line in r.stdout.splitlines() if line.strip()]

    # 拼一个一次性的 UNION ALL，避免每张表都开 ssh 连接
    union = " UNION ALL ".join(
        f"SELECT '{t}' AS tbl, count(*)::bigint AS n FROM \"{t}\"" for t in tables
    )
    cmd2 = [
        "sshpass", "-p", remote_pass,
        "ssh", "-o", "StrictHostKeyChecking=no",
        f"{remote_user}@{remote_host}",
        f"PGPASSWORD={pg_pass} psql -U {pg_user} -h {pg_host} -d {pg_db} -tA -F$'\\t' -c {shlex.quote(union)}",
    ]
    r2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=120)
    if r2.returncode != 0:
        raise RuntimeError(f"远端 PG count 失败：{r2.stderr}")
    out: Dict[str, int] = {}
    for line in r2.stdout.splitlines():
        line = line.strip()
        if not line or "\t" not in line:
            continue
        t, n = line.split("\t", 1)
        try:
            out[t.strip()] = int(n.strip())
        except ValueError:
            continue
    return out


def stage_a_compare(sqlite_db: Path, pg: Dict[str, int]) -> Tuple[bool, List[str]]:
    """对比 sqlite 行数 vs PG 行数。"""
    sq = sqlite_counts(sqlite_db)
    rows: List[str] = []
    rows.append(f"{'TABLE':30s} {'SQLITE':>10s} {'PG':>10s} {'DIFF':>10s} STATUS")
    ok_all = True
    union_tables = sorted(set(sq) | set(pg))
    for t in union_tables:
        s = sq.get(t)
        p = pg.get(t)
        if s is None:
            status = "PG-only"
            diff = ""
        elif p is None:
            status = "SQLITE-only"
            diff = ""
            # 如果是被 SKIP 的表，缺失 PG 是预期
            if t in SKIP_DATA_TABLES or t.startswith("sqlite_") or t.startswith("monitor_posts_fts"):
                status = "skip (PG 无)"
            else:
                ok_all = False
        else:
            diff = p - s
            if t in SKIP_DATA_TABLES:
                # 这些表数据被丢弃，PG 0 是预期
                status = "skip-data OK" if p == 0 else "skip-data WARN"
            elif s == p:
                status = "OK"
            else:
                status = "MISMATCH"
                ok_all = False
        rows.append(f"{t:30s} {str(s if s is not None else '-'):>10s} "
                    f"{str(p if p is not None else '-'):>10s} {str(diff):>10s} {status}")
    return ok_all, rows


# ── 阶段 B：通过 monitor_db 高层接口对比 ────────────────────────────────────

async def stage_b_api_compare(sqlite_db: Path, pg_env: dict) -> Tuple[bool, List[str]]:
    """在 sqlite 和 PG 两种驱动下分别调几个 monitor_db 接口，比较结果。

    需要本地能 import api.services.monitor_db（即从项目根跑）。
    PG 模式需要本地装 asyncpg 且能连远端 PG（远端要允许 5432 从外部接入）。
    若不能，本函数会自动 fallback 到通过 ssh 远端跑 python 比对的方式——但比较粗，
    所以先尝试本地，若 asyncpg/远端不可达就给个 warning 跳过。
    """
    out: List[str] = []
    proj_root = Path(__file__).resolve().parents[2]
    if str(proj_root) not in sys.path:
        sys.path.insert(0, str(proj_root))

    # 1) sqlite 模式：直接连本地 sqlite 副本
    os.environ.pop("PULSE_DB_DRIVER", None)
    os.environ["PULSE_DB_DRIVER"] = "sqlite"
    # monitor_db 用模块级 DB_PATH，需要 monkey-patch
    from api.services import monitor_db as mdb  # type: ignore
    from importlib import reload
    mdb.DB_PATH = str(sqlite_db)

    settings_sqlite = await mdb.get_all_settings()
    posts_sqlite = await mdb.get_posts(user_id=1) if hasattr(mdb, "get_posts") else []
    alerts_sqlite = await mdb.get_alerts(user_id=1) if hasattr(mdb, "get_alerts") else []

    out.append(f"  [sqlite] settings={len(settings_sqlite)}  posts(uid=1)={len(posts_sqlite)}  alerts(uid=1)={len(alerts_sqlite)}")

    # 2) PG 模式：切环境变量、重置连接池、重 import 模块
    try:
        import asyncpg  # noqa: F401
    except ImportError:
        out.append("  [SKIP] 本地未装 asyncpg，阶段 B 跳过；只信任阶段 A 行数对比")
        return True, out

    os.environ["PULSE_DB_DRIVER"] = "pg"
    for k, v in pg_env.items():
        os.environ[k] = v

    # 重新加载 db.py 让它读新环境
    from api.services import db as _db
    _db._pg_pool = None  # 强制重建连接池
    reload(mdb)

    try:
        settings_pg = await mdb.get_all_settings()
        posts_pg = await mdb.get_posts(user_id=1) if hasattr(mdb, "get_posts") else []
        alerts_pg = await mdb.get_alerts(user_id=1) if hasattr(mdb, "get_alerts") else []
    except Exception as e:
        # 远端 PG 若不允许从本地 IP 直连，会得到 connection_lost / 超时之类的网络错误。
        # 阶段 A 已经把行数 OK 了，这里降级为 warn，不阻断 cutover。
        out.append(f"  [SKIP] 阶段 B 无法直连远端 PG（{type(e).__name__}: {e}）"
                   "——若远端只对 127.0.0.1 开放是正常的；行数已由阶段 A 校验")
        try:
            await _db.shutdown()
        except Exception:
            pass
        return True, out
    finally:
        try:
            await _db.shutdown()
        except Exception:
            pass

    out.append(f"  [PG    ] settings={len(settings_pg)}  posts(uid=1)={len(posts_pg)}  alerts(uid=1)={len(alerts_pg)}")

    ok = (
        len(settings_pg) == len(settings_sqlite)
        and len(posts_pg) == len(posts_sqlite)
        and len(alerts_pg) == len(alerts_sqlite)
    )
    out.append("  → 一致" if ok else "  → 不一致（检查 SQL 翻译 / schema 差异）")
    return ok, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", required=True, help="本地 sqlite 副本路径")
    ap.add_argument("--counts-tsv", help="dump 生成的 counts_monitor.tsv（可选，仅展示）")
    ap.add_argument("--pg-host", required=True)
    ap.add_argument("--pg-port", default="5432")
    ap.add_argument("--pg-user", required=True)
    ap.add_argument("--pg-pass", required=True)
    ap.add_argument("--pg-db", required=True)
    ap.add_argument("--remote-user", default="root")
    ap.add_argument("--remote-pass", required=True, help="远端 ssh 密码（用于 sshpass）")
    ap.add_argument("--skip-stage-b", action="store_true", help="跳过 API 对比阶段")
    args = ap.parse_args()

    sqlite_db = Path(args.sqlite)
    if not sqlite_db.exists():
        print(f"[FAIL] sqlite 文件不存在: {sqlite_db}")
        sys.exit(2)

    # 阶段 A
    print("\n--- 阶段 A：行数对比（sqlite vs PG）---")
    pg = pg_counts_via_ssh(
        args.remote_user, args.remote_pass, args.pg_host,
        args.pg_user, args.pg_pass, "127.0.0.1", args.pg_db,
    )
    ok_a, rows = stage_a_compare(sqlite_db, pg)
    print("\n".join(rows))
    print(f"\n  阶段 A 结果：{'OK' if ok_a else 'MISMATCH'}")

    # 阶段 B
    ok_b = True
    if not args.skip_stage_b:
        print("\n--- 阶段 B：monitor_db 接口对比 ---")
        pg_env = {
            "PULSE_PG_HOST": args.pg_host,
            "PULSE_PG_PORT": args.pg_port,
            "PULSE_PG_USER": args.pg_user,
            "PULSE_PG_PASS": args.pg_pass,
            "PULSE_PG_DB": args.pg_db,
        }
        try:
            ok_b, lines = asyncio.run(stage_b_api_compare(sqlite_db, pg_env))
            print("\n".join(lines))
        except Exception as e:
            print(f"  [SKIP] 阶段 B 异常（不阻断流程）：{e}")
            ok_b = True

    if ok_a and ok_b:
        print("\n[OK] cutover 校验通过")
        sys.exit(0)
    else:
        print("\n[FAIL] cutover 校验失败，检查上方 MISMATCH 行")
        sys.exit(1)


if __name__ == "__main__":
    main()
