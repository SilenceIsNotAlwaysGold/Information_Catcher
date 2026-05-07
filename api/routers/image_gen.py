# -*- coding: utf-8 -*-
"""商品图生成：调第三方图像 API（OpenAI 兼容）。

路由前缀 /monitor/image。

端点：
- GET  /monitor/image/config             读取配置（不返回 api_key 明文）
- POST /monitor/image/config             保存配置
- POST /monitor/image/generate-prompts   AI 一键生成商品图 Prompt 列表
- POST /monitor/image/generate           调用 OpenAI 兼容接口生成图片（支持参考图）
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .auth import get_current_user
from ..services import monitor_db
from ..services.platforms import get_platform, detect_platform
from ..services import monitor_fetcher

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/monitor/image", tags=["ImageGen"])


# ── Pydantic models ─────────────────────────────────────────────────────────

class SaveImageConfigRequest(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    size: Optional[str] = None


class GeneratePromptsRequest(BaseModel):
    subject: str                        # 商品主体，例如"护肤精华"
    scenes: List[str] = []             # 场景列表，例如["白底","生活场景"]
    style: str = ""                    # 风格，例如"电商简洁"
    platform: str = "小红书"           # 目标平台
    extras: str = ""                   # 额外描述
    language: str = "en"               # prompt 语言："zh"=中文，"en"=英文


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = ""
    n: Optional[int] = 1
    size: Optional[str] = None
    reference_image_b64: Optional[str] = None  # base64 编码的参考图


class FetchPostCoverRequest(BaseModel):
    """从小红书/抖音 URL 拉取封面图（作为生成参考）。"""
    url: str


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
    if req.api_key is not None and req.api_key.strip():
        await monitor_db.set_setting("image_api_key", req.api_key.strip())
    return {"ok": True}


@router.post("/generate-prompts", summary="AI 一键生成商品图 Prompt")
async def generate_prompts(
    req: GeneratePromptsRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    ai_base_url = (await monitor_db.get_setting("ai_base_url", "")).strip()
    ai_api_key = (await monitor_db.get_setting("ai_api_key", "")).strip()
    ai_model = (await monitor_db.get_setting("ai_model", "gpt-4o-mini")).strip() or "gpt-4o-mini"

    if not ai_base_url or not ai_api_key:
        return {"error": "AI 服务未配置，请在「系统配置」中填写 AI Base URL 和 API Key"}

    scenes_str = "、".join(req.scenes) if req.scenes else "白底纯色"
    style_str = req.style or "电商简洁"
    platform_str = req.platform or "小红书"

    use_chinese = req.language == "zh"
    if use_chinese:
        system_prompt = (
            "你是专业的电商商品图 AI 提示词工程师，擅长为各类电商平台生成高转化率的商品图生成提示词。\n"
            "根据用户提供的商品信息，生成 5 条不同风格/场景的中文 prompt，用于 AI 图像生成。\n"
            "要求：\n"
            "1. 每条 prompt 单独一行，以 '数字. ' 开头（如 '1. xxx'）\n"
            "2. 每条 prompt 语言简洁精准，包含：商品特写描述、背景/场景、光线、构图角度、画面风格\n"
            "3. 结尾统一加质量词：高质量，8k，专业商品摄影，清晰对焦\n"
            "4. 只输出 5 条编号 prompt，不要有其他说明文字\n"
            "5. 每条 prompt 要有差异化，覆盖不同角度或场景变体"
        )
    else:
        system_prompt = (
            "你是专业的电商商品图 AI 提示词工程师，擅长为各类电商平台生成高转化率的商品图生成提示词。\n"
            "根据用户提供的商品信息，生成 5 条不同风格/场景的英文 prompt，用于 AI 图像生成。\n"
            "要求：\n"
            "1. 每条 prompt 单独一行，以 '数字. ' 开头（如 '1. xxx'）\n"
            "2. 每条 prompt 语言简洁精准，包含：商品特写描述、背景/场景、光线、构图角度、画面风格\n"
            "3. 结尾统一加质量词：high quality, 8k, professional product photography, sharp focus\n"
            "4. 只输出 5 条编号 prompt，不要有其他说明文字\n"
            "5. 每条 prompt 要有差异化，覆盖不同角度或场景变体"
        )

    user_msg = (
        f"商品主体：{req.subject}\n"
        f"期望场景：{scenes_str}\n"
        f"画面风格：{style_str}\n"
        f"目标平台：{platform_str}\n"
        f"补充描述：{req.extras or '无'}\n\n"
        "请生成 5 条适合该商品的图像生成 prompt。"
    )

    headers_ai = {
        "Authorization": f"Bearer {ai_api_key}",
        "Content-Type": "application/json",
    }
    url = f"{ai_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.85,
        "max_tokens": 1200,
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=payload, headers=headers_ai)
            if resp.status_code >= 400:
                try:
                    body = resp.json()
                    err = body.get("error") or {}
                    detail = (err.get("message") if isinstance(err, dict) else err) or resp.text
                except Exception:
                    detail = resp.text or f"HTTP {resp.status_code}"
                return {"error": f"AI 服务错误：{detail}"}
            ct = resp.headers.get("content-type", "")
            if "text/html" in ct or resp.text.lstrip().startswith("<!"):
                return {"error": f"AI 服务地址配置有误，返回了 HTML 页面（URL：{url}）。请在「系统配置」中填写正确的 AI Base URL。"}
            try:
                data = resp.json()
            except Exception:
                return {"error": f"AI 服务返回了非 JSON 响应（状态 {resp.status_code}）：{resp.text[:200]}"}
    except httpx.TimeoutException:
        return {"error": "AI 服务响应超时（30s），请稍后重试"}
    except httpx.HTTPError as e:
        return {"error": f"网络错误：{e}"}
    except Exception as e:
        logger.exception(f"[generate_prompts] unexpected: {e}")
        return {"error": f"未知错误：{e}"}

    content = (
        data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    )
    if not content:
        return {"error": "AI 未返回有效内容"}

    prompts: List[str] = []
    for line in content.split("\n"):
        line = line.strip()
        m = re.match(r"^\d+[.)、:：]\s*(.+)$", line)
        if m:
            prompts.append(m.group(1).strip())
        elif line and len(line) > 20 and not re.match(r"^\d+$", line) and len(prompts) < 5:
            prompts.append(line)

    if not prompts:
        prompts = [l.strip() for l in content.split("\n") if l.strip() and len(l.strip()) > 10][:5]

    return {"prompts": prompts[:5]}


def _normalize_image_items(data: dict) -> List[dict]:
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


# 单次上游请求最多生成几张：超过此值后端会拆成多次循环调用。
# 多数 OpenAI 兼容图像 API 单次最多 4 张，gpt-image-1 仅支持 1 张。
_MAX_PER_BATCH = 4
# /generate 一次最多生成的总张数（10 套图最高场景 = 10，留一倍冗余）。
_MAX_TOTAL = 20


async def _call_generations(
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
        return None, {"error": "图像生成超时（180s），请稍后重试", "status": 504}
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

    images = _normalize_image_items(data)
    if not images:
        return None, {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return images, None


async def _call_edits(
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
        return None, {"error": "图像生成超时（180s），请稍后重试", "status": 504}
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

    try:
        data = resp.json()
    except Exception:
        return None, {"error": f"上游返回非 JSON 响应：{resp.text[:200]}", "status": 502}

    images = _normalize_image_items(data)
    if not images:
        return None, {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return images, None


@router.post("/generate", summary="调用第三方图像 API 生成图片（支持参考图）")
async def generate_image(
    req: GenerateRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    base_url = (await monitor_db.get_setting("image_api_base_url", "")).strip()
    api_key = (await monitor_db.get_setting("image_api_key", "")).strip()
    model = (await monitor_db.get_setting("image_api_model", "")).strip()
    cfg_size = (await monitor_db.get_setting("image_api_size", DEFAULT_SIZE)).strip() or DEFAULT_SIZE

    if not base_url or not api_key or not model:
        return {"error": "图像 API 未配置（base_url / api_key / model 必填）", "status": 400}

    prompt = (req.prompt or "").strip()
    if not prompt:
        return {"error": "prompt 不能为空", "status": 400}

    neg = (req.negative_prompt or "").strip()
    final_prompt = f"{prompt}\n\nNegative prompt: {neg}" if neg else prompt

    n = max(1, min(int(req.n or 1), _MAX_TOTAL))
    size = (req.size or "").strip() or cfg_size
    auth_headers = {"Authorization": f"Bearer {api_key}"}

    img_bytes: Optional[bytes] = None
    if req.reference_image_b64:
        try:
            img_bytes = base64.b64decode(req.reference_image_b64)
        except Exception as e:
            return {"error": f"参考图解码失败：{e}", "status": 400}

    # 多张时分批：一次 generate-batch（n>4）会被拆成 ⌈n/4⌉ 次上游请求。
    # 顺序调用而非并发——避免触发上游限流，也方便把第一次失败的错误直接返回。
    batches: list[int] = []
    remaining = n
    while remaining > 0:
        take = min(remaining, _MAX_PER_BATCH)
        batches.append(take)
        remaining -= take

    all_images: List[dict] = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for batch_n in batches:
            if img_bytes is not None:
                images, err = await _call_edits(
                    client, base_url=base_url, model=model, prompt=final_prompt,
                    n=batch_n, size=size, img_bytes=img_bytes, headers=auth_headers,
                )
            else:
                images, err = await _call_generations(
                    client, base_url=base_url, model=model, prompt=final_prompt,
                    n=batch_n, size=size, headers=auth_headers,
                )
            if err:
                # 已经拿到一部分时，返回部分成功 + 错误原因，避免用户白等
                if all_images:
                    return {
                        "images": all_images,
                        "partial": True,
                        "requested": n,
                        "error": err.get("error"),
                    }
                return err
            all_images.extend(images or [])

    return {"images": all_images, "requested": n}


@router.post("/fetch-post-cover", summary="从小红书/抖音作品 URL 拉取封面图作为参考")
async def fetch_post_cover(
    req: FetchPostCoverRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """粘贴作品 URL → 返回 {cover_b64, title, desc, platform}。
    用于"基于一个小红书作品生成 N 套图"的快捷流程。
    """
    raw_url = (req.url or "").strip()
    if not raw_url:
        return {"error": "URL 不能为空"}

    plat = detect_platform(raw_url)
    if not plat:
        return {"error": "无法识别 URL 所属平台（仅支持小红书/抖音）"}

    info = await plat.resolve_url(raw_url)
    if not info:
        return {"error": "URL 解析失败，请确认链接有效"}

    if plat.name == "xhs":
        metrics, status = await monitor_fetcher.fetch_note_metrics(
            note_id=info["post_id"],
            xsec_token=info.get("xsec_token", ""),
            xsec_source=info.get("xsec_source", "app_share"),
            account=None,
        )
    else:
        metrics, status = await plat.fetch_detail(
            {"post_id": info["post_id"], "note_id": info["post_id"],
             "url": info.get("url", "")}, account=None,
        )

    if not metrics:
        return {"error": f"作品抓取失败（status={status}），可能被风控或链接已失效"}

    cover_url = metrics.get("cover_url") or ""
    images = metrics.get("images") or []
    if not cover_url and images:
        cover_url = images[0]
    if not cover_url:
        return {"error": "未能从作品中提取到封面图"}

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(cover_url)
            if resp.status_code >= 400:
                return {"error": f"封面图下载失败：HTTP {resp.status_code}"}
            cover_b64 = base64.b64encode(resp.content).decode("ascii")
    except Exception as e:
        return {"error": f"封面图下载错误：{e}"}

    return {
        "cover_b64": cover_b64,
        "title": metrics.get("title") or "",
        "desc": (metrics.get("desc") or "")[:500],
        "platform": plat.name,
        "platform_label": plat.label,
        "post_id": info["post_id"],
    }
