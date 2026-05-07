# -*- coding: utf-8 -*-
"""
认证服务模块

提供用户认证相关功能，包括：
- SQLite用户数据库管理
- 密码哈希与验证
- JWT Token生成与验证
- 用户CRUD操作
"""

import os
import sqlite3
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional
from pathlib import Path

# JWT配置
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24小时

# 数据库路径
DB_PATH = Path(__file__).parent.parent.parent / "database" / "users.db"

_SECRET_KEY_FILE = DB_PATH.parent / ".jwt_secret"


def _load_secret_key() -> str:
    env_key = os.getenv("JWT_SECRET_KEY")
    if env_key:
        return env_key
    _SECRET_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    if _SECRET_KEY_FILE.exists():
        key = _SECRET_KEY_FILE.read_text().strip()
        if key:
            return key
    key = secrets.token_hex(32)
    _SECRET_KEY_FILE.write_text(key)
    return key


SECRET_KEY = _load_secret_key()


def _get_db_connection() -> sqlite3.Connection:
    """获取数据库连接"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_column(cursor, table: str, col: str, coldef: str):
    cursor.execute(f"PRAGMA table_info({table})")
    cols = [r["name"] for r in cursor.fetchall()]
    if col not in cols:
        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coldef}")


def init_user_db():
    """
    初始化用户数据库 (SaaS 多租户)

    - users 表新增字段: email, plan, trial_ends_at, role
    - 内置 admin 账号 admin/admin123 自动升级为 role='admin'
    """
    conn = _get_db_connection()
    cursor = conn.cursor()

    # 基础表结构
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # SaaS 字段：email、套餐、试用截止、角色
    _ensure_column(cursor, "users", "email",          "TEXT")
    _ensure_column(cursor, "users", "plan",           "TEXT DEFAULT 'trial'")
    _ensure_column(cursor, "users", "trial_ends_at",  "TEXT")
    _ensure_column(cursor, "users", "role",           "TEXT DEFAULT 'user'")
    # 多租户 webhook：每个用户独立配置自己的推送渠道
    _ensure_column(cursor, "users", "feishu_webhook_url", "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "wecom_webhook_url",  "TEXT DEFAULT ''")
    # 配额：监控帖子上限（trial=50, team=500, enterprise=10000；admin/老用户走默认 200）
    _ensure_column(cursor, "users", "max_monitor_posts", "INTEGER DEFAULT 200")
    # 公众号客户端凭证（手动从微信抓包获取，~30 分钟过期需用户刷新）
    # 用户在「公众号设置」页面提供，仅自己可见可改
    _ensure_column(cursor, "users", "mp_auth_uin",          "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "mp_auth_key",          "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "mp_auth_pass_ticket",  "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "mp_auth_appmsg_token", "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "mp_auth_at",           "TEXT")

    # 飞书 OAuth 自动绑定（每个用户独立的群 + 多维表格）
    # access_token 约 2h 过期，refresh_token 约 30 天；30 天内静默 refresh，超期需重新 OAuth
    _ensure_column(cursor, "users", "feishu_open_id",                   "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_user_access_token",         "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_refresh_token",             "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_token_expires_at",          "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_chat_id",                   "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_bitable_app_token",         "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_bitable_image_table_id",    "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_bitable_trending_table_id", "TEXT DEFAULT ''")
    _ensure_column(cursor, "users", "feishu_bound_at",                  "TEXT DEFAULT ''")
    # 飞书显示名（绑定时从 user_info 拉一次缓存，前端展示用）
    _ensure_column(cursor, "users", "feishu_name",                      "TEXT DEFAULT ''")

    # email 唯一索引（NULL 允许多个）
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email "
        "ON users(email) WHERE email IS NOT NULL"
    )

    # 内置 admin 账号
    cursor.execute("SELECT id, role FROM users WHERE username = ?", ("admin",))
    row = cursor.fetchone()
    if not row:
        cursor.execute(
            "INSERT INTO users (username, password_hash, role, plan) "
            "VALUES (?, ?, 'admin', 'team')",
            ("admin", hash_password("admin123"))
        )
        print("[Auth] 已创建默认管理员账号: admin / admin123 (role=admin)")
    elif row["role"] != "admin":
        cursor.execute(
            "UPDATE users SET role='admin', plan='team' WHERE id=?",
            (row["id"],)
        )
        print("[Auth] admin 账号已升级为 role=admin")

    conn.commit()
    conn.close()


def register_user(email: str, password: str, username: Optional[str] = None) -> Optional[dict]:
    """
    新用户注册：创建账号 + 自动开 7 天试用。

    返回新用户的简短信息，username 冲突时返回 None。
    """
    conn = _get_db_connection()
    cursor = conn.cursor()
    try:
        username = username or email
        trial_end = (datetime.utcnow() + timedelta(days=7)).isoformat()
        cursor.execute(
            "INSERT INTO users (username, email, password_hash, plan, trial_ends_at, role) "
            "VALUES (?, ?, ?, 'trial', ?, 'user')",
            (username, email, hash_password(password), trial_end),
        )
        conn.commit()
        uid = cursor.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        return None
    conn.close()
    return {"id": uid, "username": username, "email": email,
            "plan": "trial", "trial_ends_at": trial_end, "role": "user"}


def hash_password(password: str) -> str:
    """
    密码哈希
    
    使用SHA256 + 盐值对密码进行哈希处理
    """
    salt = "littlecrawler_salt_2026"
    return hashlib.sha256(f"{password}{salt}".encode()).hexdigest()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """验证密码"""
    return hash_password(plain_password) == hashed_password


def authenticate_user(login: str, password: str) -> Optional[dict]:
    """用户认证。`login` 既支持 username 也支持 email。"""
    conn = _get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, email, password_hash, is_active, plan, trial_ends_at, role "
        "FROM users WHERE username = ? OR email = ?",
        (login, login)
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    if not verify_password(password, row["password_hash"]):
        return None
    if not row["is_active"]:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "is_active": bool(row["is_active"]),
        "plan": row["plan"] or "trial",
        "trial_ends_at": row["trial_ends_at"],
        "role": row["role"] or "user",
    }


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    创建访问Token
    
    使用简单的base64编码 + 签名方式生成Token
    """
    import base64
    import json
    import hmac
    
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire.isoformat()})
    
    # 编码payload
    payload = base64.urlsafe_b64encode(json.dumps(to_encode).encode()).decode()
    
    # 生成签名
    signature = hmac.new(
        SECRET_KEY.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()[:32]
    
    return f"{payload}.{signature}"


def verify_token(token: str) -> Optional[dict]:
    """
    验证Token
    
    解析并验证Token，返回payload或None
    """
    import base64
    import json
    import hmac
    
    try:
        parts = token.split(".")
        if len(parts) != 2:
            return None
        
        payload_b64, signature = parts
        
        # 验证签名
        expected_signature = hmac.new(
            SECRET_KEY.encode(),
            payload_b64.encode(),
            hashlib.sha256
        ).hexdigest()[:32]
        
        if signature != expected_signature:
            return None
        
        # 解码payload
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode()))
        
        # 验证过期时间
        exp = datetime.fromisoformat(payload["exp"])
        if datetime.utcnow() > exp:
            return None
        
        return payload
    except Exception:
        return None


