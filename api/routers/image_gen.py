# -*- coding: utf-8 -*-
"""商品图生成：调第三方图像 API（OpenAI 兼容）。

路由前缀 /monitor/image。

配置 KV（写入 monitor_settings 表）：
- image_api_base_url
- image_api_key
- image_api_model
- image_api_size

端点：
- GET  /monitor/image/config        读取配置（不返回 api_key 明文）
- POST /monitor/image/config        保存配置（api_key 空串/None 时不覆盖旧值）
- POST /monitor/image/generate      调用 OpenAI 兼容 /images/generations 生成
"""
from __future__ import annotations

import logging
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .auth import get_current_user
from ..services import monitor_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/monitor/image", tags=["ImageGen"])


# ── Pydantic models ─────────────────────────────────────────────────────────

class SaveImageConfigRequest(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None  # 空字符串 / None 保留旧值
    model: Optional[str] = None
    size: Optional[str] = None


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = ""
    n: Optional[int] = 1  # 1-4
    size: Optional[str] = None  # 不填用配置默认


# ── Endpoints ───────────────────────────────────────────────────────────────

DEFAULT_SIZE = "1024x1024"


@router.get("/config", summary="读取图像 API 配置")
async def get_image_config(current_user: dict = Depends(get_current_user)) -> dict:
    base_url = await monitor_db.get_setting("image_api_base_url", "")
    model = await monitor_db.get_setting("image_api_model", "")
    size = await monitor_db.get_setting("image_api_size", DEFAULT_SIZE)
    api_key = await monitor_db.get_setting("image_api_key", "")
    return {
        "base_url": base_url,
        "model": model,
        "size": size or DEFAULT_SIZE,
        "has_key": bool(api_key),
    }


@router.post("/config", summary="保存图像 API 配置")
async def save_image_config(
    req: SaveImageConfigRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    if req.base_url is not None:
        await monitor_db.set_setting("image_api_base_url", req.base_url.strip())
    if req.model is not None:
        await monitor_db.set_setting("image_api_model", req.model.strip())
    if req.size is not None and req.size.strip():
        await monitor_db.set_setting("image_api_size", req.size.strip())
    # api_key：仅在非空时覆盖（空串 / None 保留旧值）
    if req.api_key is not None and req.api_key.strip():
        await monitor_db.set_setting("image_api_key", req.api_key.strip())
    return {"ok": True}


def _normalize_image_items(data: dict) -> List[dict]:
    """从 OpenAI 兼容响应里取 images 数组。

    返回形如 [{"b64": "..."}] 或 [{"url": "..."}] 的列表。
    """
    items: List[dict] = []
    raw = data.get("data") or []
    if isinstance(raw, list):
        for it in raw:
            if not isinstance(it, dict):
                continue
            b64 = it.get("b64_json") or it.get("b64")
            url = it.get("url")
            if b64:
                items.append({"b64": b64})
            elif url:
                items.append({"url": url})
    return items


@router.post("/generate", summary="调用第三方图像 API 生成图片")
async def generate_image(
    req: GenerateRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    # 读取配置
    base_url = (await monitor_db.get_setting("image_api_base_url", "")).strip()
    api_key = (await monitor_db.get_setting("image_api_key", "")).strip()
    model = (await monitor_db.get_setting("image_api_model", "")).strip()
    cfg_size = (await monitor_db.get_setting("image_api_size", DEFAULT_SIZE)).strip() or DEFAULT_SIZE

    if not base_url or not api_key or not model:
        return {"error": "图像 API 未配置（base_url / api_key / model 必填）", "status": 400}

    prompt = (req.prompt or "").strip()
    if not prompt:
        return {"error": "prompt 不能为空", "status": 400}

    # negative_prompt 拼到 prompt 末尾（OpenAI 兼容 API 多数不直接支持 negative_prompt 字段）
    neg = (req.negative_prompt or "").strip()
    final_prompt = prompt
    if neg:
        final_prompt = f"{prompt}\n\nNegative prompt: {neg}"

    n = max(1, min(int(req.n or 1), 4))
    size = (req.size or "").strip() or cfg_size

    payload = {
        "model": model,
        "prompt": final_prompt,
        "n": n,
        "size": size,
        "response_format": "b64_json",  # 优先 b64，URL 兜底
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = f"{base_url.rstrip('/')}/images/generations"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                # 尝试解析错误信息
                detail: str
                try:
                    body = resp.json()
                    detail = (
                        (body.get("error") or {}).get("message")
                        if isinstance(body.get("error"), dict)
                        else (body.get("message") or body.get("error") or resp.text)
                    ) or resp.text
                except Exception:
                    detail = resp.text or f"HTTP {resp.status_code}"
                logger.warning(f"[image_gen] upstream {resp.status_code}: {detail}")
                return {"error": f"上游接口错误：{detail}", "status": resp.status_code}
            data = resp.json()
    except httpx.TimeoutException:
        logger.warning("[image_gen] timeout")
        return {"error": "图像生成超时（60s），请稍后重试或换用更快的模型", "status": 504}
    except httpx.HTTPError as e:
        logger.warning(f"[image_gen] http error: {e}")
        return {"error": f"网络错误：{e}", "status": 502}
    except Exception as e:
        logger.exception(f"[image_gen] unexpected: {e}")
        return {"error": f"未知错误：{e}", "status": 500}

    images = _normalize_image_items(data)
    if not images:
        return {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return {"images": images}
