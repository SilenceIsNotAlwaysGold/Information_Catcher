import aiosqlite
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
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_enabled', '0');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_keywords', '');
INSERT OR IGNORE INTO monitor_settings VALUES ('trending_min_likes', '1000');
INSERT OR IGNORE INTO monitor_settings VALUES ('observe_use_cookie_fallback', '0');

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

CREATE TABLE IF NOT EXISTS rewrite_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
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
]


async def _table_columns(db, table: str) -> List[str]:
    async with db.execute(f"PRAGMA table_info({table})") as cur:
        return [row[1] for row in await cur.fetchall()]


async def _ensure_column(db, table: str, name: str, coldef: str):
    cols = await _table_columns(db, table)
    if name not in cols:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {coldef}")


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
    # post grouping: 'own' = my posts, 'observe' = others' posts
    await _ensure_column(db, "monitor_posts", "post_type", "TEXT DEFAULT 'observe'")
    # Track per-post fetch outcome so the UI can flag XHS-locked / deleted notes.
    # Values: ok | login_required | deleted | error | unknown
    await _ensure_column(db, "monitor_posts", "last_fetch_status", "TEXT DEFAULT 'unknown'")
    await _ensure_column(db, "monitor_posts", "last_fetch_at", "TEXT")
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


async def get_all_settings() -> Dict[str, str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM monitor_settings") as cur:
            return {r[0]: r[1] for r in await cur.fetchall()}


# ── Accounts ────────────────────────────────────────────────────────────────

_ACCOUNT_COLUMNS_SELECT = (
    "id, name, cookie, proxy_url, user_agent, viewport, timezone, locale, "
    "fp_browser_type, fp_profile_id, fp_api_url, created_at, is_active, "
    "cookie_status, cookie_checked_at"
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
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT INTO monitor_accounts
               (name, cookie, proxy_url, user_agent, viewport, timezone, locale,
                fp_browser_type, fp_profile_id, fp_api_url)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (name, cookie, proxy_url, user_agent, viewport, timezone or "Asia/Shanghai",
             locale or "zh-CN", fp_browser_type or "builtin", fp_profile_id, fp_api_url),
        )
        await db.commit()
        return cur.lastrowid


async def update_account(account_id: int, **fields) -> bool:
    allowed = {
        "name", "cookie", "proxy_url", "user_agent", "viewport", "timezone",
        "locale", "fp_browser_type", "fp_profile_id", "fp_api_url",
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


async def get_accounts(include_secrets: bool = False) -> List[Dict]:
    """Return active accounts. When include_secrets is False, cookie is omitted."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT {_ACCOUNT_COLUMNS_SELECT} FROM monitor_accounts WHERE is_active=1 ORDER BY id"
        ) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    if not include_secrets:
        for r in rows:
            r.pop("cookie", None)
    return rows


async def get_account(account_id: int) -> Optional[Dict]:
    """Full account record (including cookie) for the browser factory."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT {_ACCOUNT_COLUMNS_SELECT} FROM monitor_accounts WHERE id=?",
            (account_id,),
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def update_cookie_status(account_id: int, status: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_accounts SET cookie_status=?, "
            "cookie_checked_at=datetime('now', 'localtime') WHERE id=?",
            (status, account_id),
        )
        await db.commit()


async def get_account_cookie(account_id: int) -> Optional[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT cookie FROM monitor_accounts WHERE id=?", (account_id,)
        ) as cur:
            row = await cur.fetchone()
            return row[0] if row else None


async def delete_account(account_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
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
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """INSERT OR REPLACE INTO monitor_posts
               (note_id, title, short_url, note_url, xsec_token, xsec_source, account_id, post_type, is_active)
               VALUES (?,?,?,?,?,?,?,?,1)""",
            (note_id, title, short_url, note_url, xsec_token, xsec_source, account_id, post_type),
        )
        await db.commit()
        return cur.lastrowid


async def get_posts() -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT p.*,
                   a.name  AS account_name,
                   s.liked_count, s.collected_count, s.comment_count, s.share_count,
                   s.checked_at
            FROM monitor_posts p
            LEFT JOIN monitor_accounts a ON p.account_id = a.id
            LEFT JOIN (
                SELECT note_id, liked_count, collected_count, comment_count,
                       share_count, checked_at
                FROM monitor_snapshots
                WHERE id IN (SELECT MAX(id) FROM monitor_snapshots GROUP BY note_id)
            ) s ON p.note_id = s.note_id
            WHERE p.is_active = 1
            ORDER BY p.created_at DESC
        """) as cur:
            return [dict(r) for r in await cur.fetchall()]


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


async def delete_post(note_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
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


async def update_post_fetch_status(note_id: str, status: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE monitor_posts SET last_fetch_status=?, "
            "last_fetch_at=datetime('now', 'localtime') WHERE note_id=?",
            (status, note_id),
        )
        await db.commit()


async def save_alert(note_id: str, title: str, alert_type: str, message: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO monitor_alerts (note_id,title,alert_type,message) VALUES (?,?,?,?)",
            (note_id, title, alert_type, message),
        )
        await db.commit()


async def get_alerts(limit: int = 50) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM monitor_alerts ORDER BY created_at DESC LIMIT ?", (limit,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def clear_alerts() -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("DELETE FROM monitor_alerts")
        await db.commit()
        return cur.rowcount or 0


async def delete_alert(alert_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM monitor_alerts WHERE id=?", (alert_id,))
        await db.commit()


# ── Trending Posts ───────────────────────────────────────────────────────────

async def add_or_update_trending_post(
    note_id: str, title: str, desc_text: str, note_url: str,
    xsec_token: str, liked_count: int, collected_count: int,
    comment_count: int, keyword: str, author: str,
) -> bool:
    """Insert new trending post. Returns True if it was newly inserted."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT id FROM trending_posts WHERE note_id=?", (note_id,))
        exists = await cur.fetchone()
        if exists:
            # Backfill title/author when the existing row has them empty (older
            # rows captured before we knew the correct field paths).
            await db.execute(
                """UPDATE trending_posts
                   SET liked_count=?, collected_count=?, comment_count=?,
                       title    = CASE WHEN title    IS NULL OR title    = '' THEN ? ELSE title    END,
                       author   = CASE WHEN author   IS NULL OR author   = '' THEN ? ELSE author   END,
                       desc_text= CASE WHEN desc_text IS NULL OR desc_text= '' THEN ? ELSE desc_text END
                   WHERE note_id=?""",
                (liked_count, collected_count, comment_count, title, author, desc_text, note_id),
            )
            await db.commit()
            return False
        await db.execute(
            """INSERT INTO trending_posts
               (note_id,title,desc_text,note_url,xsec_token,liked_count,collected_count,comment_count,keyword,author)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (note_id, title, desc_text, note_url, xsec_token,
             liked_count, collected_count, comment_count, keyword, author),
        )
        await db.commit()
        return True


async def get_trending_posts(limit: int = 50) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM trending_posts ORDER BY found_at DESC LIMIT ?", (limit,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def update_trending_rewrite(note_id: str, rewritten_text: str, status: str = "done"):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE trending_posts SET rewritten_text=?,rewrite_status=? WHERE note_id=?",
            (rewritten_text, status, note_id),
        )
        await db.commit()


async def get_trending_post(note_id: str) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM trending_posts WHERE note_id=?", (note_id,)
        ) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def mark_trending_synced(note_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE trending_posts SET synced_to_bitable=1 WHERE note_id=?", (note_id,)
        )
        await db.commit()


async def get_unsynced_trending_posts() -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM trending_posts WHERE synced_to_bitable=0 AND rewrite_status='done'"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


# ── Rewrite Prompts ──────────────────────────────────────────────────────────

async def list_prompts() -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM rewrite_prompts ORDER BY is_default DESC, id"
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def get_prompt(prompt_id: int) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM rewrite_prompts WHERE id=?", (prompt_id,)
        ) as cur:
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


async def create_prompt(name: str, content: str) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO rewrite_prompts (name, content) VALUES (?, ?)",
            (name, content),
        )
        await db.commit()
        return cur.lastrowid


async def update_prompt(prompt_id: int, name: Optional[str] = None, content: Optional[str] = None) -> bool:
    fields, values = [], []
    if name is not None:
        fields.append("name=?"); values.append(name)
    if content is not None:
        fields.append("content=?"); values.append(content)
    if not fields:
        return False
    values.append(prompt_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE rewrite_prompts SET {','.join(fields)} WHERE id=?", values)
        await db.commit()
    return True


async def delete_prompt(prompt_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM rewrite_prompts WHERE id=?", (prompt_id,))
        await db.commit()


async def set_default_prompt(prompt_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE rewrite_prompts SET is_default=0")
        await db.execute("UPDATE rewrite_prompts SET is_default=1 WHERE id=?", (prompt_id,))
        await db.commit()


# ── Trending pending posts ───────────────────────────────────────────────────

async def get_pending_trending_posts() -> List[Dict]:
    """Trending posts that still need AI rewriting (status pending / failed / skipped)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM trending_posts WHERE rewrite_status IN ('pending','failed','skipped')"
        ) as cur:
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
