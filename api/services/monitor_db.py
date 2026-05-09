import aiosqlite
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict

DB_PATH = Path(__file__).parent.parent.parent / "database" / "monitor.db"

_INIT_SQL = """
CREATE TABLE IF NOT EXISTS monitor_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cookie TEXT NOT NULL,
    proxy_url TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    viewport TEXT DEFAULT '',
    timezone TEXT DEFAULT 'Asia/Shanghai',
    locale TEXT DEFAULT 'zh-CN',
    fp_browser_type TEXT DEFAULT 'builtin',
    fp_profile_id TEXT DEFAULT '',
    fp_api_url TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS monitor_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL UNIQUE,
    title TEXT,
    short_url TEXT,
    note_url TEXT,
    xsec_token TEXT,
    xsec_source TEXT DEFAULT 'app_share',
    account_id INTEGER REFERENCES monitor_accounts(id),
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS monitor_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    liked_count INTEGER DEFAULT 0,
    collected_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    share_count INTEGER DEFAULT 0,
    checked_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS monitor_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    title TEXT,
    alert_type TEXT NOT NULL,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS monitor_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

INSERT OR IGNORE INTO monitor_settings VALUES ('webhook_url', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_webhook_url', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('check_interval_minutes', '30');
INSERT OR IGNORE INTO monitor_settings VALUES ('daily_report_enabled', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('daily_report_time', '09:00');
INSERT OR IGNORE INTO monitor_settings VALUES ('likes_alert_enabled', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('likes_threshold', '50');
INSERT OR IGNORE INTO monitor_settings VALUES ('collects_alert_enabled', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('collects_threshold', '50');
INSERT OR IGNORE INTO monitor_settings VALUES ('comments_alert_enabled', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('comments_threshold', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('ai_base_url', 'https://api.openai.com/v1');
INSERT OR IGNORE INTO monitor_settings VALUES ('ai_api_key', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('ai_model', 'gpt-4o-mini');
INSERT OR IGNORE INTO monitor_settings VALUES ('ai_rewrite_enabled', '0');
INSERT OR IGNORE INTO monitor_settings VALUES ('ai_rewrite_prompt', '你是小红书爆款文案创作者，请将以下内容改写为更吸引人的小红书风格文案，保持原意但语气更活泼、更有共鸣感，适当加入emoji。原文：\n\n{content}');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_app_id', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_app_secret', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_bitable_app_token', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_bitable_table_id', '');
-- 商品图历史专用的飞书表（同 app_token，不同 table_id；与热门帖表分开）
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_bitable_image_table_id', '');
-- 飞书 OAuth 自动绑定 + 用户级多维表格：
--   feishu_oauth_redirect_uri        OAuth 回调地址（如 https://你的域名/api/feishu/oauth/callback）
--   feishu_bitable_root_folder_token 用户表格统一建在该云空间文件夹下
--   feishu_admin_open_id             admin 的飞书 open_id（用于把 admin 拉进所有用户的群）
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_oauth_redirect_uri', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_bitable_root_folder_token', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_admin_open_id', '');
-- 飞书企业邀请链接：自建应用只允许应用所属企业的成员授权，外部用户需先扫码
-- 加入企业。admin 在飞书后台 → 通讯录管理 → 邀请成员 复制长效邀请链接到这里。
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_invite_url', '');
-- 飞书 8 位企业邀请码：扫码后飞书 App 有时会跳转到「输入企业邀请码」页面，
-- 需要用户手动输入这 8 位字母码。前端在二维码下方展示并提供一键复制。
INSERT OR IGNORE INTO monitor_settings VALUES ('feishu_invite_code', '');
-- 七牛云对象存储：用于商品图上传，得到公网 URL 后才能往飞书写
INSERT OR IGNORE INTO monitor_settings VALUES ('qiniu_access_key', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('qiniu_secret_key', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('qiniu_bucket', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('qiniu_domain', '');
-- 本地图片存储的公网访问前缀（七牛备选方案）
-- 例：https://my-server.com:8003 — 配置后图片会写到 data/images/，
-- 通过 FastAPI 静态目录暴露成 {prefix}/static/images/...
INSERT OR IGNORE INTO monitor_settings VALUES ('public_url_prefix', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_enabled', '0');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_keywords', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_min_likes', '1000');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_enrich_desc', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_enrich_concurrency', '3');
-- Deprecated 2026-04: 观测帖子改为永远走匿名（app_share 通道），无需 cookie 兜底。
-- 留 key 不删避免 SELECT 报错；新部署不会再读它。
INSERT OR IGNORE INTO monitor_settings VALUES ('observe_use_cookie_fallback', '0');
-- 第三方数据源（公众号 SaaS 集成）：填好后 mp 抓取自动走第三方 API 拿阅读数等
INSERT OR IGNORE INTO monitor_settings VALUES ('newrank_api_key', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('newrank_api_base', 'https://api.newrank.cn');

CREATE TABLE IF NOT EXISTS trending_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL UNIQUE,
    title TEXT,
    desc_text TEXT,
    note_url TEXT,
    xsec_token TEXT DEFAULT '',
    liked_count INTEGER DEFAULT 0,
    collected_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    keyword TEXT,
    author TEXT,
    rewritten_text TEXT,
    rewrite_status TEXT DEFAULT 'pending',
    found_at TEXT DEFAULT (datetime('now', 'localtime')),
    synced_to_bitable INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS own_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL UNIQUE,
    note_id TEXT,
    note_title TEXT,
    commenter_name TEXT,
    commenter_id TEXT,
    content TEXT,
    account_id INTEGER,
    notified INTEGER DEFAULT 0,
    create_time INTEGER DEFAULT 0,
    found_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS own_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    account_id INTEGER,
    sender_name TEXT,
    sender_id TEXT,
    last_message TEXT,
    unread_count INTEGER DEFAULT 0,
    create_time INTEGER DEFAULT 0,
    notified INTEGER DEFAULT 0,
    found_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS note_comments_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    comment_id TEXT NOT NULL UNIQUE,
    content TEXT,
    user_name TEXT,
    user_id TEXT,
    liked_count INTEGER DEFAULT 0,
    create_time INTEGER DEFAULT 0,
    found_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 创作者中心快照：用户授权自家账号后定期拉的运营数据
-- 一个 (account_id, date) 一行；raw_json 留所有原始字段供前端二次展开
CREATE TABLE IF NOT EXISTS creator_stats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER,
    account_id    INTEGER,
    platform      TEXT NOT NULL DEFAULT 'xhs',
    snapshot_date TEXT NOT NULL,        -- YYYY-MM-DD
    fans_count    INTEGER DEFAULT 0,
    fans_delta    INTEGER DEFAULT 0,    -- vs 昨天
    notes_count   INTEGER DEFAULT 0,
    total_views   INTEGER DEFAULT 0,    -- 累计阅读
    total_likes   INTEGER DEFAULT 0,
    total_collects INTEGER DEFAULT 0,
    total_comments INTEGER DEFAULT 0,
    daily_views   INTEGER DEFAULT 0,    -- 当日阅读
    daily_likes   INTEGER DEFAULT 0,
    daily_collects INTEGER DEFAULT 0,
    daily_comments INTEGER DEFAULT 0,
    raw_json      TEXT DEFAULT '',
    fetched_at    TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creator_stats_day
    ON creator_stats(account_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_creator_stats_user_date
    ON creator_stats(user_id, snapshot_date DESC);

-- 媒体归档：爆款笔记的原图/视频/livePhoto 备份
-- 一条 note 可对应多条记录（每张图、视频、livePhoto 单独一行）
CREATE TABLE IF NOT EXISTS media_archive (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    platform     TEXT NOT NULL DEFAULT 'xhs',
    note_id      TEXT NOT NULL,
    note_url     TEXT DEFAULT '',
    note_title   TEXT DEFAULT '',
    author       TEXT DEFAULT '',
    kind         TEXT NOT NULL,    -- cover | image | video | live_photo
    src_url      TEXT NOT NULL,    -- 原始 CDN URL
    storage_url  TEXT DEFAULT '',  -- S3 / 七牛 公网 URL（成功才有）
    storage_backend TEXT DEFAULT '',  -- s3 | qiniu | local
    sha256       TEXT DEFAULT '',
    size_bytes   INTEGER DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    fail_count   INTEGER DEFAULT 0,
    last_error   TEXT DEFAULT '',
    archived_at  TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_media_archive_note ON media_archive(note_id);
CREATE INDEX IF NOT EXISTS idx_media_archive_user ON media_archive(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_archive_src ON media_archive(note_id, src_url);

-- 通用断点续爬游标表
-- task: 任务名（如 'trending', 'creator'）；key: 业务主键（如 'uid:keyword'、'creator:123'）
-- 调度任务按 last_run_at 升序遍历自己的 keys，自然实现"上次没跑完优先续上"。
CREATE TABLE IF NOT EXISTS crawl_cursor (
    task        TEXT NOT NULL,
    key         TEXT NOT NULL,
    cursor      TEXT DEFAULT '',
    status      TEXT DEFAULT 'idle',   -- idle | running | done | failed
    fail_count  INTEGER DEFAULT 0,
    last_run_at TEXT DEFAULT '',
    last_error  TEXT DEFAULT '',
    PRIMARY KEY (task, key)
);

CREATE TABLE IF NOT EXISTS rewrite_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS monitor_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    -- 推送渠道：留空时用全局 settings
    feishu_webhook_url TEXT DEFAULT '',
    wecom_webhook_url TEXT DEFAULT '',
    -- 告警阈值开关 + 阈值（NULL 表示沿用全局 settings）
    likes_alert_enabled INTEGER,
    likes_threshold INTEGER,
    collects_alert_enabled INTEGER,
    collects_threshold INTEGER,
    comments_alert_enabled INTEGER,
    comments_threshold INTEGER,
    -- 推送内容：前缀拼在消息开头；template_* 留空时用内置默认文案
    message_prefix TEXT DEFAULT '',
    template_likes TEXT DEFAULT '',
    template_collects TEXT DEFAULT '',
    template_comments TEXT DEFAULT '',
    -- 内置分组（我的帖子/观测帖子）不能删除
    is_builtin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

INSERT OR IGNORE INTO monitor_settings VALUES ('self_monitor_enabled', '0');
INSERT OR IGNORE INTO monitor_settings VALUES ('self_monitor_account_id', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('self_monitor_account_ids', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_account_ids', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('own_comments_enabled', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('own_messages_enabled', '1');
INSERT OR IGNORE INTO monitor_settings VALUES ('comments_fetch_enabled', '0');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_feishu_webhook_enabled', '1');

CREATE INDEX IF NOT EXISTS idx_snap_note ON monitor_snapshots(note_id);
CREATE INDEX IF NOT EXISTS idx_snap_time ON monitor_snapshots(checked_at);
CREATE INDEX IF NOT EXISTS idx_alert_time ON monitor_alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_trending_found ON trending_posts(found_at);
CREATE INDEX IF NOT EXISTS idx_own_comments_found ON own_comments(found_at);
CREATE INDEX IF NOT EXISTS idx_own_msg_found ON own_messages(found_at);
CREATE INDEX IF NOT EXISTS idx_note_comments ON note_comments_cache(note_id);

CREATE TABLE IF NOT EXISTS monitor_creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    platform TEXT NOT NULL,             -- xhs / douyin / mp
    creator_url TEXT NOT NULL,
    creator_name TEXT DEFAULT '',
    creator_id TEXT DEFAULT '',         -- 平台 sec_uid / user_id / biz
    last_check_at TEXT,
    last_post_id TEXT DEFAULT '',       -- 上次见到的最新帖子，用于增量检测
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(user_id, platform, creator_url)
);
CREATE INDEX IF NOT EXISTS idx_creator_user ON monitor_creators(user_id);
CREATE INDEX IF NOT EXISTS idx_creator_active ON monitor_creators(is_active, platform);

CREATE TABLE IF NOT EXISTS monitor_lives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    platform TEXT NOT NULL DEFAULT 'douyin',
    room_url TEXT NOT NULL,             -- https://live.douyin.com/{room_id}
    room_id TEXT DEFAULT '',
    streamer_name TEXT DEFAULT '',
    last_online INTEGER DEFAULT 0,      -- 上次抓到的在线人数
    last_gifts TEXT DEFAULT '',         -- 礼物榜 JSON 快照
    last_check_at TEXT,
    online_alert_threshold INTEGER DEFAULT 0,  -- 在线人数涨幅触发阈值
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(user_id, platform, room_url)
);
CREATE INDEX IF NOT EXISTS idx_lives_user ON monitor_lives(user_id);
CREATE INDEX IF NOT EXISTS idx_lives_active ON monitor_lives(is_active, platform);

CREATE TABLE IF NOT EXISTS fetch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,             -- xhs / douyin / mp
    task_type TEXT NOT NULL,            -- monitor / trending / enrich / comment
    account_id INTEGER,                 -- NULL = anonymous fetch
    status TEXT NOT NULL,               -- ok / error / login_required / deleted
    latency_ms INTEGER DEFAULT 0,
    note_id TEXT,
    note TEXT,                          -- 备注（错误信息/keyword 等）
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fetch_log_time ON fetch_log(created_at);
CREATE INDEX IF NOT EXISTS idx_fetch_log_account ON fetch_log(account_id);
CREATE INDEX IF NOT EXISTS idx_fetch_log_platform ON fetch_log(platform);
CREATE INDEX IF NOT EXISTS idx_fetch_log_note_id ON fetch_log(note_id);

-- 商品图工具历史记录：每生成一张图就一行。
-- 异步上传策略：生成时先写本地（local_url 永远有值），如配了七牛则后台 worker
-- 异步推到云端，成功后更新 qiniu_url 覆盖本地 URL。upload_status 跟踪状态。
-- 用 set_idx + in_set_idx 标记套图维度，方便后续按套号筛选/导出。
CREATE TABLE IF NOT EXISTS image_gen_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    prompt TEXT,
    negative_prompt TEXT DEFAULT '',
    size TEXT DEFAULT '',
    model TEXT DEFAULT '',
    set_idx INTEGER DEFAULT 1,
    in_set_idx INTEGER DEFAULT 1,
    -- URL 双字段：local_url 永远是本地静态 URL（兜底），qiniu_url 是当前对外用的 URL
    -- 起初 qiniu_url = local_url；上传到七牛成功后 qiniu_url 被替换为 CDN URL
    local_url TEXT DEFAULT '',
    qiniu_url TEXT DEFAULT '',
    qiniu_key TEXT DEFAULT '',
    -- pending（待上传）/ uploaded（已上传七牛）/ failed（重试用尽）/ skipped（七牛未配）
    upload_status TEXT DEFAULT 'skipped',
    upload_retries INTEGER DEFAULT 0,
    upload_last_error TEXT DEFAULT '',
    -- AI 配套文案：勾选「同时生成文案」时 AI 基于 prompt 生成的标题 + 正文，
    -- 同一批次（同一次 /generate 调用）的所有图共用一份文案
    generated_title TEXT DEFAULT '',
    generated_body TEXT DEFAULT '',
    -- batch_id: 同一次 handleGenerate 操作的所有图共享一个 uuid（前端生成）
    -- 用于历史 UI 按 (batch_id, set_idx) 聚合分组 + 飞书同步按套合并成一行
    batch_id TEXT DEFAULT '',
    source_post_url TEXT DEFAULT '',
    source_post_title TEXT DEFAULT '',
    used_reference INTEGER DEFAULT 0,
    synced_to_bitable INTEGER DEFAULT 0,
    bitable_record_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_image_gen_user_time ON image_gen_history(user_id, created_at DESC);
-- 无 partial index：image_gen_history 数据量小，list_pending_image_uploads
-- 每次 LIMIT 5 全表扫足够。partial index 在老表上还没 upload_status 列时
-- 会建索引失败，复杂度不值得。

-- 仿写任务：粘贴小红书/抖音作品 → 异步生成 N 套（图 + 文案）
-- worker 跑 pending 任务，每完成一套写一行 image_gen_history（batch_id="remix:{task_id}"）
-- items_json：实时进度展示用，[{idx, image_url, title, body, error}, ...]
CREATE TABLE IF NOT EXISTS remix_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    -- pending（队列中）/ running（处理中）/ done（完成）/ error（失败）/ cancelled
    status TEXT DEFAULT 'pending',
    post_url TEXT DEFAULT '',
    post_title TEXT DEFAULT '',
    post_desc TEXT DEFAULT '',
    platform TEXT DEFAULT 'xhs',
    ref_image_url TEXT DEFAULT '',
    ref_image_idx INTEGER DEFAULT 0,
    count INTEGER DEFAULT 1,
    done_count INTEGER DEFAULT 0,
    items_json TEXT DEFAULT '[]',
    error TEXT DEFAULT '',
    size TEXT DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_remix_tasks_user_time ON remix_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_remix_tasks_status ON remix_tasks(status);

-- 每日用量计数：跨天自动清零（不存当天的零行）
-- 每用户 + 每天一行，关键端点 record_usage 时累加
CREATE TABLE IF NOT EXISTS daily_usage (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    image_gen_count INTEGER DEFAULT 0,
    remix_sets_count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, date)
);

-- 邀请码：admin 生成，注册时消费
CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by INTEGER,
    plan TEXT DEFAULT 'trial',
    max_uses INTEGER DEFAULT 1,
    used_count INTEGER DEFAULT 0,
    expires_at TEXT,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 操作审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_username TEXT DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT DEFAULT '',
    target_id TEXT DEFAULT '',
    metadata TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
"""


