# -*- coding: utf-8 -*-
"""数据库适配层：透明支持 SQLite (aiosqlite) 和 PostgreSQL (asyncpg)。

由环境变量 PULSE_DB_DRIVER 决定走哪条路：
  - "sqlite"（默认）：直接转发到 aiosqlite，0 改动
  - "pg"：用 asyncpg 但表现得像 aiosqlite，让现有调用方零感知切换

monitor_db.py 现有代码不动，只需把 `aiosqlite.connect(DB_PATH)` 改成
`from . import db; db.connect(DB_PATH)`。

兼容的 aiosqlite API 子集（覆盖现有 monitor_db.py 用到的全部模式）：
  async with db.connect(path) as conn:
      conn.row_factory = ROW         # 仅 PG 模式有意义；sqlite 直接透传
      async with conn.execute(sql, params) as cur:
          row = await cur.fetchone()
          rows = await cur.fetchall()
      await conn.execute(sql, params)
      await conn.executescript("多语句 SQL")
      await conn.commit()
"""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Iterable, Optional, Sequence

import aiosqlite


def _driver() -> str:
    """优先环境变量；默认 sqlite 不影响现状。"""
    v = (os.environ.get("PULSE_DB_DRIVER") or "sqlite").strip().lower()
    return "pg" if v == "pg" else "sqlite"


def is_pg() -> bool:
    """对外暴露当前驱动判断，业务代码可用来跳过 sqlite 专属逻辑（FTS 等）。"""
    return _driver() == "pg"


# ── PG 连接池（懒加载，全进程共享）─────────────────────────────────────────

_pg_pool: Any = None  # asyncpg.Pool


async def _get_pg_pool():
    global _pg_pool
    if _pg_pool is not None:
        return _pg_pool
    import asyncpg
    dsn = os.environ.get("PULSE_PG_DSN") or (
        f"postgresql://{os.environ.get('PULSE_PG_USER', 'redbook')}:"
        f"{os.environ.get('PULSE_PG_PASS', 'redbook_pulse_2026')}"
        f"@{os.environ.get('PULSE_PG_HOST', '127.0.0.1')}:"
        f"{os.environ.get('PULSE_PG_PORT', '5432')}/"
        f"{os.environ.get('PULSE_PG_DB', 'redbook')}"
    )
    _pg_pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=2,
        max_size=int(os.environ.get("PULSE_PG_MAX_POOL", "20")),
        command_timeout=60,
    )
    return _pg_pool


async def shutdown() -> None:
    """app 退出时调，关连接池。SQLite 模式下 no-op。"""
    global _pg_pool
    if _pg_pool is not None:
        await _pg_pool.close()
        _pg_pool = None


# ── SQL 翻译：把 SQLite 风格转成 PG ─────────────────────────────────────────