def get_user_by_id(user_id: int) -> Optional[dict]:
    """根据ID获取用户信息（含 SaaS 字段 + webhook 配置）"""
    conn = _get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, email, is_active, plan, trial_ends_at, role, "
        "       COALESCE(feishu_webhook_url,'') AS feishu_webhook_url, "
        "       COALESCE(wecom_webhook_url,'')  AS wecom_webhook_url, "
        "       COALESCE(max_monitor_posts, 200) AS max_monitor_posts, "
        "       COALESCE(mp_auth_uin,'')          AS mp_auth_uin, "
        "       COALESCE(mp_auth_key,'')          AS mp_auth_key, "
        "       COALESCE(mp_auth_pass_ticket,'')  AS mp_auth_pass_ticket, "
        "       COALESCE(mp_auth_appmsg_token,'') AS mp_auth_appmsg_token, "
        "       mp_auth_at, "
        "       COALESCE(feishu_open_id,'')                   AS feishu_open_id, "
        "       COALESCE(feishu_user_access_token,'')         AS feishu_user_access_token, "
        "       COALESCE(feishu_refresh_token,'')             AS feishu_refresh_token, "
        "       COALESCE(feishu_token_expires_at,'')          AS feishu_token_expires_at, "
        "       COALESCE(feishu_chat_id,'')                   AS feishu_chat_id, "
        "       COALESCE(feishu_bitable_app_token,'')         AS feishu_bitable_app_token, "
        "       COALESCE(feishu_bitable_image_table_id,'')    AS feishu_bitable_image_table_id, "
        "       COALESCE(feishu_bitable_trending_table_id,'') AS feishu_bitable_trending_table_id, "
        "       COALESCE(feishu_bound_at,'')                  AS feishu_bound_at, "
        "       COALESCE(feishu_name,'')                      AS feishu_name "
        "FROM users WHERE id = ?",
        (user_id,)
    )
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "is_active": bool(row["is_active"]),
        "plan": row["plan"] or "trial",
        "trial_ends_at": row["trial_ends_at"],
        "role": row["role"] or "user",
        "feishu_webhook_url": row["feishu_webhook_url"] or "",
        "wecom_webhook_url":  row["wecom_webhook_url"]  or "",
        "max_monitor_posts": int(row["max_monitor_posts"] or 200),
        "mp_auth_uin":          row["mp_auth_uin"] or "",
        "mp_auth_key":          row["mp_auth_key"] or "",
        "mp_auth_pass_ticket":  row["mp_auth_pass_ticket"] or "",
        "mp_auth_appmsg_token": row["mp_auth_appmsg_token"] or "",
        "mp_auth_at": row["mp_auth_at"],
        "feishu_open_id":                   row["feishu_open_id"] or "",
        "feishu_user_access_token":         row["feishu_user_access_token"] or "",
        "feishu_refresh_token":             row["feishu_refresh_token"] or "",
        "feishu_token_expires_at":          row["feishu_token_expires_at"] or "",
        "feishu_chat_id":                   row["feishu_chat_id"] or "",
        "feishu_bitable_app_token":         row["feishu_bitable_app_token"] or "",
        "feishu_bitable_image_table_id":    row["feishu_bitable_image_table_id"] or "",
        "feishu_bitable_trending_table_id": row["feishu_bitable_trending_table_id"] or "",
        "feishu_bound_at":                  row["feishu_bound_at"] or "",
        "feishu_name":                      row["feishu_name"] or "",
    }


