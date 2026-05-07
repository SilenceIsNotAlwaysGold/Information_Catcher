# -*- coding: utf-8 -*-
"""飞书网页应用 OAuth（v2）。

流程：
  1. build_authorize_url → 用户跳转飞书授权页扫码同意
  2. 飞书 302 回调到 redirect_uri?code=xxx&state=xxx
  3. exchange_code → 用 code 换 user_access_token + refresh_token + open_id
  4. 后续可调 refresh_token 续期；access_token ~2h，refresh_token ~30d

文档：
  https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Tuple
from urllib.parse import urlencode

import httpx

from .. import monitor_db
from .client import FEISHU_API, FeishuApiError, _read_app_credentials

logger = logging.getLogger(__name__)

# 飞书账号子域名（OAuth authorize 必须用这个域，不是 open.feishu.cn）
_AUTHORIZE_BASE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
_TOKEN_PATH = "/authen/v2/oauth/token"
_USER_INFO_PATH = "/authen/v1/user_info"


async def build_authorize_url(redirect_uri: str, state: str, scope: str = "") -> str:
    """生成飞书授权页 URL（用户在浏览器里访问）。

    redirect_uri 必须与开放平台后台「重定向 URL」白名单完全一致（含协议 / 端口）。
    state 用于 CSRF 防御 + 关联当前后端 session（推荐传 user_id 的 hmac）。
    scope 留空时拿到默认 scope；需要操作其他用户表格/通讯录时按需声明。
    """
    app_id, _ = await _read_app_credentials()
    params: Dict[str, str] = {
        "app_id": app_id,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    if scope:
        params["scope"] = scope
    return f"{_AUTHORIZE_BASE}?{urlencode(params)}"


async def exchange_code(code: str, redirect_uri: str) -> Dict[str, Any]:
    """用 code 换 user_access_token / refresh_token / open_id。

    返回 dict 字段（v2 OAuth）：
      - access_token, refresh_token, expires_in, refresh_token_expires_in,
        open_id, token_type, scope
    """
    app_id, app_secret = await _read_app_credentials()
    payload = {
        "grant_type": "authorization_code",
        "client_id": app_id,
        "client_secret": app_secret,
        "code": code,
        "redirect_uri": redirect_uri,
    }
    async with httpx.AsyncClient(timeout=15) as cli:
        resp = await cli.post(
            f"{FEISHU_API}{_TOKEN_PATH}",
            json=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            data = resp.json()
        except Exception:
            raise FeishuApiError(
                resp.status_code, f"OAuth 返回非 JSON：{resp.text[:200]}"
            )
    code_val = data.get("code", -1)
    if code_val != 0:
        raise FeishuApiError(code_val, data.get("error_description") or data.get("msg") or "code 换 token 失败", data)
    # v2 把字段平铺在顶层（和旧版 v1 不同）
    if not data.get("access_token"):
        raise FeishuApiError(-1, "OAuth 响应缺少 access_token", data)
    return data


async def refresh_access_token(refresh_token: str) -> Dict[str, Any]:
    """用 refresh_token 换新的 access_token。"""
    app_id, app_secret = await _read_app_credentials()
    payload = {
        "grant_type": "refresh_token",
        "client_id": app_id,
        "client_secret": app_secret,
        "refresh_token": refresh_token,
    }
    async with httpx.AsyncClient(timeout=15) as cli:
        resp = await cli.post(
            f"{FEISHU_API}{_TOKEN_PATH}",
            json=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            data = resp.json()
        except Exception:
            raise FeishuApiError(
                resp.status_code, f"refresh 返回非 JSON：{resp.text[:200]}"
            )
    code_val = data.get("code", -1)
    if code_val != 0:
        raise FeishuApiError(code_val, data.get("error_description") or data.get("msg") or "refresh_token 失败", data)
    if not data.get("access_token"):
        raise FeishuApiError(-1, "refresh 响应缺少 access_token", data)
    return data


async def get_user_info(user_access_token: str) -> Dict[str, Any]:
    """拉当前用户的飞书基本信息（name / open_id / avatar_url 等）。

    需要传用户 access_token（不是 tenant_access_token）。
    """
    async with httpx.AsyncClient(timeout=10) as cli:
        resp = await cli.get(
            f"{FEISHU_API}{_USER_INFO_PATH}",
            headers={"Authorization": f"Bearer {user_access_token}"},
        )
        try:
            data = resp.json()
        except Exception:
            raise FeishuApiError(
                resp.status_code, f"user_info 返回非 JSON：{resp.text[:200]}"
            )
    if data.get("code") != 0:
        raise FeishuApiError(data.get("code", -1), data.get("msg") or "user_info 失败", data)
    return data.get("data") or {}


def calc_expires_at(expires_in: int) -> str:
    """把 expires_in（秒）转成 ISO8601 字符串（绝对时间），方便存 DB。"""
    from datetime import datetime, timezone
    return datetime.fromtimestamp(time.time() + max(0, int(expires_in)), tz=timezone.utc).isoformat()
