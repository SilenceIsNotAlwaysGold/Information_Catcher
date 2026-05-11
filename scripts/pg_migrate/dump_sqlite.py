#!/usr/bin/env python3
"""把现有 SQLite 数据 dump 成 PG 友好的 SQL 文件，准备迁移。

输出（写到 scripts/pg_migrate/out/）：
    schema_monitor.sql      ← PG 版本的 monitor.db schema（CREATE TABLE）
    schema_users.sql        ← PG 版本的 users.db schema
    data_monitor.sql        ← INSERT 语句（30+ 表）
    data_users.sql          ← users 表数据

使用：
    # 同时导 schema + data（默认）
    .venv/bin/python -m scripts.pg_migrate.dump_sqlite

    # 只导数据（推荐：schema 由 monitor_db.init_db() 在 PG 上自动建）
    .venv/bin/python -m scripts.pg_migrate.dump_sqlite --data-only

    # 只导 schema（备用方案，万一 init_db 在 PG 上行为不一致）
    .venv/bin/python -m scripts.pg_migrate.dump_sqlite --schema-only

设计说明：
- SKIP_TABLES：完全跳过（schema + data 都不导），保留给 sqlite 内置或已彻底废弃的表。
- SKIP_DATA_ONLY：保留 schema、丢弃数据。这些表数据量大但价值低或已废弃
  （fetch_log/monitor_snapshots 是滚动日志，monitor_lives 已下线，
   monitor_posts_fts 是 sqlite 专属虚拟表 PG 不存在）。
- 让 schema 始终包含 monitor_snapshots：因为 `get_posts` 仍 LEFT JOIN
  这张表，PG 必须有它（哪怕一行数据都没有）。
"""
from __future__ import annotations

import argparse
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import List, Tuple

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "scripts" / "pg_migrate" / "out"
OUT.mkdir(parents=True, exist_ok=True)

# 完全跳过：sqlite 内置 / sqlite 专属虚拟表（PG 无等价）
SKIP_TABLES = {
    "sqlite_sequence",       # sqlite 内置
    "monitor_posts_fts",     # FTS5 虚拟表，PG 无等价（业务已改 LIKE，不依赖它）
    "monitor_posts_fts_data",
    "monitor_posts_fts_idx",
    "monitor_posts_fts_content",
    "monitor_posts_fts_docsize",
    "monitor_posts_fts_config",
    "_wal_test",             # WAL 模式探针表，残留无意义
}

# 保留 schema、跳过 data：滚动日志 / 已下线 / 数据无价值
SKIP_DATA_ONLY = {
    "monitor_snapshots",  # 15k+ 行历史快照，可重新生成；schema 必留（get_posts 会 LEFT JOIN）
    "fetch_log",          # 5k+ 行健康度日志，滚动覆盖
    "monitor_lives",      # 已下线功能
    "monitor_posts_fts",  # 已在 SKIP_TABLES，这里冗余写一遍便于查阅
}


def sqlite_to_pg_type(col_type: str, col_name: str, is_pk: bool = False) -> str:
    """SQLite type → PG type。SQLite 类型相对随意，按约定推断。

    is_pk=True + name=id：返回 BIGSERIAL PRIMARY KEY。SQLite 里 `INTEGER PRIMARY KEY`
    隐式 AUTOINCREMENT，PRAGMA 看不到关键字所以我们靠 (pk=1, name=id) 推断。
    """
    t = (col_type or "").upper().strip()
    if "INT" in t:
        if is_pk and col_name == "id":
            return "BIGSERIAL PRIMARY KEY"
        return "BIGINT"
    if "TEXT" in t or "CHAR" in t or "CLOB" in t:
        return "TEXT"
    if "BLOB" in t:
        return "BYTEA"
    if "REAL" in t or "FLOA" in t or "DOUB" in t or "NUMERIC" in t or "DECIMAL" in t:
        return "DOUBLE PRECISION"
    if "BOOL" in t:
        return "BOOLEAN"
    # SQLite 灵活类型默认 TEXT
    return "TEXT"


def translate_default(default: str | None, pg_type: str) -> str:
    """SQLite DEFAULT 值翻译成 PG。"""
    if default is None:
        return ""
    s = default.strip()
    if "strftime" in s.lower():
        return " DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)"
    if "datetime" in s and "now" in s.lower():
        return " DEFAULT NOW()"
    if "CURRENT_TIMESTAMP" in s.upper():
        return " DEFAULT NOW()"
    if s.startswith("'") and s.endswith("'"):
        return f" DEFAULT {s}"
    if re.match(r"^-?\d+(\.\d+)?$", s):
        return f" DEFAULT {s}"
    if s.upper() == "NULL":
        return " DEFAULT NULL"
    return f" DEFAULT {s}"