# Columns we expect on existing deployments; added lazily.
_ACCOUNT_EXTRA_COLUMNS: List[tuple] = [
    ("proxy_url",         "TEXT DEFAULT ''"),
    ("user_agent",        "TEXT DEFAULT ''"),
    ("viewport",          "TEXT DEFAULT ''"),
    ("timezone",          "TEXT DEFAULT 'Asia/Shanghai'"),
    ("locale",            "TEXT DEFAULT 'zh-CN'"),
    ("fp_browser_type",   "TEXT DEFAULT 'builtin'"),
    ("fp_profile_id",     "TEXT DEFAULT ''"),
    ("fp_api_url",        "TEXT DEFAULT ''"),
    ("cookie_status",     "TEXT DEFAULT 'unknown'"),  # valid | expired | unknown
    ("cookie_checked_at", "TEXT"),
    # SaaS 共享池：admin 标记 is_shared=1 的账号会进入平台共享池，
    # 用于热门搜索和观测帖子（用户不消耗自己账号）。
    ("is_shared",         "INTEGER DEFAULT 0"),
    ("last_used_at",      "TEXT"),
    ("usage_count",       "INTEGER DEFAULT 0"),
    # 平台标识：xhs / douyin / mp。老数据补 xhs（migrate 里处理）
    ("platform",          "TEXT NOT NULL DEFAULT 'xhs'"),
]


async def _table_columns(db, table: str) -> List[str]:
    async with db.execute(f"PRAGMA table_info({table})") as cur:
        return [row[1] for row in await cur.fetchall()]


async def _ensure_column(db, table: str, name: str, coldef: str):
    cols = await _table_columns(db, table)
    if name not in cols:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {coldef}")


