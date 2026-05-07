# -*- coding: utf-8 -*-
"""飞书开放平台 HTTP 客户端 + tenant_access_token 缓存。

所有飞书 API 都以 https://open.feishu.cn/open-apis 为前缀。tenant_access_token
有效期 ~2h，进程内缓存到过期前 5 分钟即可。"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional, Tuple

import httpx

from .. import monitor_db

logger = logging.getLogger(__name__)

FEISHU_API = "https://open.feishu.cn/open-apis"

# (token, expires_at_epoch) — 进程内单例
_tenant_token_cache: Tuple[str, float] = ("", 0.0)


class FeishuApiError(Exception):
    """飞书开放平台返回 code != 0 时抛出。"""

    def __init__(self, code: int, msg: str, raw: Optional[dict] = None):
        self.code = code
        self.msg = msg
        self.raw = raw or {}
        super().__init__(f"[feishu] code={code} msg={msg}")


async def _read_app_credentials() -> Tuple[str, str]:
    app_id = (await monitor_db.get_setting("feishu_app_id", "")).strip()
    app_secret = (await monitor_db.get_setting("feishu_app_secret", "")).strip()
    if not app_id or not app_secret:
        raise FeishuApiError(
            -1, "飞书 app_id / app_secret 未配置（请在管理员设置页填写）"
        )
    return app_id, app_secret


async def get_tenant_token(force_refresh: bool = False) -> str:
    """获取 tenant_access_token，进程内缓存到过期前 5 分钟。"""
    global _tenant_token_cache
    now = time.time()
    token, exp = _tenant_token_cache
    if token and not force_refresh and now < exp:
        return token

    app_id, app_secret = await _read_app_credentials()
    async with httpx.AsyncClient(timeout=10) as cli:
        resp = await cli.post(
            f"{FEISHU_API}/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
        data = resp.json() if resp.content else {}
    token = (data or {}).get("tenant_access_token") or ""
    expire_in = int((data or {}).get("expire") or 7200)
    if not token:
        raise FeishuApiError(
            (data or {}).get("code", -1),
            (data or {}).get("msg", "tenant_access_token 获取失败"),
            data,
        )
    # 提前 5 分钟过期，避免边界
    _tenant_token_cache = (token, now + max(expire_in - 300, 60))
    return token


def _bearer_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }


async def _request(
    method: str,
    path: str,
    *,
    token: Optional[str] = None,
    use_tenant: bool = True,
    json: Optional[dict] = None,
    params: Optional[dict] = None,
    timeout: float = 15.0,
) -> Dict[str, Any]:
    """统一 HTTP 调用：自动取 token、统一错误处理。

    `token` 优先级：
      - 显式传入（常用于 user_access_token 场景）
      - use_tenant=True 时自动取缓存里的 tenant_access_token
    """
    if token is None and use_tenant:
        token = await get_tenant_token()
    headers = _bearer_headers(token or "") if token else {"Content-Type": "application/json; charset=utf-8"}
    url = f"{FEISHU_API}{path}"
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.request(method, url, headers=headers, json=json, params=params)
        try:
            data = resp.json()
        except Exception:
            raise FeishuApiError(
                resp.status_code, f"飞书返回非 JSON：{resp.text[:200]}", None
            )
    code = data.get("code", -1)
    if code != 0:
        # tenant_access_token 失效（99991663 等）→ 清缓存让下次重取
        if code in (99991663, 99991664, 99991665):
            global _tenant_token_cache
            _tenant_token_cache = ("", 0.0)
        raise FeishuApiError(code, data.get("msg") or f"HTTP {resp.status_code}", data)
    return data


async def post(path: str, *, json: Optional[dict] = None, token: Optional[str] = None,
               use_tenant: bool = True, params: Optional[dict] = None,
               timeout: float = 15.0) -> Dict[str, Any]:
    return await _request("POST", path, token=token, use_tenant=use_tenant,
                          json=json, params=params, timeout=timeout)


async def get(path: str, *, params: Optional[dict] = None, token: Optional[str] = None,
              use_tenant: bool = True, timeout: float = 15.0) -> Dict[str, Any]:
    return await _request("GET", path, token=token, use_tenant=use_tenant,
                          params=params, timeout=timeout)