def dump_schema(conn: sqlite3.Connection, db_label: str) -> Tuple[str, List[str]]:
    """生成 PG 版的 CREATE TABLE 语句 + 列出处理的表名。"""
    cur = conn.cursor()
    cur.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    tables = cur.fetchall()
    out_lines = [
        f"-- PG schema 自动从 SQLite ({db_label}) 翻译，生成于 {datetime.now().isoformat(timespec='seconds')}",
        "-- 翻译规则：INTEGER → BIGINT；id+AUTOINCREMENT → BIGSERIAL；datetime() → NOW()",
        "",
    ]
    processed: List[str] = []

    for name, _create_sql in tables:
        if name in SKIP_TABLES:
            continue
        cur.execute(f"PRAGMA table_info({name})")
        cols = cur.fetchall()  # (cid, name, type, notnull, dflt_value, pk)
        cur.execute(f"PRAGMA index_list({name})")
        idx_rows = cur.fetchall()  # (seq, name, unique, origin, partial)

        out_lines.append(f"-- ── {name} ──")
        out_lines.append(f"CREATE TABLE IF NOT EXISTS {name} (")
        pk_cols = sorted([c for c in cols if c[5] > 0], key=lambda c: c[5])
        is_composite_pk = len(pk_cols) > 1

        col_defs = []
        for c in cols:
            _, cname, ctype, notnull, dflt, pk = c
            pg_type = sqlite_to_pg_type(ctype or "", cname, is_pk=bool(pk) and not is_composite_pk)
            line = f"  {cname} {pg_type}"
            if "PRIMARY KEY" in pg_type:
                pass
            elif pk and not is_composite_pk:
                line += " PRIMARY KEY"
            if notnull and "PRIMARY KEY" not in line:
                line += " NOT NULL"
            line += translate_default(dflt, pg_type)
            col_defs.append(line)
        if is_composite_pk:
            pk_names = [c[1] for c in pk_cols]
            col_defs.append(f"  PRIMARY KEY ({', '.join(pk_names)})")
        out_lines.append(",\n".join(col_defs))
        out_lines.append(");")
        out_lines.append("")

        for idx in idx_rows:
            _, idx_name, is_unique, origin, _ = idx
            if origin == "pk" or idx_name.startswith("sqlite_autoindex"):
                continue
            cur.execute(f"PRAGMA index_info({idx_name})")
            idx_cols = [r[2] for r in cur.fetchall() if r[2] is not None]
            if not idx_cols:
                out_lines.append(f"-- 跳过表达式索引 {idx_name}（需手动翻译）")
                continue
            uniq = "UNIQUE " if is_unique else ""
            out_lines.append(
                f"CREATE {uniq}INDEX IF NOT EXISTS {idx_name} ON {name}({', '.join(idx_cols)});"
            )
        out_lines.append("")
        processed.append(name)

    return "\n".join(out_lines), processed


def quote_pg_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, bytes):
        hex_str = v.hex()
        return f"E'\\\\x{hex_str}'"
    s = str(v).replace("'", "''")
    return f"'{s}'"