async def _ensure_fts_index(db):
    """创建 FTS5 全文索引 + 触发器同步 monitor_posts.title / summary。

    用 external content 模式（content='monitor_posts'），列名必须都存在于主表。
    所以仅索引 title + summary（已有的列）。
    """
    # 检查现有 FTS 表 schema 是否最新（早期 body 列 / unicode61 tokenizer）
    try:
        cur = await db.execute("SELECT sql FROM sqlite_master WHERE name='monitor_posts_fts'")
        row = await cur.fetchone()
        if row and row[0]:
            sqltext = row[0] or ""
            need_rebuild = ("body" in sqltext) or ("trigram" not in sqltext)
            if need_rebuild:
                await db.executescript("""
                    DROP TRIGGER IF EXISTS monitor_posts_ai;
                    DROP TRIGGER IF EXISTS monitor_posts_ad;
                    DROP TRIGGER IF EXISTS monitor_posts_au;
                    DROP TABLE IF EXISTS monitor_posts_fts;
                """)
    except Exception:
        pass

    # trigram tokenizer：3 字符 ngram，对中文友好（SQLite 3.34+）
    await db.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS monitor_posts_fts USING fts5(
            title, summary,
            content='monitor_posts',
            content_rowid='id',
            tokenize='trigram'
        )
    """)
    await db.executescript("""
        CREATE TRIGGER IF NOT EXISTS monitor_posts_ai AFTER INSERT ON monitor_posts BEGIN
            INSERT INTO monitor_posts_fts(rowid, title, summary)
            VALUES (new.id, COALESCE(new.title,''), COALESCE(new.summary,''));
        END;
        CREATE TRIGGER IF NOT EXISTS monitor_posts_ad AFTER DELETE ON monitor_posts BEGIN
            INSERT INTO monitor_posts_fts(monitor_posts_fts, rowid, title, summary)
            VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.summary,''));
        END;
        CREATE TRIGGER IF NOT EXISTS monitor_posts_au AFTER UPDATE ON monitor_posts BEGIN
            INSERT INTO monitor_posts_fts(monitor_posts_fts, rowid, title, summary)
            VALUES ('delete', old.id, COALESCE(old.title,''), COALESCE(old.summary,''));
            INSERT INTO monitor_posts_fts(rowid, title, summary)
            VALUES (new.id, COALESCE(new.title,''), COALESCE(new.summary,''));
        END;
    """)
    # 首次启用时把已有数据灌入
    cur = await db.execute("SELECT COUNT(*) FROM monitor_posts_fts")
    (n,) = await cur.fetchone()
    if n == 0:
        await db.execute("""
            INSERT INTO monitor_posts_fts(rowid, title, summary)
            SELECT id, COALESCE(title,''), COALESCE(summary,'')
            FROM monitor_posts
        """)


async def _migrate_monitor_posts_unique(db):
    """把 monitor_posts.note_id 全局 UNIQUE 改成 (note_id, user_id) 复合 UNIQUE。

    SQLite 不能原地修改列级 UNIQUE 约束，所以重建表（仅当尚未迁移时执行）。
    依据 sqlite_master 的 SQL 字符串里是否还含 'note_id TEXT NOT NULL UNIQUE' 来识别。
    """
    row = await (await db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='monitor_posts'"
    )).fetchone()
    if not row:
        return
    sql_text = (row[0] or "")
    if "note_id TEXT NOT NULL UNIQUE" not in sql_text:
        # 已经是新结构，跳过
        return
    # 取出旧列清单（迁移期间老部署可能比新表多/少几列，这里按 PRAGMA 拿当前实际列）
    cols = await _table_columns(db, "monitor_posts")
    cols_csv = ", ".join(cols)
    await db.executescript(f"""
        DROP TABLE IF EXISTS monitor_posts_new;
        CREATE TABLE monitor_posts_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            title TEXT,
            short_url TEXT,
            note_url TEXT,
            xsec_token TEXT,
            xsec_source TEXT DEFAULT 'app_share',
            account_id INTEGER REFERENCES monitor_accounts(id),
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            post_type TEXT DEFAULT 'observe',
            last_fetch_status TEXT DEFAULT 'unknown',
            last_fetch_at TEXT,
            fail_count INTEGER DEFAULT 0,
            group_id INTEGER,
            user_id INTEGER
        );
        INSERT INTO monitor_posts_new ({cols_csv})
        SELECT {cols_csv} FROM monitor_posts;
        DROP TABLE monitor_posts;
        ALTER TABLE monitor_posts_new RENAME TO monitor_posts;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_posts_note_user
            ON monitor_posts(note_id, COALESCE(user_id, 0));
    """)


async def _migrate_trending_posts_unique(db):
    """trending_posts.note_id 全局 UNIQUE → (note_id, user_id) 复合 UNIQUE。

    跟 monitor_posts 同款：SQLite 不能原地改列级 UNIQUE，重建一次。
    """
    row = await (await db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='trending_posts'"
    )).fetchone()
    if not row:
        return
    sql_text = (row[0] or "")
    if "note_id TEXT NOT NULL UNIQUE" not in sql_text:
        # 已经迁移过
        return
    cols = await _table_columns(db, "trending_posts")
    cols_csv = ", ".join(cols)
    await db.executescript(f"""
        DROP TABLE IF EXISTS trending_posts_new;
        CREATE TABLE trending_posts_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            title TEXT,
            desc_text TEXT,
            note_url TEXT,
            xsec_token TEXT DEFAULT '',
            liked_count INTEGER DEFAULT 0,
            collected_count INTEGER DEFAULT 0,
            comment_count INTEGER DEFAULT 0,
            keyword TEXT,
            author TEXT,
            rewritten_text TEXT,
            rewrite_status TEXT DEFAULT 'pending',
            found_at TEXT DEFAULT (datetime('now', 'localtime')),
            synced_to_bitable INTEGER DEFAULT 0,
            cover_url TEXT DEFAULT '',
            images TEXT DEFAULT '',
            video_url TEXT DEFAULT '',
            note_type TEXT DEFAULT 'normal',
            platform TEXT NOT NULL DEFAULT 'xhs',
            user_id INTEGER
        );
        INSERT INTO trending_posts_new ({cols_csv})
        SELECT {cols_csv} FROM trending_posts;
        DROP TABLE trending_posts;
        ALTER TABLE trending_posts_new RENAME TO trending_posts;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trending_note_user
            ON trending_posts(note_id, COALESCE(user_id, 0));
        CREATE INDEX IF NOT EXISTS idx_trending_user_found
            ON trending_posts(user_id, found_at DESC);
    """)


async def _migrate_own_messages_schema(db):
    """Drop the old UNIQUE(session_id,last_message) constraint and add account_id.

    SQLite can't drop a column-level UNIQUE constraint in place, so we rebuild the
    table once when the account_id column is missing.
    """
    cols = await _table_columns(db, "own_messages")
    if "account_id" in cols:
        return
    await db.executescript("""
        DROP TABLE IF EXISTS own_messages_new;
        CREATE TABLE own_messages_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            account_id INTEGER,
            sender_name TEXT,
            sender_id TEXT,
            last_message TEXT,
            unread_count INTEGER DEFAULT 0,
            create_time INTEGER DEFAULT 0,
            notified INTEGER DEFAULT 0,
            found_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
        INSERT INTO own_messages_new
            (id, session_id, sender_name, sender_id, last_message,
             unread_count, create_time, notified, found_at)
        SELECT id, session_id, sender_name, sender_id, last_message,
               unread_count, create_time, notified, found_at
          FROM own_messages;
        DROP TABLE own_messages;
        ALTER TABLE own_messages_new RENAME TO own_messages;
    """)


async def _migrate(db):
    # monitor_accounts columns for proxy / fingerprint
    for col, coldef in _ACCOUNT_EXTRA_COLUMNS:
        await _ensure_column(db, "monitor_accounts", col, coldef)
    # Cookie health 探针：上次成功/失败检测的时间戳（ISO 字符串）。
    # 与历史的 cookie_checked_at 共存，前者只有探针在写、后者也兼容旧逻辑。
    await _ensure_column(db, "monitor_accounts", "cookie_last_check", "TEXT DEFAULT ''")
    # CookieBridge 浏览器扩展同步 cookie 的时间戳与来源
    await _ensure_column(db, "monitor_accounts", "cookie_synced_at", "TEXT DEFAULT ''")
    await _ensure_column(db, "monitor_accounts", "cookie_synced_via", "TEXT DEFAULT ''")
    # 博主追新健康度 + 未读：让列表能区分"挂了 / 卡 cookie / 有新内容"
    await _ensure_column(db, "monitor_creators", "last_check_status", "TEXT DEFAULT 'unknown'")
    await _ensure_column(db, "monitor_creators", "last_check_error",  "TEXT DEFAULT ''")
    await _ensure_column(db, "monitor_creators", "last_post_at",      "TEXT DEFAULT ''")
    await _ensure_column(db, "monitor_creators", "unread_count",      "INTEGER DEFAULT 0")
    await _ensure_column(db, "monitor_creators", "last_seen_at",      "TEXT DEFAULT ''")
    # post grouping: 'own' = my posts, 'observe' = others' posts (legacy)
    await _ensure_column(db, "monitor_posts", "post_type", "TEXT DEFAULT 'observe'")
    # Track per-post fetch outcome so the UI can flag XHS-locked / deleted notes.
    # Values: ok | login_required | deleted | error | unknown
    await _ensure_column(db, "monitor_posts", "last_fetch_status", "TEXT DEFAULT 'unknown'")
    await _ensure_column(db, "monitor_posts", "last_fetch_at", "TEXT")
    # 连续失败次数：达到阈值后由调度器自动跳过，避免持续打无效请求
    await _ensure_column(db, "monitor_posts", "fail_count", "INTEGER DEFAULT 0")
    # 平台标识：未来兼容抖音/公众号，老数据补 'xhs'
    await _ensure_column(db, "monitor_posts", "platform", "TEXT NOT NULL DEFAULT 'xhs'")
    await db.execute(
        "UPDATE monitor_posts SET platform='xhs' WHERE platform IS NULL OR platform=''"
    )
    # AI 摘要（公众号长文 / 抖音视频文案/小红书干货笔记 都能用）
    await _ensure_column(db, "monitor_posts", "summary", "TEXT DEFAULT ''")
    await _ensure_column(db, "monitor_posts", "summary_at", "TEXT")
    # 作者：公众号 nickname / 抖音/XHS 博主昵称，用于按号分组
    await _ensure_column(db, "monitor_posts", "author", "TEXT DEFAULT ''")
    # 话题/标签 JSON 数组：抖音 cha_list / desc 里的 #xxx；XHS 也可以
    await _ensure_column(db, "monitor_posts", "tags", "TEXT DEFAULT ''")
    # 公众号原创/转载/合规标识
    # copyright_stat: '11' = 原创, '100' = 转载, 其他/空 = 普通
    await _ensure_column(db, "monitor_posts", "copyright_stat", "TEXT DEFAULT ''")
    await _ensure_column(db, "monitor_posts", "source_url", "TEXT DEFAULT ''")
    # New: custom monitor groups. group_id references monitor_groups.id.
    await _ensure_column(db, "monitor_posts", "group_id", "INTEGER")
    # 告警规则 JSON：[{type, metric, threshold, ...}, ...]
    # type: delta（现有 +N 触发）/ cumulative（首次累计达到 N）/ percent（24h 涨幅 N%）
    # 留 NULL 时仍然兼容旧 likes_alert_enabled / threshold 老字段
    await _ensure_column(db, "monitor_groups", "alert_rules", "TEXT DEFAULT ''")
    # 2026-05 分组级飞书绑定：每个分组绑一个飞书群（应用机器人 chat 或外部 webhook）
    await _ensure_column(db, "monitor_groups", "feishu_chat_id", "TEXT DEFAULT ''")
    # 旧默认组（「我的帖子」「观测帖子」）已废弃，统一让用户自己建分组：
    # 1) 把仍指向 builtin 组的帖子 group_id 设为 NULL（前端「未分组」tab 兜底显示）
    # 2) DELETE is_builtin=1 的所有 monitor_groups 记录
    await db.execute(
        "UPDATE monitor_posts SET group_id=NULL "
        "WHERE group_id IN (SELECT id FROM monitor_groups WHERE is_builtin=1)"
    )
    await db.execute("DELETE FROM monitor_groups WHERE is_builtin=1")
    # 不再调 _seed_default_groups —— 用户自己建分组（POST /groups 时按 mode 自动建群）
    await _migrate_post_type_to_group(db)
    # Trending posts: media URLs (cover / images JSON / video URL / type)
    await _ensure_column(db, "trending_posts", "cover_url", "TEXT DEFAULT ''")
    await _ensure_column(db, "trending_posts", "images", "TEXT DEFAULT ''")  # JSON list
    await _ensure_column(db, "trending_posts", "video_url", "TEXT DEFAULT ''")
    await _ensure_column(db, "trending_posts", "note_type", "TEXT DEFAULT 'normal'")
    await _ensure_column(db, "trending_posts", "platform", "TEXT NOT NULL DEFAULT 'xhs'")
    await db.execute(
        "UPDATE trending_posts SET platform='xhs' WHERE platform IS NULL OR platform=''"
    )
    # 2026-05 多租户：trending 改为 per-user
    # 1) 加 user_id 列；老数据全部归 admin (id=1)
    await _ensure_column(db, "trending_posts", "user_id", "INTEGER")
    await db.execute("UPDATE trending_posts SET user_id=1 WHERE user_id IS NULL")
    # 2) 把 note_id 全局 UNIQUE 改为 (note_id, user_id) 复合 UNIQUE
    await _migrate_trending_posts_unique(db)

    # 商品图历史：异步上传字段（老 deployments 上没有这些列）
    await _ensure_column(db, "image_gen_history", "local_url", "TEXT DEFAULT ''")
    await _ensure_column(db, "image_gen_history", "upload_status", "TEXT DEFAULT 'skipped'")
    await _ensure_column(db, "image_gen_history", "upload_retries", "INTEGER DEFAULT 0")
    await _ensure_column(db, "image_gen_history", "upload_last_error", "TEXT DEFAULT ''")
    await _ensure_column(db, "image_gen_history", "generated_title", "TEXT DEFAULT ''")
    await _ensure_column(db, "image_gen_history", "generated_body", "TEXT DEFAULT ''")
    await _ensure_column(db, "image_gen_history", "batch_id", "TEXT DEFAULT ''")
    # 老数据：qiniu_url 非空说明同步上传成功过，标记 uploaded；空则 skipped
    await db.execute(
        "UPDATE image_gen_history SET upload_status='uploaded' "
        "WHERE upload_status IS NULL OR upload_status='' "
        "  AND qiniu_url IS NOT NULL AND qiniu_url != ''"
    )

    # SaaS multi-tenant: each tenant-owned table gets a user_id column.
    # monitor_settings 保持全局 key-value（管理员维护：AI key、检测间隔等），
    # 用户级偏好（推送 webhook、告警阈值）通过 monitor_groups 配置。
    for tbl in (
        "monitor_posts", "monitor_groups", "monitor_accounts",
        "rewrite_prompts", "monitor_alerts",
    ):
        await _ensure_column(db, tbl, "user_id", "INTEGER")
    # 已有数据归属 admin (id=1)
    for tbl in ("monitor_posts", "monitor_accounts", "monitor_alerts"):
        await db.execute(f"UPDATE {tbl} SET user_id=1 WHERE user_id IS NULL")
    # 把 monitor_posts.note_id 的全局 UNIQUE 改为 (note_id, user_id) 复合
    await _migrate_monitor_posts_unique(db)
    # 历史 xsec_source 统一改写为 app_share：
    # 实测 search/pc_feed 来源的 token 配 app_share 也能匿名抓到详情，
    # 而 pc_feed 直接访问偶尔被风控 302。统一改写后所有观测帖子都能匿名抓。
    await db.execute(
        "UPDATE monitor_posts SET xsec_source='app_share' "
        "WHERE xsec_source IS NULL OR xsec_source != 'app_share'"
    )
    # 内置 monitor_groups 和默认 rewrite_prompts 保持 user_id=NULL（全局可见，所有用户共用）
    # 用户自建的（未来）会带 user_id
    # own_comments needs account_id
    await _ensure_column(db, "own_comments", "account_id", "INTEGER")
    # own_messages schema rebuild (adds account_id + drops old UNIQUE)
    await _migrate_own_messages_schema(db)
    # The composite unique index references account_id, so create it only after
    # the migration has added that column.
    await db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_own_msg_uniq "
        "ON own_messages(COALESCE(account_id, 0), session_id, last_message)"
    )
    # Backfill self_monitor_account_ids from legacy self_monitor_account_id if empty
    async with db.execute(
        "SELECT value FROM monitor_settings WHERE key='self_monitor_account_ids'"
    ) as cur:
        row = await cur.fetchone()
        new_val = row[0] if row else ""
    if not new_val:
        async with db.execute(
            "SELECT value FROM monitor_settings WHERE key='self_monitor_account_id'"
        ) as cur:
            row = await cur.fetchone()
            old_val = (row[0] if row else "").strip()
        if old_val:
            await db.execute(
                "INSERT OR REPLACE INTO monitor_settings VALUES ('self_monitor_account_ids', ?)",
                (old_val,),
            )
    # FTS5 全文索引：实测 trigram tokenizer 在中文+大量数据时会导致
    # external content 触发器进入 malformed 状态。禁用以避免生产事故；
    # 搜索功能已改用 LIKE 实现（search_posts），不依赖 FTS 表。
    # 如果以后接 jieba 分词后再启用。
    # await _ensure_fts_index(db)
    # 兜底清理可能残留的 fts trigger / 表
    try:
        await db.executescript("""
            DROP TRIGGER IF EXISTS monitor_posts_ai;
            DROP TRIGGER IF EXISTS monitor_posts_ad;
            DROP TRIGGER IF EXISTS monitor_posts_au;
            DROP TABLE IF EXISTS monitor_posts_fts;
        """)
    except Exception:
        pass


async def _seed_default_groups(db):
    """Make sure '我的帖子' and '观测帖子' exist as builtin groups."""
    cur = await db.execute("SELECT COUNT(*) FROM monitor_groups WHERE is_builtin=1")
    (count,) = await cur.fetchone()
    if count >= 2:
        return
    builtin = [
        ("我的帖子",
         "[我的帖子]",
         "「{title}」点赞 **+{liked_delta}**（当前 {liked_count}）"),
        ("观测帖子",
         "[观测]",
         "「{title}」点赞 **+{liked_delta}**（当前 {liked_count}）"),
    ]
    for name, prefix, _tpl in builtin:
        await db.execute(
            "INSERT OR IGNORE INTO monitor_groups (name, message_prefix, is_builtin) VALUES (?, ?, 1)",
            (name, prefix),
        )


async def _migrate_post_type_to_group(db):
    """Backfill monitor_posts.group_id from legacy post_type values."""
    cur = await db.execute(
        "SELECT id FROM monitor_groups WHERE name='我的帖子' AND is_builtin=1"
    )
    row = await cur.fetchone()
    own_id = row[0] if row else None
    cur = await db.execute(
        "SELECT id FROM monitor_groups WHERE name='观测帖子' AND is_builtin=1"
    )
    row = await cur.fetchone()
    observe_id = row[0] if row else None
    if own_id:
        await db.execute(
            "UPDATE monitor_posts SET group_id=? WHERE group_id IS NULL AND post_type='own'",
            (own_id,),
        )
    if observe_id:
        await db.execute(
            "UPDATE monitor_posts SET group_id=? WHERE group_id IS NULL AND post_type='observe'",
            (observe_id,),
        )


async def _seed_default_prompt(db):
    cur = await db.execute("SELECT COUNT(*) FROM rewrite_prompts")
    (count,) = await cur.fetchone()
    if count > 0:
        return
    # Pull the legacy single prompt out of monitor_settings if present.
    cur = await db.execute("SELECT value FROM monitor_settings WHERE key='ai_rewrite_prompt'")
    row = await cur.fetchone()
    legacy = (row[0] if row else "") or (
        "你是小红书爆款文案创作者，请将以下内容改写为更吸引人的小红书风格文案，"
        "保持原意但语气更活泼、更有共鸣感，适当加入emoji。原文：\n\n{content}"
    )
    await db.execute(
        "INSERT INTO rewrite_prompts (name, content, is_default) VALUES (?, ?, 1)",
        ("默认", legacy),
    )


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_INIT_SQL)
        await _migrate(db)
        await _seed_default_prompt(db)
        await db.commit()


def parse_ids_csv(csv_value: str) -> List[int]:
    """Parse "1,2,3" into a list of ints, skipping empty/invalid entries."""
    if not csv_value:
        return []
    out: List[int] = []
    for part in csv_value.replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            continue
    return out


# ── Settings ────────────────────────────────────────────────────────────────

async def get_setting(key: str, default: str = "") -> str:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM monitor_settings WHERE key=?", (key,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else default


async def set_setting(key: str, value: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("INSERT OR REPLACE INTO monitor_settings VALUES (?,?)", (key, value))
        await db.commit()


async def delete_setting(key: str):
    """删除指定 key（用于"沿用全局"清除平台覆盖键）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM monitor_settings WHERE key=?", (key,))
        await db.commit()