def update_user_mp_auth(
    user_id: int,
    uin: Optional[str] = None,
    key: Optional[str] = None,
    pass_ticket: Optional[str] = None,
    appmsg_token: Optional[str] = None,
) -> None:
    """用户更新自己的公众号客户端凭证。"""
    fields, values = [], []
    if uin is not None:
        fields.append("mp_auth_uin = ?"); values.append(uin)
    if key is not None:
        fields.append("mp_auth_key = ?"); values.append(key)
    if pass_ticket is not None:
        fields.append("mp_auth_pass_ticket = ?"); values.append(pass_ticket)
    if appmsg_token is not None:
        fields.append("mp_auth_appmsg_token = ?"); values.append(appmsg_token)
    if not fields:
        return
    fields.append("mp_auth_at = datetime('now', 'localtime')")
    values.append(user_id)
    conn = _get_db_connection()
    cur = conn.cursor()
    cur.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    conn.close()


def update_user_webhooks(
    user_id: int,
    feishu_webhook_url: Optional[str] = None,
    wecom_webhook_url: Optional[str] = None,
) -> None:
    """用户更新自己的推送渠道。"""
    fields, values = [], []
    if feishu_webhook_url is not None:
        fields.append("feishu_webhook_url = ?")
        values.append(feishu_webhook_url)
    if wecom_webhook_url is not None:
        fields.append("wecom_webhook_url = ?")
        values.append(wecom_webhook_url)
    if not fields:
        return
    values.append(user_id)
    conn = _get_db_connection()
    cursor = conn.cursor()
    cursor.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    conn.close()


