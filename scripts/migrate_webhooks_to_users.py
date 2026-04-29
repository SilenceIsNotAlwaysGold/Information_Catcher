"""
把 monitor_settings 里全局的 feishu_webhook_url / webhook_url 迁到对应用户的 users 表字段。

策略：
  - 业务数据已经在前一次 reassign 里全部归到了 yqmm，因此全局 webhook 也搬到 yqmm
  - 同时清空 monitor_settings 里这两个 key（避免混淆）
  - 幂等：再跑也不会重复或丢数据

用法：
  uv run python scripts/migrate_webhooks_to_users.py
"""
import asyncio
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.services import monitor_db, auth_service


TARGET_USERNAME = "yqmm"  # 业务数据归属人，把全局 webhook 也给他


async def main():
    auth_service.init_user_db()       # 确保 users 表有新字段
    await monitor_db.init_db()
    print("[migrate] schema 迁移完成")

    # 拿全局 webhook
    settings = await monitor_db.get_all_settings()
    g_feishu = (settings.get("feishu_webhook_url") or "").strip()
    g_wecom  = (settings.get("webhook_url") or "").strip()
    print(f"[migrate] 全局 feishu_webhook_url = {g_feishu[:60]}...")
    print(f"[migrate] 全局 webhook_url        = {g_wecom[:60]}...")

    # 拿目标用户
    with sqlite3.connect(auth_service.DB_PATH) as conn:
        row = conn.execute(
            "SELECT id, COALESCE(feishu_webhook_url,''), COALESCE(wecom_webhook_url,'') "
            "FROM users WHERE username=?", (TARGET_USERNAME,),
        ).fetchone()
    if not row:
        print(f"[migrate] 用户 {TARGET_USERNAME} 不存在，先跑 reassign_to_yqmm.py")
        return
    uid, cur_feishu, cur_wecom = row

    # 只在用户当前没设的时候才覆盖（保护已经手动设过的值）
    set_kwargs = {}
    if not cur_feishu and g_feishu:
        set_kwargs["feishu_webhook_url"] = g_feishu
    if not cur_wecom and g_wecom:
        set_kwargs["wecom_webhook_url"] = g_wecom

    if set_kwargs:
        auth_service.update_user_webhooks(uid, **set_kwargs)
        print(f"[migrate] 已写入 user#{uid} ({TARGET_USERNAME}): {list(set_kwargs.keys())}")
    else:
        print(f"[migrate] user#{uid} ({TARGET_USERNAME}) 已有自己的 webhook，不覆盖")

    # 清空全局值（防止以后又被读到）
    if g_feishu or g_wecom:
        with sqlite3.connect(monitor_db.DB_PATH) as conn:
            conn.execute("UPDATE monitor_settings SET value='' WHERE key='feishu_webhook_url'")
            conn.execute("UPDATE monitor_settings SET value='' WHERE key='webhook_url'")
            conn.commit()
        print("[migrate] 清空 monitor_settings 里的全局 webhook 值")

    print("[migrate] ✅ 完成")


if __name__ == "__main__":
    asyncio.run(main())