async def get_all_settings() -> Dict[str, str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM monitor_settings") as cur:
            return {r[0]: r[1] for r in await cur.fetchall()}


# ── Accounts ────────────────────────────────────────────────────────────────

_ACCOUNT_COLUMNS_SELECT = (
    "id, name, cookie, proxy_url, user_agent, viewport, timezone, locale, "
    "fp_browser_type, fp_profile_id, fp_api_url, created_at, is_active, "
    "cookie_status, cookie_checked_at, cookie_last_check, "
    "COALESCE(cookie_synced_at,'') AS cookie_synced_at, "
    "COALESCE(cookie_synced_via,'') AS cookie_synced_via, "
    "is_shared, last_used_at, usage_count, user_id, "
    "COALESCE(platform,'xhs') AS platform"
)


async def add_account(
    name: str,
    cookie: str,
    proxy_url: str = "",
    user_agent: str = "",
    viewport: str = "",
    timezone: str = "Asia/Shanghai",
    locale: str = "zh-CN",
    fp_browser_type: str = "builtin",
    fp_profile_id: str = "",
    fp_api_url: str = "",
    user_id: Optional[int] = None,
    is_shared: bool = False,
    platform: str = "xhs",
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO monitor_accounts
               (name, cookie, proxy_url, user_agent, viewport, timezone, locale,
                fp_browser_type, fp_profile_id, fp_api_url, user_id, is_shared, platform)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (name, cookie, proxy_url, user_agent, viewport, timezone or "Asia/Shanghai",
             locale or "zh-CN", fp_browser_type or "builtin", fp_profile_id, fp_api_url,
             user_id, 1 if is_shared else 0, platform or "xhs"),
        )
        await db.commit()
        return cur.lastrowid


async def update_account(account_id: int, **fields) -> bool:
    allowed = {
        "name", "cookie", "proxy_url", "user_agent", "viewport", "timezone",
        "locale", "fp_browser_type", "fp_profile_id", "fp_api_url", "is_shared",
    }
    updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if not updates:
        return False
    set_clause = ", ".join(f"{k}=?" for k in updates)
    values = list(updates.values()) + [account_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE monitor_accounts SET {set_clause} WHERE id=?", values)
        await db.commit()
    return True


async def get_accounts(
    include_secrets: bool = False,
    user_id: Optional[int] = None,
    only_shared: bool = False,
    only_owned: bool = False,
    platform: Optional[str] = None,
) -> List[Dict]:
    """Active accounts.

    - admin（user_id=None）默认看全部；
    - 普通用户默认看「自己的 + 平台共享池」；
    - only_owned=True 时只看用户自己；
    - only_shared=True 时只看共享池（用于热门搜索调度）；
    - platform 给定时过滤（xhs / douyin / mp）。
    """
    sql = f"SELECT {_ACCOUNT_COLUMNS_SELECT} FROM monitor_accounts WHERE is_active=1"
    params: list = []
    if only_shared:
        sql += " AND is_shared = 1"
    elif user_id is not None:
        if only_owned:
            sql += " AND user_id = ?"
            params.append(user_id)
        else:
            sql += " AND (user_id = ? OR is_shared = 1)"
            params.append(user_id)
    if platform:
        sql += " AND COALESCE(platform,'xhs') = ?"
        params.append(platform)
    sql += " ORDER BY id"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    if not include_secrets:
        for r in rows:
            r.pop("cookie", None)
    return rows


async def get_account(account_id: int, user_id: Optional[int] = None) -> Optional[Dict]:
    """Full account record (including cookie). If user_id is given, also enforce ownership.

    Note: shared accounts (is_shared=1) bypass the ownership check — any user can
    read them so the scheduler can pick a shared cookie regardless of who owns
    the post.
    """
    sql = f"SELECT {_ACCOUNT_COLUMNS_SELECT} FROM monitor_accounts WHERE id=?"
    params: list = [account_id]
    if user_id is not None:
        sql += " AND (user_id = ? OR is_shared = 1)"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def pick_shared_account() -> Optional[Dict]:
    """从平台共享池里挑一个最久未用、状态健康的账号（LRU）。

    用于热门搜索 / 观测帖子兜底等不绑定具体用户的抓取任务。
    """
    sql = (
        f"SELECT {_ACCOUNT_COLUMNS_SELECT} FROM monitor_accounts "
        "WHERE is_active=1 AND is_shared=1 "
        "  AND cookie != '' "
        "  AND (cookie_status IS NULL OR cookie_status != 'expired') "
        "ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, id ASC "
        "LIMIT 1"
    )
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def mark_account_used(account_id: int) -> None:
    """记录账号最近一次被调度的时间，供 LRU 排序。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_accounts "
            "SET last_used_at = datetime('now', 'localtime'), "
            "    usage_count  = COALESCE(usage_count, 0) + 1 "
            "WHERE id=?",
            (account_id,),
        )
        await db.commit()


async def update_cookie_status(account_id: int, status: str) -> None:
    """更新 cookie 健康状态 + 同步刷新两个时间戳：
    - cookie_checked_at：保留旧字段，部分老代码/前端在用。
    - cookie_last_check：探针专用 ISO 时间戳，给 admin/前端展示「上次检测时间」。
    """
    now_iso = datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_accounts SET cookie_status=?, "
            "cookie_checked_at=datetime('now', 'localtime'), "
            "cookie_last_check=? WHERE id=?",
            (status, now_iso, account_id),
        )
        await db.commit()


async def get_account_cookie(account_id: int) -> Optional[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT cookie FROM monitor_accounts WHERE id=?", (account_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def update_cookie_via_bridge(
    account_id: int, cookie: str, source: str = "extension",
) -> None:
    """CookieBridge 浏览器扩展推送的 cookie 写入：同时刷新 cookie_synced_*
    并把 cookie_status 重置为 valid（让后台健康度 job 复测，避免误用过期态）。"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_accounts SET cookie=?, cookie_status='valid', "
            "cookie_synced_at=?, cookie_synced_via=? WHERE id=?",
            (cookie, now_iso, source, account_id),
        )
        await db.commit()


async def find_account_id_by_name_and_user(
    name: str, user_id: int, platform: str = "xhs",
) -> Optional[int]:
    """CookieBridge 用 (account_name, user_id) 找账号 id（多租户隔离）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM monitor_accounts "
            "WHERE name=? AND user_id=? AND COALESCE(platform,'xhs')=? "
            "LIMIT 1",
            (name, user_id, platform),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else None


async def delete_account(account_id: int, user_id: Optional[int] = None):
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "UPDATE monitor_accounts SET is_active=0 WHERE id=? AND user_id=?",
                (account_id, user_id),
            )
        else:
            await db.execute("UPDATE monitor_accounts SET is_active=0 WHERE id=?", (account_id,))
        await db.commit()


# ── Posts ───────────────────────────────────────────────────────────────────

async def add_post(
    note_id: str,
    title: str,
    short_url: str,
    note_url: str,
    xsec_token: str,
    xsec_source: str,
    account_id: Optional[int],
    post_type: str = "observe",
    group_id: Optional[int] = None,
    user_id: Optional[int] = None,
    platform: str = "xhs",
) -> int:
    """添加监控帖子。多租户场景下同一 note_id 可被多个用户独立添加。

    note_id 字段在不同平台语义不同（xhs note_id / douyin aweme_id / 公众号文章 mid+idx）。
    """
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT id FROM monitor_posts "
            "WHERE note_id=? AND COALESCE(user_id, 0)=COALESCE(?, 0) AND platform=?",
            (note_id, user_id, platform),
        )
        row = await cur.fetchone()
        if row:
            existing_id = row[0]
            await db.execute(
                "UPDATE monitor_posts SET title=?, short_url=?, note_url=?, "
                "xsec_token=?, xsec_source=?, account_id=?, post_type=?, "
                "group_id=?, platform=?, is_active=1 WHERE id=?",
                (title, short_url, note_url, xsec_token, xsec_source,
                 account_id, post_type, group_id, platform, existing_id),
            )
            await db.commit()
            return existing_id
        cur = await db.execute(
            """INSERT INTO monitor_posts
               (note_id, title, short_url, note_url, xsec_token, xsec_source,
                account_id, post_type, group_id, user_id, platform, is_active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1)""",
            (note_id, title, short_url, note_url, xsec_token, xsec_source,
             account_id, post_type, group_id, user_id, platform),
        )
        await db.commit()
        return cur.lastrowid


async def get_posts(
    user_id: Optional[int] = None,
    platform: Optional[str] = None,
) -> List[Dict]:
    sql = """
        SELECT p.*,
               a.name  AS account_name,
               g.name  AS group_name,
               s.liked_count, s.collected_count, s.comment_count, s.share_count,
               s.checked_at
        FROM monitor_posts p
        LEFT JOIN monitor_accounts a ON p.account_id = a.id
        LEFT JOIN monitor_groups g ON p.group_id = g.id
        LEFT JOIN (
            SELECT note_id, liked_count, collected_count, comment_count,
                   share_count, checked_at
            FROM monitor_snapshots
            WHERE id IN (SELECT MAX(id) FROM monitor_snapshots GROUP BY note_id)
        ) s ON p.note_id = s.note_id
        WHERE p.is_active = 1
    """
    params: list = []
    if user_id is not None:
        sql += " AND p.user_id = ?"
        params.append(user_id)
    if platform:
        sql += " AND p.platform = ?"
        params.append(platform)
    sql += " ORDER BY p.created_at DESC"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def update_post_group(note_id: str, group_id: Optional[int], user_id: Optional[int] = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "UPDATE monitor_posts SET group_id=? WHERE note_id=? AND user_id=?",
                (group_id, note_id, user_id),
            )
        else:
            await db.execute(
                "UPDATE monitor_posts SET group_id=? WHERE note_id=?",
                (group_id, note_id),
            )
        await db.commit()


async def get_active_posts() -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT p.*, a.cookie AS account_cookie
            FROM monitor_posts p
            LEFT JOIN monitor_accounts a ON p.account_id = a.id
            WHERE p.is_active = 1
        """) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete_post(note_id: str, user_id: Optional[int] = None):
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "UPDATE monitor_posts SET is_active=0 WHERE note_id=? AND user_id=?",
                (note_id, user_id),
            )
        else:
            await db.execute("UPDATE monitor_posts SET is_active=0 WHERE note_id=?", (note_id,))
        await db.commit()