_PLACEHOLDER_RE = re.compile(r"\?")
# strftime('%s','now') → unix 时间戳；用于 ext_tasks.created_at 等
_STRFTIME_S_NOW = re.compile(r"\(?\s*strftime\(\s*'%s'\s*,\s*'now'\s*\)\s*\)?", re.IGNORECASE)
# datetime('now','localtime') → NOW()
_DATETIME_NOW = re.compile(r"datetime\(\s*'now'\s*(?:,\s*'localtime'\s*)?\)", re.IGNORECASE)
# date('now','localtime') → CURRENT_DATE
_DATE_NOW = re.compile(r"date\(\s*'now'\s*(?:,\s*'localtime'\s*)?\)", re.IGNORECASE)
# date('now','-N days','localtime') → CURRENT_DATE - INTERVAL 'N days'
_DATE_DELTA = re.compile(
    r"date\(\s*'now'\s*,\s*'(-?\d+)\s+days'\s*(?:,\s*'localtime'\s*)?\)", re.IGNORECASE,
)
# datetime('now','localtime', '-N units') 字面量 → (NOW() + INTERVAL '-N units')
_DATETIME_NOW_3ARG_LIT = re.compile(
    r"datetime\(\s*'now'\s*,\s*'localtime'\s*,\s*'(-?\d+\s+\w+)'\s*\)",
    re.IGNORECASE,
)
# datetime('now','localtime', ?) 占位符 → (NOW() + (?)::interval)
# ? 保留以待后续 placeholder 阶段替换为 $N
_DATETIME_NOW_3ARG_PARAM = re.compile(
    r"datetime\(\s*'now'\s*,\s*'localtime'\s*,\s*\?\s*\)",
    re.IGNORECASE,
)
# date('now', ?) 占位符 → (CURRENT_DATE + (?)::interval)
_DATE_PARAM = re.compile(r"date\(\s*'now'\s*,\s*\?\s*\)", re.IGNORECASE)
# INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING（PG 支持原生 ON CONFLICT，
# 但 OR IGNORE 不是 PG 语法，单独翻译）
_INSERT_OR_IGNORE = re.compile(r"\bINSERT\s+OR\s+IGNORE\b", re.IGNORECASE)
_INSERT_OR_REPLACE = re.compile(r"\bINSERT\s+OR\s+REPLACE\b", re.IGNORECASE)
# INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
_AUTOINC = re.compile(
    r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT", re.IGNORECASE,
)
# 单独的 AUTOINCREMENT 关键字（如 BIGINT AUTOINCREMENT 等异常写法）
_AUTOINC_BARE = re.compile(r"\bAUTOINCREMENT\b", re.IGNORECASE)
# PRAGMA journal_mode / synchronous / busy_timeout / foreign_keys 在 PG 无意义
_PRAGMA_NOOP = re.compile(
    r"PRAGMA\s+(journal_mode|synchronous|busy_timeout|foreign_keys|cache_size|"
    r"temp_store|mmap_size|page_size|auto_vacuum)\s*=\s*\S+", re.IGNORECASE,
)
# PRAGMA table_info(t) → 转 PG information_schema 查询，列顺序模拟 sqlite 输出
_PRAGMA_TABLE_INFO = re.compile(r"PRAGMA\s+table_info\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)", re.IGNORECASE)
# sqlite_master：sqlite 内置系统表，PG 没有。所有查询替换为空集，让 schema 探测类
# 迁移函数自动 short-circuit（这些迁移在 PG 部署上本来就不需要——_INIT_SQL 已建新结构）
_SQLITE_MASTER = re.compile(r"\bFROM\s+sqlite_master\b", re.IGNORECASE)
# DROP TRIGGER IF EXISTS xxx（无 ON 子句）：sqlite 合法、PG 缺 `ON table` 报语法错。
# 这类残留清理逻辑在 PG 部署上无意义（PG 模式根本不建这些 trigger），直接 no-op。
_DROP_TRIGGER_NO_ON = re.compile(
    r"DROP\s+TRIGGER\s+IF\s+EXISTS\s+[a-zA-Z_][a-zA-Z0-9_]*\s*(?!ON\b)",
    re.IGNORECASE,
)
# BEGIN IMMEDIATE：sqlite 专属事务模式（立即写锁）。PG 无对应概念，统一翻 BEGIN。
_BEGIN_IMMEDIATE = re.compile(r"\bBEGIN\s+IMMEDIATE\b", re.IGNORECASE)


