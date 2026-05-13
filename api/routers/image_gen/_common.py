# -*- coding: utf-8 -*-
"""image_gen 内部公用：上游 API 调用 + Pydantic 模型 + 工具。"""
from __future__ import annotations

import logging
from typing import List, Optional

import httpx
from pydantic import BaseModel

logger = logging.getLogger(__name__)

DEFAULT_SIZE = "1024x1024"

# 单批最大张数 4；gpt-image / dall-e 系列单次只能 n=1
_MAX_PER_BATCH_DEFAULT = 4
_SINGLE_IMAGE_MODELS = ("gpt-image", "dall-e-3", "dall-e-2", "wanx2", "cogview")

# /generate 单次请求总张数上限（防止误填超大数字一锅端打爆上游）
MAX_TOTAL = 60


def max_per_batch_for(model: str) -> int:
    m = (model or "").lower()
    for keyword in _SINGLE_IMAGE_MODELS:
        if keyword in m:
            return 1
    return _MAX_PER_BATCH_DEFAULT


def normalize_image_items(data: dict) -> List[dict]:
    items: List[dict] = []
    raw = data.get("data") or []
    if not isinstance(raw, list):
        return items
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


async def call_generations(
    client: httpx.AsyncClient, *, base_url: str, model: str, prompt: str,
    n: int, size: str, headers: dict,
) -> tuple[Optional[List[dict]], Optional[dict]]:
    """调上游 /images/generations 一次。返回 (images, error_dict)。"""
    gen_url = f"{base_url.rstrip('/')}/images/generations"
    try:
        resp = await client.post(
            gen_url,
            json={
                "model": model, "prompt": prompt, "n": n,
                "size": size, "response_format": "b64_json",
            },
            headers={**headers, "Content-Type": "application/json"},
        )
    except httpx.TimeoutException:
        return None, {"error": "图像生成超时（10min），请稍后重试", "status": 504}
    except httpx.HTTPError as e:
        return None, {"error": f"网络错误：{e}", "status": 502}

    if resp.status_code >= 400:
        try:
            err = (resp.json().get("error") or {})
            detail = (err.get("message") if isinstance(err, dict) else err) or resp.text
        except Exception:
            detail = resp.text or f"HTTP {resp.status_code}"
        logger.warning(f"[image_gen] upstream {resp.status_code}: {detail}")
        return None, {"error": f"上游接口错误：{detail}", "status": resp.status_code}

    ct = resp.headers.get("content-type", "")
    if "text/html" in ct or resp.text.lstrip().startswith("<!"):
        hint = "Base URL 末尾可能缺少 /v1" if "/v1" not in base_url else "请确认 Base URL 指向正确的图像生成服务"
        return None, {
            "error": f"上游返回了 HTML 页面而非 JSON（状态 {resp.status_code}）。{hint}。",
            "status": 502,
        }
    try:
        data = resp.json()
    except Exception:
        return None, {"error": f"上游返回了非 JSON 响应：{resp.text[:200]}", "status": 502}

    images = normalize_image_items(data)
    if not images:
        return None, {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return images, None


async def call_edits(
    client: httpx.AsyncClient, *, base_url: str, model: str, prompt: str,
    n: int, size: str, img_bytes: bytes, headers: dict,
) -> tuple[Optional[List[dict]], Optional[dict]]:
    """调上游 /images/edits 一次（参考图）。返回 (images, error_dict)。"""
    edit_url = f"{base_url.rstrip('/')}/images/edits"
    try:
        resp = await client.post(
            edit_url,
            files={"image": ("reference.png", img_bytes, "image/png")},
            data={
                "model": model, "prompt": prompt, "n": str(n),
                "size": size, "response_format": "b64_json",
            },
            headers=headers,
        )
    except httpx.TimeoutException:
        return None, {"error": "图像生成超时（10min），请稍后重试", "status": 504}
    except httpx.HTTPError as e:
        return None, {"error": f"网络错误：{e}", "status": 502}

    if resp.status_code >= 400:
        try:
            err = (resp.json().get("error") or {})
            detail = (err.get("message") if isinstance(err, dict) else err) or resp.text
        except Exception:
            detail = resp.text or f"HTTP {resp.status_code}"
        logger.warning(f"[image_gen][edits] upstream {resp.status_code}: {detail}")
        return None, {
            "error": f"参考图生成失败：{detail}（当前模型可能不支持图片编辑）",
            "status": resp.status_code,
        }

    # 上游返回 HTML（多半是 base_url 配错指向了网站首页而不是 API 根路径）
    body_text = resp.text or ""
    ct = (resp.headers.get("content-type") or "").lower()
    if ("<!doctype html" in body_text[:200].lower()
            or "<html" in body_text[:200].lower()
            or "text/html" in ct):
        return None, {
            "error": (
                f"图像 API 返回的是 HTML 而不是 JSON —— 几乎可以确定 base_url 配错了。"
                f"实际请求 URL：{edit_url} ；请检查 admin → AI 配置 里这个 provider 的"
                f" base_url（正确格式应是 https://xxx/v1 或 https://xxx/api/v1，结尾要有 API 路径段）。"
            ),
            "status": 502,
        }
    try:
        data = resp.json()
    except Exception:
        return None, {"error": f"上游返回非 JSON 响应：{body_text[:200]}", "status": 502}

    images = normalize_image_items(data)
    if not images:
        return None, {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return images, None


# ── Pydantic 模型 ───────────────────────────────────────────────────────────

class SaveImageConfigRequest(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    size: Optional[str] = None


class SyncImageBitableRequest(BaseModel):
    record_ids: List[int]
    target_table_id: Optional[str] = None