async def get_post_history(note_id: str, limit: int = 100) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM monitor_snapshots WHERE note_id=? ORDER BY checked_at DESC LIMIT ?",
            (note_id, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_snapshot_at_or_before(note_id: str, hours_ago: int = 24) -> Optional[Dict]:
    """拿 hours_ago 小时之前最近的一条 snapshot，用于「N 小时涨幅」规则。"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT liked_count, collected_count, comment_count, share_count, checked_at "
            "FROM monitor_snapshots "
            "WHERE note_id=? AND checked_at <= datetime('now','localtime', ?) "
            "ORDER BY checked_at DESC LIMIT 1",
            (note_id, f"-{int(hours_ago)} hours"),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_latest_snapshot(note_id: str) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM monitor_snapshots WHERE note_id=? ORDER BY checked_at DESC LIMIT 1",
            (note_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def save_snapshot(
    note_id: str,
    liked_count: int,
    collected_count: int,
    comment_count: int,
    share_count: int,
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO monitor_snapshots (note_id,liked_count,collected_count,comment_count,share_count) VALUES (?,?,?,?,?)",
            (note_id, liked_count, collected_count, comment_count, share_count),
        )
        await db.commit()


async def search_posts(
    q: str,
    user_id: Optional[int] = None,
    platform: Optional[str] = None,
    limit: int = 50,
) -> List[Dict]:
    """全文搜索（title + summary）。

    实现说明：FTS5 trigram tokenizer 在中文上行为不稳定（依赖 SQLite 编译选项），
    数据量也不大（<10k 条），直接用 LIKE %q% 多关键词 AND 实现。后续如果数据量
    增长到必须用 FTS，再换 jieba 分词后重做。
    """
    if not q or not q.strip():
        return []
    parts = [p.strip() for p in q.split() if p.strip()]
    if not parts:
        return []

    sql = """
        SELECT p.*, p.title AS title_snip, p.summary AS summary_snip
        FROM monitor_posts p
        WHERE p.is_active = 1
    """
    params: list = []
    # 多关键词：每个 token 必须命中 title OR summary（AND 串接）
    for tok in parts:
        sql += " AND (p.title LIKE ? OR p.summary LIKE ?)"
        like = f"%{tok}%"
        params.extend([like, like])
    if user_id is not None:
        sql += " AND p.user_id = ?"
        params.append(user_id)
    if platform:
        sql += " AND p.platform = ?"
        params.append(platform)
    sql += " ORDER BY p.created_at DESC LIMIT ?"
    params.append(limit)

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def add_creator(
    user_id: int, platform: str, creator_url: str,
    creator_name: str = "", creator_id: str = "",
) -> int:
    """添加订阅博主。重复 (user, platform, url) 直接 IGNORE 不报错。"""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT OR IGNORE INTO monitor_creators "
            "(user_id, platform, creator_url, creator_name, creator_id, is_active) "
            "VALUES (?,?,?,?,?,1)",
            (user_id, platform, creator_url.strip(), creator_name, creator_id),
        )
        await db.commit()
        if cur.lastrowid:
            return cur.lastrowid
        # 重复 → 取已存在的 id
        cur = await db.execute(
            "SELECT id FROM monitor_creators WHERE user_id=? AND platform=? AND creator_url=?",
            (user_id, platform, creator_url.strip()),
        )
        row = await cur.fetchone()
        return row[0] if row else 0


async def list_creators(user_id: Optional[int] = None) -> List[Dict]:
    """订阅博主列表。

    排序：未读 > 0 优先 → 最近发帖时间倒序 → id 倒序。
    意图：进入页面就一眼看到「有新内容的、最近活跃的」博主。
    """
    sql = "SELECT * FROM monitor_creators WHERE is_active=1"
    params: list = []
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    sql += (
        " ORDER BY CASE WHEN COALESCE(unread_count,0)>0 THEN 0 ELSE 1 END,"
        "          COALESCE(last_post_at,'') DESC,"
        "          id DESC"
    )
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete_creator(creator_id: int, user_id: Optional[int] = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "UPDATE monitor_creators SET is_active=0 WHERE id=? AND user_id=?",
                (creator_id, user_id),
            )
        else:
            await db.execute("UPDATE monitor_creators SET is_active=0 WHERE id=?", (creator_id,))
        await db.commit()


async def update_creator_check(creator_id: int, last_post_id: str = "", creator_name: str = "") -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        sets = ["last_check_at=datetime('now','localtime')"]
        vals: list = []
        if last_post_id:
            sets.append("last_post_id=?"); vals.append(last_post_id)
        if creator_name:
            sets.append("creator_name=?"); vals.append(creator_name)
        vals.append(creator_id)
        await db.execute(f"UPDATE monitor_creators SET {','.join(sets)} WHERE id=?", vals)
        await db.commit()


async def mark_creator_status(
    creator_id: int, status: str, error: str = "",
) -> None:
    """记录上次抓取的健康状态：ok | no_account | cookie_invalid | error。

    前端用这个字段给 chip 着色，让用户一眼看到"哪些博主挂了"。
    """
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_creators SET last_check_status=?, last_check_error=?, "
            "last_check_at=datetime('now','localtime') WHERE id=?",
            (status, (error or "")[:300], creator_id),
        )
        await db.commit()


async def add_creator_unread(
    creator_id: int, delta: int, last_post_at: str = "",
) -> None:
    """新发现 N 篇新帖时累加未读 + 刷新最近发帖时间。

    排序逻辑依赖 last_post_at：哪个博主最新发帖，就排前面。
    """
    if delta <= 0:
        return
    now_iso = last_post_at or datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_creators SET "
            "  unread_count = COALESCE(unread_count,0)+?, "
            "  last_post_at = ? "
            "WHERE id=?",
            (delta, now_iso, creator_id),
        )
        await db.commit()


async def mark_creators_seen(
    user_id: Optional[int], creator_ids: Optional[List[int]] = None,
) -> int:
    """把指定博主的未读清零（用户访问列表/帖子页时调）。

    creator_ids 不给则清零该用户所有 creator。返回受影响行数。
    """
    sql = (
        "UPDATE monitor_creators SET unread_count=0, "
        "last_seen_at=datetime('now','localtime') "
        "WHERE COALESCE(unread_count,0)>0"
    )
    params: list = []
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    if creator_ids:
        sql += " AND id IN (" + ",".join("?" * len(creator_ids)) + ")"
        params.extend(creator_ids)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(sql, params)
        await db.commit()
        return cur.rowcount or 0


async def add_live(
    user_id: int, platform: str, room_url: str,
    streamer_name: str = "", online_alert_threshold: int = 0,
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT OR IGNORE INTO monitor_lives "
            "(user_id, platform, room_url, streamer_name, online_alert_threshold, is_active) "
            "VALUES (?,?,?,?,?,1)",
            (user_id, platform, room_url.strip(), streamer_name, online_alert_threshold),
        )
        await db.commit()
        if cur.lastrowid:
            return cur.lastrowid
        cur = await db.execute(
            "SELECT id FROM monitor_lives WHERE user_id=? AND platform=? AND room_url=?",
            (user_id, platform, room_url.strip()),
        )
        row = await cur.fetchone()
        return row[0] if row else 0


async def list_lives(user_id: Optional[int] = None) -> List[Dict]:
    sql = "SELECT * FROM monitor_lives WHERE is_active=1"
    params: list = []
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    sql += " ORDER BY id DESC"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete_live(live_id: int, user_id: Optional[int] = None) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "UPDATE monitor_lives SET is_active=0 WHERE id=? AND user_id=?",
                (live_id, user_id),
            )
        else:
            await db.execute("UPDATE monitor_lives SET is_active=0 WHERE id=?", (live_id,))
        await db.commit()


async def update_live_check(
    live_id: int, online: int = 0, gifts_json: str = "",
    streamer_name: str = "", room_id: str = "",
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        sets = ["last_check_at=datetime('now','localtime')", "last_online=?"]
        vals: list = [online]
        if gifts_json:
            sets.append("last_gifts=?"); vals.append(gifts_json)
        if streamer_name:
            sets.append("streamer_name=?"); vals.append(streamer_name)
        if room_id:
            sets.append("room_id=?"); vals.append(room_id)
        vals.append(live_id)
        await db.execute(f"UPDATE monitor_lives SET {','.join(sets)} WHERE id=?", vals)
        await db.commit()


async def log_fetch(
    platform: str,
    task_type: str,
    status: str,
    latency_ms: int = 0,
    account_id: Optional[int] = None,
    note_id: Optional[str] = None,
    note: Optional[str] = None,
) -> None:
    """记录一次 fetch 调用（fire-and-forget）。失败时静默吞掉，不影响主流程。"""
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO fetch_log (platform, task_type, status, latency_ms, account_id, note_id, note) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (platform, task_type, status, int(latency_ms), account_id, note_id, note),
            )
            # 滚动清理：保留最近 5000 条，防止表无限膨胀
            await db.execute(
                "DELETE FROM fetch_log WHERE rowid < ("
                "  SELECT MIN(rowid) FROM (SELECT rowid FROM fetch_log ORDER BY rowid DESC LIMIT 5000)"
                ")"
            )
            await db.commit()
    except Exception:
        pass


async def health_summary(days: int = 7) -> dict:
    """7 天内的抓取健康度聚合：按 platform / account / task_type 分组。"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # 按 platform × status
        async with db.execute(f"""
            SELECT platform, status, COUNT(*) AS n, AVG(latency_ms) AS avg_ms
            FROM fetch_log
            WHERE created_at >= datetime('now','localtime', ?)
            GROUP BY platform, status
        """, (f"-{int(days)} days",)) as cur:
            by_platform = [dict(r) for r in await cur.fetchall()]
        # 按 account_id × status
        async with db.execute(f"""
            SELECT a.id AS account_id, a.name AS account_name, a.platform AS acc_platform,
                   l.status, COUNT(*) AS n, AVG(l.latency_ms) AS avg_ms,
                   MAX(l.created_at) AS last_at
            FROM fetch_log l
            LEFT JOIN monitor_accounts a ON a.id = l.account_id
            WHERE l.created_at >= datetime('now','localtime', ?)
              AND l.account_id IS NOT NULL
            GROUP BY l.account_id, l.status
        """, (f"-{int(days)} days",)) as cur:
            by_account = [dict(r) for r in await cur.fetchall()]
        # 总数
        async with db.execute(f"""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_n,
                   SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END) AS fail_n
            FROM fetch_log
            WHERE created_at >= datetime('now','localtime', ?)
        """, (f"-{int(days)} days",)) as cur:
            totals = dict(await cur.fetchone())
        # 最近一次失败
        async with db.execute("""
            SELECT platform, task_type, status, note, created_at, account_id
            FROM fetch_log
            WHERE status != 'ok'
            ORDER BY created_at DESC LIMIT 20
        """) as cur:
            recent_fail = [dict(r) for r in await cur.fetchall()]
    return {
        "days": days,
        "totals": totals,
        "by_platform": by_platform,
        "by_account": by_account,
        "recent_fail": recent_fail,
    }


async def get_post_by_note_id(note_id: str, user_id: Optional[int] = None) -> Optional[Dict]:
    """按 note_id（按 user_id 隔离）拿单条 active post 的所有字段。"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        sql = "SELECT * FROM monitor_posts WHERE note_id=? AND is_active=1"
        params: list = [note_id]
        if user_id is not None:
            sql += " AND user_id=?"
            params.append(user_id)
        async with db.execute(sql, params) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def save_post_summary(note_id: str, summary: str, user_id: Optional[int] = None) -> None:
    """更新某帖子的 AI 摘要。"""
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "UPDATE monitor_posts SET summary=?, summary_at=datetime('now','localtime') "
                "WHERE note_id=? AND user_id=?",
                (summary, note_id, user_id),
            )
        else:
            await db.execute(
                "UPDATE monitor_posts SET summary=?, summary_at=datetime('now','localtime') "
                "WHERE note_id=?",
                (summary, note_id),
            )
        await db.commit()


async def update_post_fetch_status(note_id: str, status: str) -> None:
    """更新最近一次抓取状态。

    - status='ok' → fail_count 重置为 0
    - 其他（login_required/deleted/error）→ fail_count += 1
    """
    is_ok = status == "ok"
    async with aiosqlite.connect(DB_PATH) as db:
        if is_ok:
            await db.execute(
                "UPDATE monitor_posts SET last_fetch_status=?, "
                "last_fetch_at=datetime('now', 'localtime'), fail_count=0 "
                "WHERE note_id=?",
                (status, note_id),
            )
        else:
            await db.execute(
                "UPDATE monitor_posts SET last_fetch_status=?, "
                "last_fetch_at=datetime('now', 'localtime'), "
                "fail_count = COALESCE(fail_count, 0) + 1 "
                "WHERE note_id=?",
                (status, note_id),
            )
        await db.commit()


# 连续失败 N 次后停抓。阈值定在 5：login_required 触发频率较低，
# 5 次后基本可以判定 token 永久失效。
DEAD_POST_FAIL_THRESHOLD = 5


async def cleanup_dead_posts(user_id: Optional[int] = None) -> int:
    """把 fail_count >= 阈值的帖子设置 is_active=0，返回处理条数。"""
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            cur = await db.execute(
                "UPDATE monitor_posts SET is_active=0 "
                "WHERE is_active=1 AND COALESCE(fail_count, 0) >= ? AND user_id=?",
                (DEAD_POST_FAIL_THRESHOLD, user_id),
            )
        else:
            cur = await db.execute(
                "UPDATE monitor_posts SET is_active=0 "
                "WHERE is_active=1 AND COALESCE(fail_count, 0) >= ?",
                (DEAD_POST_FAIL_THRESHOLD,),
            )
        await db.commit()
        return cur.rowcount or 0


async def has_recent_alert(note_id: str, alert_type: str, hours: int = 4) -> bool:
    """4 小时去抖动用：最近 N 小时内同 (note_id, alert_type) 是否已经告警过。"""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT 1 FROM monitor_alerts "
            "WHERE note_id=? AND alert_type=? "
            "  AND created_at >= datetime('now','localtime', ?) LIMIT 1",
            (note_id, alert_type, f"-{int(hours)} hours"),
        )
        return (await cur.fetchone()) is not None


async def has_ever_alerted(note_id: str, alert_type: str) -> bool:
    """累计触发用：该 (note_id, alert_type) 是否曾经告警过（用于"首次达到"语义）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT 1 FROM monitor_alerts WHERE note_id=? AND alert_type=? LIMIT 1",
            (note_id, alert_type),
        )
        return (await cur.fetchone()) is not None