def _translate_sql_for_pg(sql: str) -> str:
    """把 SQLite 方言翻译为 PG 兼容的 SQL。"""
    s = sql
    s = _STRFTIME_S_NOW.sub("(EXTRACT(EPOCH FROM NOW())::BIGINT)", s)
    # 三参数版本必须先于 _DATETIME_NOW（两参数）翻译——否则会被两参数规则吃掉。
    # 输出 TO_CHAR text 格式（'YYYY-MM-DD"T"HH24:MI:SS'）以兼容应用层 isoformat(timespec='seconds')
    # 存的 TEXT 列；PG timestamp 跟 TEXT 列比较会直接报错。
    # interval 参数用 (?::text)::interval：避免 asyncpg 把占位符推断为 timedelta，
    # 改为 text 走 PG 内部 cast。
    _TS_FMT = "'YYYY-MM-DD\"T\"HH24:MI:SS'"
    _DATE_FMT = "'YYYY-MM-DD'"
    s = _DATETIME_NOW_3ARG_LIT.sub(
        lambda m: f"TO_CHAR(NOW() + INTERVAL '{m.group(1)}', {_TS_FMT})", s,
    )
    s = _DATETIME_NOW_3ARG_PARAM.sub(f"TO_CHAR(NOW() + (?::text)::interval, {_TS_FMT})", s)
    s = _DATETIME_NOW.sub(f"TO_CHAR(NOW(), {_TS_FMT})", s)
    s = _DATE_DELTA.sub(lambda m: f"(CURRENT_DATE + INTERVAL '{m.group(1)} days')", s)
    s = _DATE_PARAM.sub(f"TO_CHAR(CURRENT_DATE + (?::text)::interval, {_DATE_FMT})", s)
    s = _DATE_NOW.sub("CURRENT_DATE", s)

    # AUTOINCREMENT：必须在 PRIMARY KEY 同行先合并替换，避免后面 _AUTOINC_BARE 误伤
    s = _AUTOINC.sub("BIGSERIAL PRIMARY KEY", s)
    s = _AUTOINC_BARE.sub("", s)  # 兜底：剩下的 AUTOINCREMENT 移除

    # PRAGMA：sqlite 专用，PG 全部 no-op 化（保留 SELECT 1 以便有合法 SQL）
    s = _PRAGMA_NOOP.sub("SELECT 1", s)
    # sqlite_master：PG 没有该系统表，让查询返回空集
    s = _SQLITE_MASTER.sub("FROM (SELECT NULL::TEXT AS sql, NULL::TEXT AS name, NULL::TEXT AS type WHERE FALSE) _empty", s)
    # DROP TRIGGER IF EXISTS xxx（无 ON 子句）：PG 模式 no-op
    s = _DROP_TRIGGER_NO_ON.sub("SELECT 1 ", s)
    # BEGIN IMMEDIATE → BEGIN
    s = _BEGIN_IMMEDIATE.sub("BEGIN", s)
    # PRAGMA table_info(t) → 等价 PG 查询，列顺序与 sqlite 一致：(cid,name,type,notnull,dflt_value,pk)
    m = _PRAGMA_TABLE_INFO.search(s)
    if m:
        tbl = m.group(1)
        repl = (
            "SELECT (ordinal_position - 1)::INTEGER AS cid, "
            "column_name AS name, "
            "data_type AS type, "
            "CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull, "
            "column_default AS dflt_value, "
            "0 AS pk "
            "FROM information_schema.columns "
            f"WHERE table_name='{tbl}' AND table_schema='public' "
            "ORDER BY ordinal_position"
        )
        s = _PRAGMA_TABLE_INFO.sub(repl, s)

    # INSERT OR IGNORE：PG 语义需要 ON CONFLICT DO NOTHING
    if _INSERT_OR_IGNORE.search(s):
        s = _INSERT_OR_IGNORE.sub("INSERT", s)
        if "ON CONFLICT" not in s.upper():
            # 简单追加在末尾（PG 接受 INSERT ... VALUES (...) ON CONFLICT DO NOTHING）
            s = s.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
    # INSERT OR REPLACE：PG 等价需要 ON CONFLICT(pk) DO UPDATE，但 PG 不知道 pk 名字
    # 当前未用到这种语法（grep monitor_db.py 0 处），先简单退化为 INSERT
    if _INSERT_OR_REPLACE.search(s):
        s = _INSERT_OR_REPLACE.sub("INSERT", s)

    # placeholder ? → $1, $2 ...
    if "?" in s:
        idx = [0]

        def _p(_m):
            idx[0] += 1
            return f"${idx[0]}"

        s = _PLACEHOLDER_RE.sub(_p, s)
    return s


# ── PG 包装层：模拟 aiosqlite API ───────────────────────────────────────────

class _PGCursor:
    """模拟 aiosqlite cursor，仅在 PG 模式被构造。"""

    def __init__(self, conn: "_PGConnection", sql: str, params: Sequence[Any]):
        self._conn = conn
        self._sql = _translate_sql_for_pg(sql)
        self._params = list(params or [])
        self._rows: Optional[list] = None
        self._executed = False
        # ASYNCPG-specific: lastrowid 模拟（仅当 INSERT 时通过 RETURNING id 拿）
        self.lastrowid: Optional[int] = None
        self.rowcount: int = 0

    async def __aenter__(self):
        await self._ensure_executed()
        return self

    async def __aexit__(self, *_):
        return None

    def __await__(self):
        """支持 aiosqlite 风格的 `await db.execute(...)`（不需要 async with）。"""
        async def _do():
            await self._ensure_executed()
            return self
        return _do().__await__()

    async def _ensure_executed(self):
        if self._executed:
            return
        sql = self._sql.strip()
        upper = sql.upper()
        async with self._conn._acquire() as raw:
            if upper.startswith(("SELECT", "WITH")):
                self._rows = await raw.fetch(sql, *self._params)
            elif upper.startswith("INSERT") and "RETURNING" not in upper:
                # 自动 RETURNING id 以模拟 lastrowid（兼容 monitor_db.py 现有用法）
                sql_with_returning = sql.rstrip(";") + " RETURNING id"
                try:
                    row = await raw.fetchrow(sql_with_returning, *self._params)
                    self.lastrowid = int(row["id"]) if row else None
                    self.rowcount = 1 if row else 0
                except Exception:
                    # 没有 id 列的表（如 daily_usage 复合主键）回退普通 execute
                    result = await raw.execute(sql, *self._params)
                    # asyncpg execute 返回 "INSERT 0 N" 文本
                    self.rowcount = _parse_rowcount(result)
            else:
                result = await raw.execute(sql, *self._params)
                self.rowcount = _parse_rowcount(result)
        self._executed = True

    async def fetchone(self):
        await self._ensure_executed()
        if not self._rows:
            return None
        r = self._rows[0]
        return _wrap_row(r, self._conn.row_factory)

    async def fetchall(self):
        await self._ensure_executed()
        if not self._rows:
            return []
        return [_wrap_row(r, self._conn.row_factory) for r in self._rows]