def list_users() -> list:
    """管理员用：列出所有用户。"""
    conn = _get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, username, email, is_active, plan, trial_ends_at, role, "
        "       COALESCE(max_monitor_posts, 200) AS max_monitor_posts, created_at "
        "FROM users ORDER BY id DESC"
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_user_admin(user_id: int, **fields) -> bool:
    """管理员修改某个用户的 plan、is_active、role 等。"""
    allowed = {"plan", "is_active", "role", "trial_ends_at", "max_monitor_posts"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed and v is not None:
            sets.append(f"{k}=?"); vals.append(v)
    if not sets:
        return False
    vals.append(user_id)
    conn = _get_db_connection()
    cursor = conn.cursor()
    cursor.execute(f"UPDATE users SET {','.join(sets)} WHERE id=?", vals)
    conn.commit()
    conn.close()
    return True


# ── 飞书 OAuth 绑定 ─────────────────────────────────────────────────────────

# 允许 update_user_feishu 写入的字段白名单。chat_id / bitable_* 是 provisioning
# 阶段才会回填的字段，OAuth 回调阶段不会传。
_FEISHU_FIELDS = {
    "feishu_open_id",
    "feishu_user_access_token",
    "feishu_refresh_token",
    "feishu_token_expires_at",
    "feishu_chat_id",
    "feishu_bitable_app_token",
    "feishu_bitable_image_table_id",
    "feishu_bitable_trending_table_id",
    "feishu_bound_at",
    "feishu_name",
}


def update_user_feishu(user_id: int, **fields) -> bool:
    """更新某个用户的飞书绑定字段（OAuth 回调 / provisioning / 解绑共用）。

    传 None 不更新该字段；传空字符串则清空。
    """
    sets, vals = [], []
    for k, v in fields.items():
        if k in _FEISHU_FIELDS and v is not None:
            sets.append(f"{k}=?")
            vals.append(v)
    if not sets:
        return False
    vals.append(user_id)
    conn = _get_db_connection()
    cur = conn.cursor()
    cur.execute(f"UPDATE users SET {','.join(sets)} WHERE id=?", vals)
    conn.commit()
    conn.close()
    return True


def clear_user_feishu(user_id: int) -> None:
    """解绑飞书：清掉所有 feishu_* 字段（webhook_url 不动，作为兜底保留）。"""
    conn = _get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "UPDATE users SET "
        "feishu_open_id='', feishu_user_access_token='', feishu_refresh_token='', "
        "feishu_token_expires_at='', feishu_chat_id='', "
        "feishu_bitable_app_token='', feishu_bitable_image_table_id='', "
        "feishu_bitable_trending_table_id='', feishu_bound_at='', feishu_name='' "
        "WHERE id=?",
        (user_id,),
    )
    conn.commit()
    conn.close()


def create_user(username: str, password: str) -> Optional[dict]:
    """
    创建新用户
    
    返回创建的用户信息或None（用户名已存在）
    """
    conn = _get_db_connection()
    cursor = conn.cursor()
    
    try:
        password_hash = hash_password(password)
        cursor.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (username, password_hash)
        )
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        
        return {
            "id": user_id,
            "username": username,
            "is_active": True
        }
    except sqlite3.IntegrityError:
        conn.close()
        return None


# 启动时初始化数据库
init_user_db()
