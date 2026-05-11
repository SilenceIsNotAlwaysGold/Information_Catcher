#!/usr/bin/env python3
"""把现有 SQLite 数据 dump 成 PG 友好的 SQL 文件，准备迁移。

输出：
  scripts/pg_migrate/out/
    schema_monitor.sql      ← PG 版本的 monitor.db schema（CREATE TABLE）
    schema_users.sql        ← PG 版本的 users.db schema
    data_monitor.sql        ← INSERT 语句（30+ 表）
    data_users.sql          ← users 表数据
    skipped.txt             ← 跳过的表（临时/缓存/已废弃）

使用：
  cd /opt/redbook
  .venv/bin/python -m scripts.pg_migrate.dump_sqlite

只是 dump，不做 load。load 由 Phase 2/3 的代码改造时统一处理。
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Tuple

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "scripts" / "pg_migrate" / "out"
OUT.mkdir(parents=True, exist_ok=True)

# 跳过这些表：临时缓存 / 已废弃 / 数据没价值
SKIP_TABLES = {
    "sqlite_sequence",  # 内置
    "monitor_lives",    # 已下线
    "fetch_log",        # 健康度日志（可重建）
    "monitor_snapshots", # 快照（保留时间窗的可重新生成；如要全量改 False）
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
    # SQLite strftime('%s','now') → PG EXTRACT(EPOCH FROM NOW())::BIGINT
    if "strftime" in s.lower():
        return " DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)"
    # SQLite datetime('now', 'localtime') → PG NOW()
    if "datetime" in s and "now" in s.lower():
        return " DEFAULT NOW()"
    if "CURRENT_TIMESTAMP" in s.upper():
        return " DEFAULT NOW()"
    # 字符串字面量保留
    if s.startswith("'") and s.endswith("'"):
        return f" DEFAULT {s}"
    # 数字
    if re.match(r"^-?\d+(\.\d+)?$", s):
        return f" DEFAULT {s}"
    # NULL
    if s.upper() == "NULL":
        return " DEFAULT NULL"
    # 其它（罕见）：原样输出
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
        # PRAGMA table_info 拿列信息
        cur.execute(f"PRAGMA table_info({name})")
        cols = cur.fetchall()  # (cid, name, type, notnull, dflt_value, pk)
        # PRAGMA index_list 拿索引
        cur.execute(f"PRAGMA index_list({name})")
        idx_rows = cur.fetchall()  # (seq, name, unique, origin, partial)

        out_lines.append(f"-- ── {name} ──")
        out_lines.append(f"CREATE TABLE IF NOT EXISTS {name} (")
        # 先扫一遍找复合主键的列（pk>=1 的列数 > 1 时是复合主键）
        pk_cols = sorted([c for c in cols if c[5] > 0], key=lambda c: c[5])
        is_composite_pk = len(pk_cols) > 1

        col_defs = []
        for c in cols:
            _, cname, ctype, notnull, dflt, pk = c
            pg_type = sqlite_to_pg_type(ctype or "", cname, is_pk=bool(pk) and not is_composite_pk)
            line = f"  {cname} {pg_type}"
            if "PRIMARY KEY" in pg_type:
                pass  # BIGSERIAL 已含 PK
            elif pk and not is_composite_pk:
                line += " PRIMARY KEY"
            # 复合主键的列各自不加 PRIMARY KEY；末尾统一 PRIMARY KEY(col1,col2)
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

        # 索引
        for idx in idx_rows:
            _, idx_name, is_unique, origin, _ = idx
            if origin == "pk" or idx_name.startswith("sqlite_autoindex"):
                continue
            cur.execute(f"PRAGMA index_info({idx_name})")
            # 部分表达式索引列名为 None，跳过这类索引（PG 需要重新表达）
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
    # string：处理单引号转义
    s = str(v).replace("'", "''")
    return f"'{s}'"


def dump_data(conn: sqlite3.Connection, tables: List[str]) -> str:
    """生成 INSERT 语句。每张表一段，分批 200 行一条 INSERT 提升导入速度。"""
    cur = conn.cursor()
    cur.row_factory = sqlite3.Row
    out_lines = [
        f"-- 数据 dump，生成于 {datetime.now().isoformat(timespec='seconds')}",
        "BEGIN;",
        "",
    ]
    for tbl in tables:
        try:
            rows = list(cur.execute(f"SELECT * FROM {tbl}"))
        except sqlite3.Error as e:
            out_lines.append(f"-- 跳过 {tbl}: {e}")
            continue
        if not rows:
            out_lines.append(f"-- {tbl}: (空)")
            continue
        cols = rows[0].keys()
        out_lines.append(f"-- {tbl}: {len(rows)} 行")
        # 分批 200 行
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
    out_lines.append("COMMIT;")
    return "\n".join(out_lines)


def dump_one_db(db_path: Path, label: str) -> None:
    print(f"\n=== dumping {db_path} ===")
    if not db_path.exists():
        print(f"  跳过（文件不存在）")
        return
    conn = sqlite3.connect(str(db_path))
    schema_sql, tables = dump_schema(conn, label)
    data_sql = dump_data(conn, tables)
    conn.close()

    (OUT / f"schema_{label}.sql").write_text(schema_sql, encoding="utf-8")
    (OUT / f"data_{label}.sql").write_text(data_sql, encoding="utf-8")
    print(f"  schema → {label}: {len(tables)} 表")
    print(f"  data   → 写入 {(OUT / f'data_{label}.sql').stat().st_size // 1024} KB")
    print(f"  跳过：{', '.join(sorted(SKIP_TABLES))}")


def main():
    print(f"输出目录: {OUT}")
    dump_one_db(ROOT / "database" / "monitor.db", "monitor")
    dump_one_db(ROOT / "database" / "users.db", "users")
    print("\n✅ dump 完成。下一步：")
    print(f"  1. 把 {OUT} 拷到远端 PG 服务器")
    print(f"  2. 用 psql 导入：psql -U redbook -d redbook -f schema_monitor.sql")
    print(f"     再 psql ... -f data_monitor.sql ; 同理 users")
    print(f"  3. 等代码改造完，验证 SELECT/INSERT 行为一致")


if __name__ == "__main__":
    main()
