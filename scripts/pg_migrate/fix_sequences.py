#!/usr/bin/env python3
"""把 PG 里所有 BIGSERIAL/id 序列同步到 max(id)+1。

为什么需要：dump_sqlite.py 生成的 INSERT 显式指定了 id 值，绕过了
PG 序列，导致 nextval() 仍停留在 1。任何新 INSERT 都会撞主键冲突。

用法（在 PG 服务器上跑）：
    cd /opt/redbook
    PULSE_PG_HOST=127.0.0.1 PULSE_PG_USER=redbook \\
    PULSE_PG_PASS=redbook_pulse_2026 PULSE_PG_DB=redbook \\
    .venv/bin/python -m scripts.pg_migrate.fix_sequences

幂等：可任意次重跑，结果一致（每次都按当前 max(id) 重设）。
"""
import asyncio
import os
import sys

import asyncpg


async def main():
    dsn = (
        f"postgresql://{os.environ.get('PULSE_PG_USER', 'redbook')}:"
        f"{os.environ.get('PULSE_PG_PASS', 'redbook_pulse_2026')}"
        f"@{os.environ.get('PULSE_PG_HOST', '127.0.0.1')}:"
        f"{os.environ.get('PULSE_PG_PORT', '5432')}/"
        f"{os.environ.get('PULSE_PG_DB', 'redbook')}"
    )
    conn = await asyncpg.connect(dsn=dsn)
    try:
        # 找出所有有 id 列且 id 列绑了序列的 public 表
        rows = await conn.fetch("""
            SELECT t.table_name
            FROM information_schema.tables t
            JOIN information_schema.columns c
              ON c.table_name = t.table_name AND c.table_schema = t.table_schema
            WHERE t.table_schema='public'
              AND t.table_type='BASE TABLE'
              AND c.column_name='id'
              AND c.column_default LIKE 'nextval%'
            ORDER BY t.table_name
        """)
        if not rows:
            print("没找到任何带 id 序列的表（可能 schema 还没建）", file=sys.stderr)
            return 1

        print(f"准备同步 {len(rows)} 张表的 id 序列：\n")
        fixed = 0
        for r in rows:
            t = r["table_name"]
            seq = await conn.fetchval(
                "SELECT pg_get_serial_sequence($1, 'id')", t,
            )
            if not seq:
                print(f"  - {t:<28} (跳过：序列查不到)")
                continue
            max_id = await conn.fetchval(f"SELECT COALESCE(MAX(id), 0) FROM {t}")
            new_val = max_id + 1
            # setval(seq, value, false) 表示下一次 nextval 直接返回 value
            await conn.execute(
                "SELECT setval($1, $2, false)", seq, new_val,
            )
            print(f"  ✓ {t:<28} max(id)={max_id:>6} → next={new_val}")
            fixed += 1

        print(f"\n完成：{fixed}/{len(rows)} 张表序列已同步。")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
