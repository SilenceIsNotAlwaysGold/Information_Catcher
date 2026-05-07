# -*- coding: utf-8 -*-
"""飞书多维表格（Bitable）：创建 app / 建 table / 写记录 / 分享。

文档：
  https://open.feishu.cn/document/server-docs/docs/bitable-v1/app/create
  https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/create
  https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
  https://open.feishu.cn/document/server-docs/docs/permission/permission-member/create

所有操作走 tenant_access_token（应用身份）。app 创建成功后机器人就是文档拥有者，
分享给用户用 /drive/v1/permissions/{token}/members 把用户加成协作者。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .client import FeishuApiError, get, post

logger = logging.getLogger(__name__)


# ── 字段类型常量（飞书 schema） ──────────────────────────────────────────────

FIELD_TEXT = 1          # 多行文本
FIELD_NUMBER = 2        # 数字
FIELD_RADIO = 3         # 单选
FIELD_DATETIME = 5      # 日期时间
FIELD_CHECKBOX = 7      # 复选框
FIELD_PERSON = 11       # 人员
FIELD_URL = 15          # 超链接
FIELD_ATTACHMENT = 17   # 附件
FIELD_CREATED_AT = 1001
FIELD_MODIFIED_AT = 1002


# ── 创建 app ────────────────────────────────────────────────────────────────

async def create_app(
    name: str,
    folder_token: str = "",
    *,
    time_zone: str = "Asia/Shanghai",
) -> Dict[str, Any]:
    """在指定文件夹下创建一个多维表格 app。

    folder_token 为空时建在机器人个人空间根目录。
    返回 dict 含 app_token / name / url / folder_token / time_zone 等。
    """
    payload: Dict[str, Any] = {"name": name, "time_zone": time_zone}
    if folder_token:
        payload["folder_token"] = folder_token

    data = await post("/bitable/v1/apps", json=payload)
    app = (data.get("data") or {}).get("app") or {}
    if not app.get("app_token"):
        raise FeishuApiError(-1, f"create_app 响应缺少 app_token：{data}")
    return app


# ── 建 table（含字段） ──────────────────────────────────────────────────────

async def create_table(
    app_token: str,
    name: str,
    fields: List[Dict[str, Any]],
    *,
    default_view_name: str = "默认视图",
) -> Dict[str, Any]:
    """在 app 下建一张 table。

    fields 元素示例：
      {"field_name": "标题", "type": FIELD_TEXT}
      {"field_name": "点赞数", "type": FIELD_NUMBER}
      {"field_name": "URL", "type": FIELD_URL}

    返回 dict 含 table_id / default_view_id / field_id_list。
    """
    payload = {
        "table": {
            "name": name,
            "default_view_name": default_view_name,
            "fields": fields,
        }
    }
    data = await post(f"/bitable/v1/apps/{app_token}/tables", json=payload)
    inner = data.get("data") or {}
    table_id = inner.get("table_id") or ""
    if not table_id:
        raise FeishuApiError(-1, f"create_table 响应缺少 table_id：{data}")
    return inner


# ── 写记录 ──────────────────────────────────────────────────────────────────

async def add_record(
    app_token: str,
    table_id: str,
    fields: Dict[str, Any],
) -> Dict[str, Any]:
    """写入单条记录。fields 的 key 是字段名（中文 OK），value 按字段类型给：
      text/url：字符串
      number：int / float
      datetime：毫秒时间戳 int
      attachment：[{file_token: ...}]
      url 字段：{"link": "...", "text": "..."} 或字符串
    """
    data = await post(
        f"/bitable/v1/apps/{app_token}/tables/{table_id}/records",
        json={"fields": fields},
    )
    return (data.get("data") or {}).get("record") or {}


async def list_field_names(app_token: str, table_id: str) -> List[str]:
    data = await get(f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields")
    items = (data.get("data") or {}).get("items") or []
    return [it.get("field_name") for it in items if it.get("field_name")]


async def ensure_field(
    app_token: str,
    table_id: str,
    field_name: str,
    field_type: int,
) -> None:
    """已存在则跳过；否则创建。"""
    existing = set(await list_field_names(app_token, table_id))
    if field_name in existing:
        return
    await post(
        f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields",
        json={"field_name": field_name, "type": field_type},
    )


# ── 分享给用户 ──────────────────────────────────────────────────────────────

async def resolve_target(
    current_user: Optional[Dict[str, Any]],
    kind: str,  # "image" | "trending"
) -> Dict[str, str]:
    """决定写哪个 bitable：优先用户级（OAuth 自动建的），缺失时 fallback 全局。

    返回 {"app_token": "", "table_id": "", "source": "user"|"global"|"none"}。
    source=="none" 时调用方应跳过同步并提示用户去绑定。
    """
    from .. import monitor_db

    user_app = (current_user or {}).get("feishu_bitable_app_token", "") if current_user else ""
    user_tid = ""
    if current_user:
        if kind == "image":
            user_tid = current_user.get("feishu_bitable_image_table_id", "") or ""
        elif kind == "trending":
            user_tid = current_user.get("feishu_bitable_trending_table_id", "") or ""

    if user_app and user_tid:
        return {"app_token": user_app, "table_id": user_tid, "source": "user"}

    # 全局兜底（admin 配的）
    settings = await monitor_db.get_all_settings()
    g_app = settings.get("feishu_bitable_app_token", "") or ""
    if kind == "image":
        g_tid = settings.get("feishu_bitable_image_table_id", "") or ""
    else:
        g_tid = settings.get("feishu_bitable_table_id", "") or ""

    if g_app and g_tid:
        return {"app_token": g_app, "table_id": g_tid, "source": "global"}
    return {"app_token": "", "table_id": "", "source": "none"}


async def share_app_with_user(
    app_token: str,
    open_id: str,
    *,
    perm: str = "edit",
) -> Dict[str, Any]:
    """把 bitable app 分享给指定用户（按 open_id），perm: view / edit / full_access。"""
    if not open_id:
        return {}
    data = await post(
        f"/drive/v1/permissions/{app_token}/members",
        params={"type": "bitable", "need_notification": "false"},
        json={
            "member_type": "openid",
            "member_id": open_id,
            "perm": perm,
        },
    )
    return data.get("data") or {}


# ── 推荐字段集（image / trending 表的标准 schema） ──────────────────────────

# 字段名与现有全局 sync 代码保持一致，避免双套字段名维护
IMAGE_TABLE_FIELDS: List[Dict[str, Any]] = [
    {"field_name": "Prompt",   "type": FIELD_TEXT},
    {"field_name": "图片",     "type": FIELD_URL},
    {"field_name": "尺寸",     "type": FIELD_TEXT},
    {"field_name": "模型",     "type": FIELD_TEXT},
    {"field_name": "套号",     "type": FIELD_NUMBER},
    {"field_name": "套内序号", "type": FIELD_NUMBER},
    {"field_name": "来源链接", "type": FIELD_URL},
    {"field_name": "来源标题", "type": FIELD_TEXT},
    {"field_name": "生成时间", "type": FIELD_TEXT},
]

TRENDING_TABLE_FIELDS: List[Dict[str, Any]] = [
    {"field_name": "关键词",   "type": FIELD_TEXT},
    {"field_name": "标题",     "type": FIELD_TEXT},
    {"field_name": "原文",     "type": FIELD_TEXT},
    {"field_name": "改写文案", "type": FIELD_TEXT},
    {"field_name": "点赞数",   "type": FIELD_NUMBER},
    {"field_name": "收藏数",   "type": FIELD_NUMBER},
    {"field_name": "帖子链接", "type": FIELD_URL},
    {"field_name": "作者",     "type": FIELD_TEXT},
]