async def save_alert(note_id: str, title: str, alert_type: str, message: str, user_id: Optional[int] = None):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO monitor_alerts (note_id,title,alert_type,message,user_id) VALUES (?,?,?,?,?)",
            (note_id, title, alert_type, message, user_id),
        )
        await db.commit()


async def get_alerts(limit: int = 50, user_id: Optional[int] = None) -> List[Dict]:
    sql = "SELECT * FROM monitor_alerts"
    params: list = []
    if user_id is not None:
        sql += " WHERE user_id=?"
        params.append(user_id)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def clear_alerts(user_id: Optional[int] = None) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            cur = await db.execute("DELETE FROM monitor_alerts WHERE user_id=?", (user_id,))
        else:
            cur = await db.execute("DELETE FROM monitor_alerts")
        await db.commit()
        return cur.rowcount or 0


async def delete_alert(alert_id: int, user_id: Optional[int] = None):
    async with aiosqlite.connect(DB_PATH) as db:
        if user_id is not None:
            await db.execute(
                "DELETE FROM monitor_alerts WHERE id=? AND user_id=?",
                (alert_id, user_id),
            )
        else:
            await db.execute("DELETE FROM monitor_alerts WHERE id=?", (alert_id,))
        await db.commit()


# ── Trending Posts ───────────────────────────────────────────────────────────

