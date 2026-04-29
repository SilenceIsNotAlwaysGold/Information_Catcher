"""
把线上历史业务数据归属到测试用户 yqmm（元气满满）。

设计：
- 先调用 monitor_db.init_db() 跑完所有 schema 迁移（建 users 表、加 user_id 列、
  把历史业务数据填 user_id=1、改 note_id 复合唯一、改 xsec_source=app_share 等）
- 确认 admin 账号存在（不存在就建一个 admin/admin123，作为平台超管）
- 创建 yqmm 用户：
    username = yqmm
    email    = yqmm@yuanqi.com
    password = Yqmm@2026
    role     = user
    plan     = team   (不限试用)
- 把以下表里属于"业务数据"的、user_id=1 的行 reassign 给 yqmm：
    monitor_posts   monitor_alerts   monitor_groups (非 builtin)
    monitor_accounts (is_shared=0 的)   rewrite_prompts (非默认)
- 全局资源保持不动：
    is_shared=1 的账号        → 留在共享池
    is_builtin=1 的分组        → 全平台共享
    is_default=1 的 prompt    → 全平台共享

幂等：脚本可重复执行；yqmm 已存在不会重建。
"""
import asyncio
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.services import monitor_db, auth_service

YQMM_USERNAME = "yqmm"
YQMM_EMAIL    = "yqmm@yuanqi.com"
YQMM_PASSWORD = "Yqmm@2026"


def _get_user_id(conn: sqlite3.Connection, username: str):
    row = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()
    return row[0] if row else None