def dump_data(conn: sqlite3.Connection, tables: List[str]) -> Tuple[str, dict]:
    """生成 INSERT 语句。每张表一段，分批 200 行一条 INSERT 提升导入速度。

    返回 (sql 文本, {table_name: row_count}) —— 行数字典给 cutover 行数校验用。
    """
    cur = conn.cursor()
    cur.row_factory = sqlite3.Row
    counts: dict = {}
    out_lines = [
        f"-- 数据 dump，生成于 {datetime.now().isoformat(timespec='seconds')}",
        "-- 注意：通过适配层翻译 SQL 时 `INSERT` 不会自动追加 ON CONFLICT，",
        "-- 但此文件由 psql 直接执行，已显式写 ON CONFLICT DO NOTHING。",
        "-- session_replication_role=replica 临时禁用所有 FK / 触发器，",
        "-- 避免按字母序导入时被外键引用顺序卡住（结束时恢复）。",
        "BEGIN;",
        "SET session_replication_role = replica;",
        "",
    ]
    for tbl in tables:
        if tbl in SKIP_DATA_ONLY:
            out_lines.append(f"-- {tbl}: 跳过数据（SKIP_DATA_ONLY），schema 保留")
            counts[tbl] = 0
            continue
        try:
            rows = list(cur.execute(f"SELECT * FROM {tbl}"))
        except sqlite3.Error as e:
            out_lines.append(f"-- 跳过 {tbl}: {e}")
            counts[tbl] = -1
            continue
        counts[tbl] = len(rows)
        if not rows:
            out_lines.append(f"-- {tbl}: (空)")
            continue
        cols = rows[0].keys()
        out_lines.append(f"-- {tbl}: {len(rows)} 行")
        BATCH = 200
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            values = []
            for r in chunk:
                values.append("(" + ", ".join(quote_pg_value(r[c]) for c in cols) + ")")
            out_lines.append(
                f"INSERT INTO {tbl} ({', '.join(cols)}) VALUES\n"
                + ",\n".join(values)
                + "\nON CONFLICT DO NOTHING;"
            )
        out_lines.append("")
    out_lines.append("SET session_replication_role = origin;")
    out_lines.append("COMMIT;")
    # 同步所有 BIGSERIAL 序列到当前最大 id（否则后续 INSERT 会主键冲突）
    out_lines.append("")
    out_lines.append("-- 同步 BIGSERIAL 序列，否则导入后 INSERT 会主键冲突")
    out_lines.append("DO $$")
    out_lines.append("DECLARE r record;")
    out_lines.append("BEGIN")
    out_lines.append("  FOR r IN")
    out_lines.append("    SELECT c.relname AS seqname,")
    out_lines.append("           t.relname AS tblname,")
    out_lines.append("           a.attname AS colname")
    out_lines.append("    FROM pg_class c")
    out_lines.append("    JOIN pg_depend d ON d.objid = c.oid")
    out_lines.append("    JOIN pg_class t ON d.refobjid = t.oid")
    out_lines.append("    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid")
    out_lines.append("    WHERE c.relkind = 'S' AND t.relnamespace = 'public'::regnamespace")
    out_lines.append("  LOOP")
    out_lines.append("    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 1))',")
    out_lines.append("                   r.seqname, r.colname, r.tblname);")
    out_lines.append("  END LOOP;")
    out_lines.append("END $$;")
    return "\n".join(out_lines), counts


def dump_one_db(db_path: Path, label: str, mode: str) -> dict:
    """mode: 'all' | 'schema-only' | 'data-only'

    返回 {table_name: row_count}（data 模式下；schema-only 下返回空 dict）。
    """
    print(f"\n=== dumping {db_path} (mode={mode}) ===")
    if not db_path.exists():
        print(f"  跳过（文件不存在）")
        return {}
    conn = sqlite3.connect(str(db_path))

    schema_sql, tables = dump_schema(conn, label)
    counts: dict = {}

    if mode in ("all", "schema-only"):
        (OUT / f"schema_{label}.sql").write_text(schema_sql, encoding="utf-8")
        print(f"  schema → {label}: {len(tables)} 表 (skip完全={sorted(SKIP_TABLES)})")

    if mode in ("all", "data-only"):
        data_sql, counts = dump_data(conn, tables)
        (OUT / f"data_{label}.sql").write_text(data_sql, encoding="utf-8")
        size_kb = (OUT / f"data_{label}.sql").stat().st_size // 1024
        print(f"  data   → 写入 {size_kb} KB；表数={len(tables)}；"
              f"data-only-skip={sorted(SKIP_DATA_ONLY)}")
        # 顺手把 counts 写到 out/counts_{label}.tsv，给 cutover 行数校验
        tsv = "\n".join(f"{t}\t{n}" for t, n in sorted(counts.items()))
        (OUT / f"counts_{label}.tsv").write_text(tsv, encoding="utf-8")

    conn.close()
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--schema-only", action="store_true", help="只导 schema（CREATE TABLE）")
    ap.add_argument("--data-only", action="store_true", help="只导 data（INSERT）")
    ap.add_argument("--db-dir", default=str(ROOT / "database"),
                    help="sqlite 文件目录（默认 ./database）")
    args = ap.parse_args()

    if args.schema_only and args.data_only:
        ap.error("--schema-only 和 --data-only 互斥")
    mode = "schema-only" if args.schema_only else ("data-only" if args.data_only else "all")

    db_dir = Path(args.db_dir)
    print(f"输出目录: {OUT}")
    print(f"sqlite 目录: {db_dir}")
    print(f"模式: {mode}")

    dump_one_db(db_dir / "monitor.db", "monitor", mode)
    dump_one_db(db_dir / "users.db", "users", mode)

    print("\n[OK] dump 完成。下一步：")
    if mode != "data-only":
        print(f"  schema_*.sql 已生成（PG 用 init_db() 自动建表则可不用）")
    if mode != "schema-only":
        print(f"  data_*.sql 已生成；counts_*.tsv 含每表行数（cutover 校验用）")


if __name__ == "__main__":
    main()