async def add_or_update_trending_post(
    note_id: str, title: str, desc_text: str, note_url: str,
    xsec_token: str, liked_count: int, collected_count: int,
    comment_count: int, keyword: str, author: str,
    cover_url: str = "", images: str = "", video_url: str = "", note_type: str = "normal",
    platform: str = "xhs",
    user_id: Optional[int] = None,
) -> bool:
    """Insert/upsert trending post for the given user. Returns True if newly inserted.

    多租户：同一个 note 可能在不同用户下各有一条独立记录（按 (note_id, user_id) 唯一）。
    user_id=None 仅旧代码兼容 — 新调用方（scheduler）必须传 user_id。
    """
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT id FROM trending_posts WHERE note_id=? AND COALESCE(user_id,0)=?",
            (note_id, user_id or 0),
        )
        exists = await cur.fetchone()
        if exists:
            await db.execute(
                """UPDATE trending_posts
                   SET liked_count=?, collected_count=?, comment_count=?,
                       title    = CASE WHEN title    IS NULL OR title    = '' THEN ? ELSE title    END,
                       author   = CASE WHEN author   IS NULL OR author   = '' THEN ? ELSE author   END,
                       desc_text= CASE WHEN desc_text IS NULL OR desc_text= '' THEN ? ELSE desc_text END,
                       cover_url= CASE WHEN cover_url IS NULL OR cover_url = '' THEN ? ELSE cover_url END,
                       images   = CASE WHEN images    IS NULL OR images    = '' THEN ? ELSE images    END,
                       video_url= CASE WHEN video_url IS NULL OR video_url = '' THEN ? ELSE video_url END,
                       note_type= CASE WHEN note_type IS NULL OR note_type = '' THEN ? ELSE note_type END,
                       platform = CASE WHEN platform  IS NULL OR platform  = '' THEN ? ELSE platform  END
                   WHERE note_id=? AND COALESCE(user_id,0)=?""",
                (liked_count, collected_count, comment_count,
                 title, author, desc_text,
                 cover_url, images, video_url, note_type, platform,
                 note_id, user_id or 0),
            )
            await db.commit()
            return False
        await db.execute(
            """INSERT INTO trending_posts
               (note_id,title,desc_text,note_url,xsec_token,liked_count,collected_count,comment_count,
                keyword,author,cover_url,images,video_url,note_type,platform,user_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (note_id, title, desc_text, note_url, xsec_token,
             liked_count, collected_count, comment_count, keyword, author,
             cover_url, images, video_url, note_type, platform, user_id),
        )
        await db.commit()
        return True


async def get_trending_posts(
    limit: int = 50, platform: Optional[str] = None,
    user_id: Optional[int] = None,
) -> List[Dict]:
    """user_id=None 时不过滤（admin 可看所有用户的；scheduler 内部也无过滤需要时用）。"""
    sql = "SELECT * FROM trending_posts"
    where, params = [], []
    if platform:
        where.append("platform=?")
        params.append(platform)
    if user_id is not None:
        where.append("user_id=?")
        params.append(user_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY found_at DESC LIMIT ?"
    params.append(limit)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def update_trending_desc(
    note_id: str, desc_text: str, user_id: Optional[int] = None,
) -> None:
    sql = "UPDATE trending_posts SET desc_text=? WHERE note_id=?"
    params: list = [desc_text, note_id]
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(sql, params)
        await db.commit()


async def update_trending_media(
    note_id: str,
    cover_url: str = "",
    images_json: str = "",
    video_url: str = "",
    note_type: str = "",
    user_id: Optional[int] = None,
) -> None:
    """Only overwrite fields that come in non-empty (preserve existing data)."""
    if not cover_url and images_json:
        try:
            import json as _json
            arr = _json.loads(images_json)
            if isinstance(arr, list) and arr and isinstance(arr[0], str):
                cover_url = arr[0]
        except Exception:
            pass
    sets, vals = [], []
    if cover_url:
        sets.append("cover_url=?"); vals.append(cover_url)
    if images_json:
        sets.append("images=?"); vals.append(images_json)
    if video_url:
        sets.append("video_url=?"); vals.append(video_url)
    if note_type:
        sets.append("note_type=?"); vals.append(note_type)
    if not sets:
        return
    sql = f"UPDATE trending_posts SET {','.join(sets)} WHERE note_id=?"
    vals.append(note_id)
    if user_id is not None:
        sql += " AND user_id=?"
        vals.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(sql, vals)
        await db.commit()


async def update_trending_rewrite(
    note_id: str, rewritten_text: str, status: str = "done",
    user_id: Optional[int] = None,
):
    sql = "UPDATE trending_posts SET rewritten_text=?,rewrite_status=? WHERE note_id=?"
    params: list = [rewritten_text, status, note_id]
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(sql, params)
        await db.commit()


async def get_trending_post(
    note_id: str, user_id: Optional[int] = None,
) -> Optional[Dict]:
    sql = "SELECT * FROM trending_posts WHERE note_id=?"
    params: list = [note_id]
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def mark_trending_synced(note_id: str, user_id: Optional[int] = None):
    sql = "UPDATE trending_posts SET synced_to_bitable=1 WHERE note_id=?"
    params: list = [note_id]
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(sql, params)
        await db.commit()


async def get_unsynced_trending_posts(user_id: Optional[int] = None) -> List[Dict]:
    sql = "SELECT * FROM trending_posts WHERE synced_to_bitable=0 AND rewrite_status='done'"
    params: list = []
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── Monitor Groups ───────────────────────────────────────────────────────────

_GROUP_COLUMNS = (
    "id, name, feishu_webhook_url, wecom_webhook_url, "
    "COALESCE(feishu_chat_id,'') AS feishu_chat_id, "
    "likes_alert_enabled, likes_threshold, "
    "collects_alert_enabled, collects_threshold, "
    "comments_alert_enabled, comments_threshold, "
    "message_prefix, template_likes, template_collects, template_comments, "
    "COALESCE(alert_rules,'') AS alert_rules, "
    "is_builtin, user_id, created_at"
)


async def list_groups(user_id: Optional[int] = None) -> List[Dict]:
    """内置分组对所有用户可见；自定义分组按 user_id 过滤。"""
    sql = f"SELECT {_GROUP_COLUMNS} FROM monitor_groups"
    params: list = []
    if user_id is not None:
        sql += " WHERE is_builtin=1 OR user_id=?"
        params.append(user_id)
    sql += " ORDER BY is_builtin DESC, id"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_group(group_id: int, user_id: Optional[int] = None) -> Optional[Dict]:
    """读单个分组。

    user_id=None（admin 模式）：直接读，不校验归属。
    user_id 传值：仅当 group 是内置的（is_builtin=1）或属于该 user 才返回。
    """
    sql = f"SELECT {_GROUP_COLUMNS} FROM monitor_groups WHERE id=?"
    params: list = [group_id]
    if user_id is not None:
        sql += " AND (is_builtin=1 OR user_id=?)"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def create_group(
    name: str,
    user_id: Optional[int] = None,
    feishu_chat_id: str = "",
    feishu_webhook_url: str = "",
) -> int:
    """创建分组。新版支持绑定飞书：
      - feishu_chat_id  非空 → 内部群（应用机器人）
      - feishu_webhook_url 非空 → 外部群（自定义机器人 webhook）
      - 都为空 → 仅本地分组（不会触发告警推送）
    """
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO monitor_groups (name, user_id, feishu_chat_id, feishu_webhook_url) "
            "VALUES (?, ?, ?, ?)",
            (name, user_id, feishu_chat_id, feishu_webhook_url),
        )
        await db.commit()
        return cur.lastrowid


async def update_group(group_id: int, user_id: Optional[int] = None, **fields) -> bool:
    """Update any subset of group fields. 返回是否实际改了行。

    user_id=None（admin 模式）：直接改。
    user_id 传值：仅当 group 是内置的或属于该 user 才改；否则返回 False（无权限）。
    """
    allowed = {
        "name", "feishu_webhook_url", "feishu_chat_id", "wecom_webhook_url",
        "likes_alert_enabled", "likes_threshold",
        "collects_alert_enabled", "collects_threshold",
        "comments_alert_enabled", "comments_threshold",
        "message_prefix", "template_likes", "template_collects", "template_comments",
        "alert_rules",
    }
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed and v is not None:
            sets.append(f"{k}=?"); vals.append(v)
    if not sets:
        return False
    sql = f"UPDATE monitor_groups SET {','.join(sets)} WHERE id=?"
    vals.append(group_id)
    if user_id is not None:
        sql += " AND (is_builtin=1 OR user_id=?)"
        vals.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(sql, vals)
        await db.commit()
        return (cur.rowcount or 0) > 0


async def delete_group(
    group_id: int,
    fallback_group_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> None:
    """Delete a non-builtin group. Posts are reassigned to fallback (or NULL).

    user_id=None（admin）：可删任意非内置分组。
    user_id 传值：仅能删自己的分组；删别人的抛 PermissionError。
    """
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT is_builtin, user_id FROM monitor_groups WHERE id=?", (group_id,)
        )
        row = await cur.fetchone()
        if not row:
            raise ValueError("分组不存在")
        if row[0]:
            raise ValueError("内置分组不能删除")
        owner = row[1]
        if user_id is not None and owner != user_id:
            raise PermissionError("无权删除该分组")
        await db.execute(
            "UPDATE monitor_posts SET group_id=? WHERE group_id=?",
            (fallback_group_id, group_id),
        )
        await db.execute("DELETE FROM monitor_groups WHERE id=?", (group_id,))
        await db.commit()


# ── Rewrite Prompts ──────────────────────────────────────────────────────────

async def list_prompts(user_id: Optional[int] = None) -> List[Dict]:
    """默认 prompt 全局可见；用户自定义按 user_id 过滤。"""
    sql = "SELECT * FROM rewrite_prompts"
    params: list = []
    if user_id is not None:
        sql += " WHERE user_id IS NULL OR user_id = ?"
        params.append(user_id)
    sql += " ORDER BY is_default DESC, id"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_prompt(prompt_id: int, user_id: Optional[int] = None) -> Optional[Dict]:
    """读单个 prompt。

    user_id=None（admin）：直接读。
    user_id 传值：仅当 prompt 是内置全局（user_id=NULL）或属于该 user 才返回。
    """
    sql = "SELECT * FROM rewrite_prompts WHERE id=?"
    params: list = [prompt_id]
    if user_id is not None:
        sql += " AND (user_id IS NULL OR user_id=?)"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_default_prompt() -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM rewrite_prompts WHERE is_default=1 ORDER BY id LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
            if row:
                return dict(row)
        # Fallback: any prompt
        async with db.execute(
            "SELECT * FROM rewrite_prompts ORDER BY id LIMIT 1"
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def create_prompt(name: str, content: str, user_id: Optional[int] = None) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO rewrite_prompts (name, content, user_id) VALUES (?, ?, ?)",
            (name, content, user_id),
        )
        await db.commit()
        return cur.lastrowid


async def update_prompt(
    prompt_id: int,
    name: Optional[str] = None,
    content: Optional[str] = None,
    user_id: Optional[int] = None,
) -> bool:
    """改 prompt 名/内容。

    user_id=None（admin）：可改任意 prompt（含内置）。
    user_id 传值：仅能改自己的 prompt（不能改内置全局）。返回是否实际改了。
    """
    fields, values = [], []
    if name is not None:
        fields.append("name=?"); values.append(name)
    if content is not None:
        fields.append("content=?"); values.append(content)
    if not fields:
        return False
    sql = f"UPDATE rewrite_prompts SET {','.join(fields)} WHERE id=?"
    values.append(prompt_id)
    if user_id is not None:
        sql += " AND user_id=?"  # 不能改内置（user_id IS NULL），仅自己的
        values.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(sql, values)
        await db.commit()
        return (cur.rowcount or 0) > 0


async def delete_prompt(prompt_id: int, user_id: Optional[int] = None) -> bool:
    """删 prompt。普通用户只能删自己的（不能删内置全局）。返回是否实际删了。"""
    sql = "DELETE FROM rewrite_prompts WHERE id=?"
    params: list = [prompt_id]
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(sql, params)
        await db.commit()
        return (cur.rowcount or 0) > 0


async def set_default_prompt(prompt_id: int, user_id: Optional[int] = None) -> bool:
    """把指定 prompt 标记为默认。

    is_default 当前是表级全局唯一（admin 设置的影响所有用户）。
    user_id 传值时校验该 prompt 是内置或属于该 user，避免越权设别人的。
    """
    if user_id is not None:
        # 校验归属
        target = await get_prompt(prompt_id, user_id=user_id)
        if not target:
            return False
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE rewrite_prompts SET is_default=0")
        cur = await db.execute(
            "UPDATE rewrite_prompts SET is_default=1 WHERE id=?", (prompt_id,)
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


# ── Trending pending posts ───────────────────────────────────────────────────

async def get_pending_trending_posts(user_id: Optional[int] = None) -> List[Dict]:
    """Trending posts that still need AI rewriting (status pending / failed / skipped)."""
    sql = "SELECT * FROM trending_posts WHERE rewrite_status IN ('pending','failed','skipped')"
    params: list = []
    if user_id is not None:
        sql += " AND user_id=?"
        params.append(user_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── Note Comments Cache ───────────────────────────────────────────────────────

async def get_known_comment_ids(note_id: str) -> set:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT comment_id FROM note_comments_cache WHERE note_id=?", (note_id,)
        ) as cur:
            return {r[0] for r in await cur.fetchall()}


async def add_note_comments(note_id: str, comments: List[Dict]) -> List[Dict]:
    """Save new comments, return only newly inserted ones."""
    known = await get_known_comment_ids(note_id)
    new_comments = [c for c in comments if c.get("comment_id") and c["comment_id"] not in known]
    if not new_comments:
        return []
    async with aiosqlite.connect(DB_PATH) as db:
        for c in new_comments:
            await db.execute(
                """INSERT OR IGNORE INTO note_comments_cache
                   (note_id,comment_id,content,user_name,user_id,liked_count,create_time)
                   VALUES (?,?,?,?,?,?,?)""",
                (note_id, c["comment_id"], c.get("content", ""),
                 c.get("user_name", ""), c.get("user_id", ""),
                 c.get("liked_count", 0), c.get("create_time", 0)),
            )
        await db.commit()
    return new_comments


# ── Image Gen History ────────────────────────────────────────────────────────

async def add_image_history(
    *, user_id: Optional[int], prompt: str, negative_prompt: str = "",
    size: str = "", model: str = "",
    set_idx: int = 1, in_set_idx: int = 1,
    local_url: str = "", qiniu_url: str = "", qiniu_key: str = "",
    upload_status: str = "skipped",
    generated_title: str = "", generated_body: str = "",
    batch_id: str = "",
    source_post_url: str = "", source_post_title: str = "",
    used_reference: bool = False,
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO image_gen_history
               (user_id, prompt, negative_prompt, size, model,
                set_idx, in_set_idx, local_url, qiniu_url, qiniu_key,
                upload_status, generated_title, generated_body, batch_id,
                source_post_url, source_post_title, used_reference)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (user_id, prompt, negative_prompt, size, model,
             set_idx, in_set_idx, local_url, qiniu_url, qiniu_key,
             upload_status, generated_title, generated_body, batch_id,
             source_post_url, source_post_title,
             1 if used_reference else 0),
        )
        await db.commit()
        return cur.lastrowid or 0


# ── 异步上传队列 ─────────────────────────────────────────────────────────────

async def list_pending_image_uploads(limit: int = 5) -> List[Dict]:
    """取还在等待上传到七牛的记录（按 id 升序，最旧的先传）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM image_gen_history WHERE upload_status='pending' "
            "ORDER BY id ASC LIMIT ?",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def mark_image_upload_succeeded(
    record_id: int, qiniu_url: str, qiniu_key: str = "",
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE image_gen_history "
            "SET qiniu_url=?, qiniu_key=?, upload_status='uploaded', upload_last_error='' "
            "WHERE id=?",
            (qiniu_url, qiniu_key, record_id),
        )
        await db.commit()


async def mark_image_upload_failed(
    record_id: int, error: str, max_retries: int = 3,
) -> None:
    """递增 retries；超阈值标记 failed，否则保持 pending 等下次。"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT upload_retries FROM image_gen_history WHERE id=?", (record_id,),
        ) as cur:
            row = await cur.fetchone()
            if not row:
                return
            retries = (row[0] or 0) + 1
        new_status = "failed" if retries >= max_retries else "pending"
        await db.execute(
            "UPDATE image_gen_history "
            "SET upload_retries=?, upload_status=?, upload_last_error=? WHERE id=?",
            (retries, new_status, (error or "")[:500], record_id),
        )
        await db.commit()


async def reset_image_upload_failed(record_id: int) -> None:
    """手动重试：把 failed 记录重置为 pending、清空错误。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE image_gen_history "
            "SET upload_status='pending', upload_retries=0, upload_last_error='' "
            "WHERE id=? AND upload_status='failed'",
            (record_id,),
        )
        await db.commit()


async def list_image_history(
    user_id: Optional[int] = None, limit: int = 100, offset: int = 0,
) -> List[Dict]:
    """admin（user_id=None）看全部；普通用户只看自己的。"""
    where = "WHERE user_id=?" if user_id is not None else ""
    args = (user_id,) if user_id is not None else ()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT * FROM image_gen_history {where} "
            f"ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_image_history(record_id: int) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM image_gen_history WHERE id=?", (record_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def mark_image_history_synced(record_id: int, bitable_record_id: str = "") -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE image_gen_history SET synced_to_bitable=1, bitable_record_id=? WHERE id=?",
            (bitable_record_id, record_id),
        )
        await db.commit()