async def main():
    monitor_db_path = monitor_db.DB_PATH
    users_db_path = auth_service.DB_PATH
    print(f"[reassign] monitor DB = {monitor_db_path}")
    print(f"[reassign] users   DB = {users_db_path}")

    # 1) 跑所有 schema 迁移
    auth_service.init_user_db()         # 建 users 表（users.db）
    await monitor_db.init_db()          # 加 user_id 列、改 source、复合 UNIQUE（monitor.db）
    print("[reassign] schema 迁移完成")

    def _find(username):
        with sqlite3.connect(users_db_path) as conn:
            row = conn.execute(
                "SELECT id, username, COALESCE(email,'') as email, "
                "COALESCE(role,'user') as role, COALESCE(plan,'') as plan "
                "FROM users WHERE username=?", (username,)
            ).fetchone()
        if not row:
            return None
        return dict(zip(["id","username","email","role","plan"], row))

    # 2) 确保 admin 账号
    admin = _find("admin")
    if not admin:
        print("[reassign] 建 admin/admin123（平台超管）")
        auth_service.register_user("admin@local", "admin123", username="admin")
        with sqlite3.connect(users_db_path) as conn:
            conn.execute("UPDATE users SET role='admin', plan='team', trial_ends_at=NULL WHERE username='admin'")
            conn.commit()
        admin = _find("admin")
    else:
        with sqlite3.connect(users_db_path) as conn:
            conn.execute("UPDATE users SET role='admin' WHERE username='admin' AND (role IS NULL OR role!='admin')")
            conn.commit()
        admin = _find("admin")
    print(f"[reassign] admin id={admin['id']} role={admin['role']}")

    # 3) 建 yqmm（幂等）
    yq = _find(YQMM_USERNAME)
    if not yq:
        print(f"[reassign] 建 {YQMM_USERNAME} / {YQMM_PASSWORD}")
        auth_service.register_user(YQMM_EMAIL, YQMM_PASSWORD, username=YQMM_USERNAME)
        with sqlite3.connect(users_db_path) as conn:
            conn.execute(
                "UPDATE users SET plan='team', trial_ends_at=NULL WHERE username=?",
                (YQMM_USERNAME,),
            )
            conn.commit()
        yq = _find(YQMM_USERNAME)
    else:
        print(f"[reassign] {YQMM_USERNAME} 已存在，跳过创建")
    yq_id = yq["id"]
    print(f"[reassign] yqmm id={yq_id}")

    # 4) Reassign 业务数据：user_id=1 (admin 持有的历史数据) → yqmm
    with sqlite3.connect(monitor_db_path) as conn:
        cur = conn.cursor()

        # monitor_posts: 全部 user_id=1 的迁过去
        n_posts = cur.execute(
            "UPDATE monitor_posts SET user_id=? WHERE user_id=1",
            (yq_id,),
        ).rowcount

        # monitor_alerts: 全部 user_id=1 的迁过去
        n_alerts = cur.execute(
            "UPDATE monitor_alerts SET user_id=? WHERE user_id=1",
            (yq_id,),
        ).rowcount

        # monitor_groups: 仅非 builtin 的迁；内置「我的帖子/观测帖子」保持 NULL（全局共享）
        n_groups = cur.execute(
            "UPDATE monitor_groups SET user_id=? "
            "WHERE COALESCE(user_id, 0) IN (0, 1) AND COALESCE(is_builtin, 0) = 0",
            (yq_id,),
        ).rowcount
        # 把内置组的 user_id 强制设为 NULL，确保所有用户都看得到
        cur.execute(
            "UPDATE monitor_groups SET user_id=NULL WHERE COALESCE(is_builtin, 0) = 1"
        )

        # rewrite_prompts: 仅非默认的迁；默认 prompt 保持 NULL
        n_prompts = cur.execute(
            "UPDATE rewrite_prompts SET user_id=? "
            "WHERE COALESCE(user_id, 0) IN (0, 1) AND COALESCE(is_default, 0) = 0",
            (yq_id,),
        ).rowcount
        cur.execute(
            "UPDATE rewrite_prompts SET user_id=NULL WHERE COALESCE(is_default, 0) = 1"
        )

        # monitor_accounts: 仅非共享的迁过去；is_shared=1 的留在共享池（user_id=NULL）
        n_accounts = cur.execute(
            "UPDATE monitor_accounts SET user_id=? "
            "WHERE user_id=1 AND COALESCE(is_shared, 0) = 0",
            (yq_id,),
        ).rowcount
        # 共享账号的 user_id 强制 NULL
        cur.execute(
            "UPDATE monitor_accounts SET user_id=NULL WHERE COALESCE(is_shared, 0) = 1"
        )

        conn.commit()

        print(f"[reassign] 监控帖子 reassigned: {n_posts}")
        print(f"[reassign] 告警 reassigned:    {n_alerts}")
        print(f"[reassign] 自建分组 reassigned: {n_groups} (内置组保持全局)")
        print(f"[reassign] 自建 prompt reassigned: {n_prompts} (默认 prompt 保持全局)")
        print(f"[reassign] 非共享账号 reassigned: {n_accounts} (共享账号保持全局)")

        # 5) 概况
        print("\n[reassign] === 最终归属分布 ===")
        for tbl, where in [
            ("monitor_posts", "is_active=1"),
            ("monitor_alerts", "1=1"),
            ("monitor_groups", "1=1"),
            ("rewrite_prompts", "1=1"),
            ("monitor_accounts", "is_active=1"),
        ]:
            rows = cur.execute(
                f"SELECT COALESCE(user_id, 0), COUNT(*) FROM {tbl} WHERE {where} GROUP BY user_id"
            ).fetchall()
            print(f"  {tbl}: {dict(rows)}")

    print("\n[reassign] === 用户 ===")
    with sqlite3.connect(users_db_path) as conn:
        for r in conn.execute("SELECT id, username, email, role, plan FROM users"):
            print(f"  {r}")

    print("\n[reassign] ✅ 完成")
    print(f"[reassign] 测试用户 → {YQMM_USERNAME} / {YQMM_PASSWORD}")
    print(f"[reassign] 平台超管 → admin / admin123")


if __name__ == "__main__":
    asyncio.run(main())
