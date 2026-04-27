import httpx
import logging
from typing import Dict, List

logger = logging.getLogger(__name__)

_FEISHU_API = "https://open.feishu.cn/open-apis"

# Field type codes used by Feishu Bitable's create-field API.
# https://open.feishu.cn/document/uAjLw4CM/ugTN0YjL4UDN24CO1QjN/bitable-overview/field-type
_FIELD_TYPES = {
    "text":   1,   # 多行文本
    "number": 2,   # 数字
    "url":    15,  # 超链接
}


class FeishuApiError(Exception):
    """Raised when Feishu open-API returns a non-zero code."""


async def _get_tenant_token(app_id: str, app_secret: str) -> str:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{_FEISHU_API}/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
        data = resp.json()
        token = data.get("tenant_access_token") or ""
        if not token:
            raise FeishuApiError(
                f"获取 tenant_access_token 失败: code={data.get('code')} msg={data.get('msg')}"
            )
        return token


async def _list_field_names(token: str, app_token: str, table_id: str) -> List[str]:
    url = f"{_FEISHU_API}/bitable/v1/apps/{app_token}/tables/{table_id}/fields"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        data = resp.json()
        if data.get("code") != 0:
            raise FeishuApiError(f"列出字段失败 (code={data.get('code')}): {data.get('msg')}")
        items = (data.get("data") or {}).get("items") or []
        return [it.get("field_name", "") for it in items if it.get("field_name")]


async def _create_field(token: str, app_token: str, table_id: str, name: str, field_type: int) -> None:
    url = f"{_FEISHU_API}/bitable/v1/apps/{app_token}/tables/{table_id}/fields"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"field_name": name, "type": field_type},
        )
        data = resp.json()
        if data.get("code") != 0:
            raise FeishuApiError(
                f"创建字段「{name}」失败 (code={data.get('code')}): {data.get('msg')}"
            )


async def ensure_fields(
    app_id: str,
    app_secret: str,
    app_token: str,
    table_id: str,
    fields: Dict[str, str],
) -> None:
    """Ensure each name in `fields` exists in the table; create the missing ones.

    `fields` maps field_name → friendly type ('text' | 'number' | 'url').
    """
    if not all([app_id, app_secret, app_token, table_id]):
        raise FeishuApiError("飞书配置不完整")
    token = await _get_tenant_token(app_id, app_secret)
    existing = set(await _list_field_names(token, app_token, table_id))
    for name, ftype in fields.items():
        if name in existing:
            continue
        code = _FIELD_TYPES.get(ftype, 1)
        logger.info(f"[feishu_bitable] creating missing field: {name} (type={ftype})")
        await _create_field(token, app_token, table_id, name, code)


async def add_record(
    app_id: str,
    app_secret: str,
    app_token: str,
    table_id: str,
    fields: Dict,
) -> bool:
    """Add one record to a Feishu Bitable table.

    Raises FeishuApiError on any failure (missing config, auth failure, missing
    permission, etc.). The caller is responsible for translating that into a
    user-visible error message.
    """
    if not all([app_id, app_secret, app_token, table_id]):
        raise FeishuApiError("飞书配置不完整（app_id / app_secret / app_token / table_id）")

    token = await _get_tenant_token(app_id, app_secret)

    url = f"{_FEISHU_API}/bitable/v1/apps/{app_token}/tables/{table_id}/records"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json={"fields": fields}, headers=headers)
        data = resp.json()
        if data.get("code") != 0:
            code = data.get("code")
            msg = data.get("msg") or "未知错误"
            logger.error(f"[feishu_bitable] add record failed: {data}")
            # Friendly hints for the most common feishu errors users hit here.
            hint = {
                99991672: "应用没开通 bitable:app 应用身份权限。去飞书开放平台 → 权限管理 → 筛选「应用身份」搜 bitable:app 开通。",
                91403:    "应用未被加为多维表格协作者。打开目标多维表格 → 分享 → 把这个应用加为可编辑/可管理协作者。",
                91402:    "找不到表格。检查 feishu_bitable_app_token 和 feishu_bitable_table_id 是否填错。",
                1254005:  "字段不存在。多维表格里要预先创建字段：关键词 / 标题 / 原文 / 改写文案 / 点赞数 / 收藏数 / 帖子链接 / 作者。",
            }.get(code)
            tail = f"｜{hint}" if hint else ""
            raise FeishuApiError(f"飞书 API 失败 (code={code}): {msg.split('点击链接')[0].strip()}{tail}")
        return True