async def delete_image_history(record_id: int, user_id: Optional[int] = None) -> bool:
    """删除一条历史记录。普通用户只能删自己的；admin（user_id=None）能删任何。"""
    where = "WHERE id=? AND user_id=?" if user_id is not None else "WHERE id=?"
    args = (record_id, user_id) if user_id is not None else (record_id,)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(f"DELETE FROM image_gen_history {where}", args)
        await db.commit()
        return (cur.rowcount or 0) > 0


# ── Remix Tasks（仿写异步任务） ───────────────────────────────────────────────

async def create_remix_task(
    *, user_id: Optional[int],
    post_url: str, post_title: str = "", post_desc: str = "",
    platform: str = "xhs",
    ref_image_url: str = "", ref_image_idx: int = 0,
    count: int = 1, size: str = "",
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO remix_tasks
               (user_id, status, post_url, post_title, post_desc, platform,
                ref_image_url, ref_image_idx, count, done_count, items_json, size)
               VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?)""",
            (user_id, post_url, post_title, post_desc, platform,
             ref_image_url, ref_image_idx, count, size),
        )
        await db.commit()
        return cur.lastrowid or 0


async def get_remix_task(task_id: int) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM remix_tasks WHERE id=?", (task_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def list_remix_tasks(
    user_id: Optional[int] = None, limit: int = 30,
) -> List[Dict]:
    where = "WHERE user_id=?" if user_id is not None else ""
    args = (user_id,) if user_id is not None else ()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT * FROM remix_tasks {where} "
            f"ORDER BY created_at DESC LIMIT ?",
            (*args, limit),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def claim_pending_remix_task() -> Optional[Dict]:
    """原子取一条 pending 任务并标记 running。返回该任务（或 None）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("BEGIN IMMEDIATE")
        async with db.execute(
            "SELECT * FROM remix_tasks WHERE status='pending' "
            "ORDER BY id ASC LIMIT 1",
        ) as cur:
            row = await cur.fetchone()
        if not row:
            await db.commit()
            return None
        await db.execute(
            "UPDATE remix_tasks SET status='running', "
            "started_at=datetime('now','localtime') WHERE id=?",
            (row["id"],),
        )
        await db.commit()
        return dict(row)


async def update_remix_task_progress(
    task_id: int, *, items_json: str, done_count: int,
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE remix_tasks SET items_json=?, done_count=? WHERE id=?",
            (items_json, done_count, task_id),
        )
        await db.commit()


async def finish_remix_task(
    task_id: int, *, status: str = "done", error: str = "",
) -> None:
    """status: done / error。设置 finished_at。"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE remix_tasks "
            "SET status=?, error=?, finished_at=datetime('now','localtime') "
            "WHERE id=?",
            (status, (error or "")[:500], task_id),
        )
        await db.commit()


async def delete_remix_task(task_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM remix_tasks WHERE id=?", (task_id,))
        await db.commit()


async def has_pending_remix_tasks() -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM remix_tasks WHERE status='pending' LIMIT 1",
        ) as cur:
            return (await cur.fetchone()) is not None


# ── Media Archive（爆款媒体归档）─────────────────────────────────────────────

async def archive_enqueue(
    *, user_id: Optional[int], platform: str, note_id: str,
    note_url: str, note_title: str, author: str,
    kind: str, src_url: str,
) -> Optional[int]:
    """登记一条待归档媒体（去重：同 note_id + src_url 不重复入库）。
    返回新行 id；冲突时返回 None。"""
    if not note_id or not src_url:
        return None
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            cur = await db.execute(
                """INSERT INTO media_archive
                   (user_id, platform, note_id, note_url, note_title, author,
                    kind, src_url, status)
                   VALUES (?,?,?,?,?,?,?,?, 'pending')""",
                (user_id, platform or "xhs", note_id, note_url or "",
                 (note_title or "")[:500], (author or "")[:200],
                 kind, src_url),
            )
            await db.commit()
            return cur.lastrowid
    except aiosqlite.IntegrityError:
        return None  # 唯一索引冲突 = 已经登记过


async def archive_list_pending(limit: int = 30) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM media_archive "
            "WHERE status='pending' AND fail_count<3 "
            "ORDER BY id ASC LIMIT ?",
            (limit,),
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def archive_mark_done(
    archive_id: int, *, storage_url: str, storage_backend: str,
    sha256: str, size_bytes: int,
) -> None:
    now_iso = datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE media_archive SET status='done', storage_url=?, "
            "storage_backend=?, sha256=?, size_bytes=?, archived_at=?, last_error='' "
            "WHERE id=?",
            (storage_url, storage_backend, sha256, size_bytes, now_iso, archive_id),
        )
        await db.commit()


async def archive_mark_failed(archive_id: int, error: str = "") -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE media_archive "
            "SET status=CASE WHEN fail_count>=2 THEN 'failed' ELSE 'pending' END, "
            "    fail_count=fail_count+1, last_error=? WHERE id=?",
            ((error or "")[:500], archive_id),
        )
        await db.commit()


async def archive_list_for_user(
    user_id: Optional[int], *, platform: str = "", note_id: str = "",
    status: str = "", limit: int = 100, offset: int = 0,
) -> List[Dict]:
    sql = "SELECT * FROM media_archive WHERE 1=1"
    params: list = []
    if user_id is not None:
        sql += " AND (user_id=? OR user_id IS NULL)"
        params.append(user_id)
    if platform:
        sql += " AND platform=?"
        params.append(platform)
    if note_id:
        sql += " AND note_id=?"
        params.append(note_id)
    if status:
        sql += " AND status=?"
        params.append(status)
    sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def archive_count_for_user(
    user_id: Optional[int], *, platform: str = "", status: str = "",
) -> int:
    sql = "SELECT COUNT(*) FROM media_archive WHERE 1=1"
    params: list = []
    if user_id is not None:
        sql += " AND (user_id=? OR user_id IS NULL)"
        params.append(user_id)
    if platform:
        sql += " AND platform=?"
        params.append(platform)
    if status:
        sql += " AND status=?"
        params.append(status)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(sql, params) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 0


# ── Creator Stats（创作者中心数据）───────────────────────────────────────────

async def creator_stats_upsert(
    *, user_id: Optional[int], account_id: int, platform: str,
    snapshot_date: str, raw_json: str, **fields,
) -> None:
    """每天一行；同一天重复抓覆盖更新。fields 接 fans_count/total_views 等数值列。"""
    cols = [
        "fans_count", "fans_delta", "notes_count",
        "total_views", "total_likes", "total_collects", "total_comments",
        "daily_views", "daily_likes", "daily_collects", "daily_comments",
    ]
    values = [int(fields.get(c, 0) or 0) for c in cols]

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"""INSERT INTO creator_stats
                (user_id, account_id, platform, snapshot_date, raw_json,
                 {", ".join(cols)})
                VALUES (?,?,?,?,?,{",".join("?" * len(cols))})
                ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
                  raw_json=excluded.raw_json,
                  {", ".join(f"{c}=excluded.{c}" for c in cols)},
                  fetched_at=datetime('now', 'localtime')""",
            (user_id, account_id, platform or "xhs", snapshot_date,
             raw_json, *values),
        )
        await db.commit()


async def creator_stats_list(
    user_id: Optional[int], *, account_id: Optional[int] = None,
    days: int = 30,
) -> List[Dict]:
    sql = (
        "SELECT cs.*, ma.name AS account_name "
        "  FROM creator_stats cs "
        "  LEFT JOIN monitor_accounts ma ON ma.id = cs.account_id "
        " WHERE 1=1"
    )
    params: list = []
    if user_id is not None:
        sql += " AND cs.user_id=?"
        params.append(user_id)
    if account_id:
        sql += " AND cs.account_id=?"
        params.append(account_id)
    sql += " AND cs.snapshot_date >= date('now', ?)"
    params.append(f"-{int(days)} days")
    sql += " ORDER BY cs.snapshot_date DESC, cs.account_id ASC"

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def creator_stats_latest_per_account(
    user_id: Optional[int],
) -> List[Dict]:
    """每个账号的最新一行（用于看板首页）。"""
    sql = (
        "SELECT cs.*, ma.name AS account_name "
        "  FROM creator_stats cs "
        "  LEFT JOIN monitor_accounts ma ON ma.id = cs.account_id "
        " WHERE cs.id IN ( "
        "   SELECT MAX(id) FROM creator_stats GROUP BY account_id "
        " )"
    )
    params: list = []
    if user_id is not None:
        sql += " AND cs.user_id=?"
        params.append(user_id)
    sql += " ORDER BY cs.account_id ASC"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── Crawl Cursor（断点续爬）──────────────────────────────────────────────────

async def cursor_mark_running(task: str, key: str) -> None:
    """处理某条目前调用：UPSERT 进 idle/running 状态。"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO crawl_cursor(task, key, status, last_run_at) "
            "VALUES (?, ?, 'running', ?) "
            "ON CONFLICT(task, key) DO UPDATE SET "
            "  status='running', last_run_at=excluded.last_run_at",
            (task, key, now_iso),
        )
        await db.commit()


async def cursor_mark_done(task: str, key: str, cursor: str = "") -> None:
    """处理成功：清零 fail_count，状态置 done。"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO crawl_cursor(task, key, cursor, status, fail_count, last_run_at, last_error) "
            "VALUES (?, ?, ?, 'done', 0, ?, '') "
            "ON CONFLICT(task, key) DO UPDATE SET "
            "  cursor=excluded.cursor, status='done', fail_count=0, "
            "  last_run_at=excluded.last_run_at, last_error=''",
            (task, key, cursor, now_iso),
        )
        await db.commit()


async def cursor_mark_failed(task: str, key: str, error: str = "") -> int:
    """处理失败：fail_count +1，返回新值（调用方可据此熔断）。"""
    now_iso = datetime.now().isoformat(timespec="seconds")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO crawl_cursor(task, key, status, fail_count, last_run_at, last_error) "
            "VALUES (?, ?, 'failed', 1, ?, ?) "
            "ON CONFLICT(task, key) DO UPDATE SET "
            "  status='failed', fail_count=fail_count+1, "
            "  last_run_at=excluded.last_run_at, last_error=excluded.last_error",
            (task, key, now_iso, (error or "")[:500]),
        )
        await db.commit()
        async with db.execute(
            "SELECT fail_count FROM crawl_cursor WHERE task=? AND key=?", (task, key),
        ) as cur:
            row = await cur.fetchone()
            return int(row[0]) if row else 1


async def cursor_get(task: str, key: str) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM crawl_cursor WHERE task=? AND key=?", (task, key),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def cursor_sort_by_last_run(
    task: str, candidate_keys: List[str], skip_failing_above: int = 5,
) -> List[str]:
    """把待处理 keys 按"上次跑得最早"排前。
    新的 key（cursor 表里没有）排最前，让新加入的项目先跑。
    fail_count >= skip_failing_above 的项目排到队尾（熔断降权）。
    """
    if not candidate_keys:
        return []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        placeholders = ",".join("?" * len(candidate_keys))
        async with db.execute(
            f"SELECT key, COALESCE(last_run_at,'') AS last_run_at, "
            f"       COALESCE(fail_count, 0) AS fail_count "
            f"  FROM crawl_cursor WHERE task=? AND key IN ({placeholders})",
            (task, *candidate_keys),
        ) as cur:
            existing = {r["key"]: dict(r) for r in await cur.fetchall()}

    # 排序键：(熔断降权, last_run_at)；不存在的当作最早（''）
    def _sort_key(k: str):
        info = existing.get(k)
        if not info:
            return (0, "")  # 新 key，最高优先
        burned = 1 if info["fail_count"] >= skip_failing_above else 0
        return (burned, info["last_run_at"])

    return sorted(candidate_keys, key=_sort_key)