def _parse_rowcount(asyncpg_status: str) -> int:
    """asyncpg execute() 返回 'INSERT 0 5' / 'UPDATE 3' / 'DELETE 2' 这种文本。"""
    if not asyncpg_status:
        return 0
    parts = asyncpg_status.split()
    try:
        return int(parts[-1])
    except (ValueError, IndexError):
        return 0


class _RowDictWrapper(dict):
    """asyncpg.Record → dict-like，同时支持整数下标 row[0] / row[1]。"""

    def __init__(self, record):
        # asyncpg Record 转成 dict
        super().__init__({k: record[k] for k in record.keys()})
        self._values = list(record.values())

    def __getitem__(self, k):
        if isinstance(k, int):
            return self._values[k]
        return super().__getitem__(k)

    def keys(self):
        return super().keys()


def _wrap_row(record, row_factory):
    """根据调用方设的 row_factory 决定返回 dict / tuple。"""
    if record is None:
        return None
    # 默认 aiosqlite 默认是元组式；调用方明确设了 row_factory=aiosqlite.Row 才要 dict
    if row_factory is not None:
        return _RowDictWrapper(record)
    # 默认 tuple-like
    return tuple(record.values())


class _PGConnection:
    """模拟 aiosqlite Connection。"""

    def __init__(self):
        self._pool: Any = None
        self.row_factory = None  # 调用方可设 aiosqlite.Row 风格

    @asynccontextmanager
    async def _acquire(self) -> AsyncIterator[Any]:
        if self._pool is None:
            self._pool = await _get_pg_pool()
        async with self._pool.acquire() as raw:
            yield raw

    def execute(self, sql: str, params: Sequence[Any] = ()):
        """注意：跟 aiosqlite 一样，execute 返回 cursor 而非 coroutine。
        await execute(...) 也能工作（async __aenter__ 在 await 时触发）。"""
        return _PGCursor(self, sql, params)

    async def executescript(self, sql_script: str) -> None:
        """多语句执行：asyncpg 不支持单次 fetch 多语句，按 ; 拆分逐条翻译执行。

        必须先 split 再翻译——否则 INSERT OR IGNORE 这类需要在末尾追加
        ON CONFLICT 的语句只会处理最后一条。
        """
        # 简单 split（在引号/CTE 里有 ; 时会出问题，但 _INIT_SQL 没那种用法）
        raw_stmts = [s.strip() for s in sql_script.split(";") if s.strip()]
        async with self._acquire() as raw:
            for raw_stmt in raw_stmts:
                s = _translate_sql_for_pg(raw_stmt)
                if not s.strip():
                    continue
                try:
                    await raw.execute(s)
                except Exception as e:
                    # 让边角语法兼容失败可见，但不中断（IF NOT EXISTS 已避免大部分）
                    import logging
                    logging.getLogger(__name__).warning(
                        f"[db.executescript] stmt failed: {e!s}: {s[:80]}"
                    )

    async def commit(self) -> None:
        # asyncpg 默认 autocommit；连接池的连接每次 acquire 都是 fresh
        # 不需要显式 commit
        return None

    async def close(self) -> None:
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()


# ── 统一入口：connect(path) 返回兼容 aiosqlite 的连接 ────────────────────

def connect(path: str | os.PathLike):
    """返回一个 async context manager。用法：
        async with db.connect(path) as conn:
            ...
    """
    if _driver() == "pg":
        return _PGConnection()
    # SQLite 路径：直接转发 aiosqlite，连 row_factory 等行为都原生
    return aiosqlite.connect(path)


# 暴露 aiosqlite.Row 兼容标识（方便 monitor_db 设置 row_factory）
Row = aiosqlite.Row
