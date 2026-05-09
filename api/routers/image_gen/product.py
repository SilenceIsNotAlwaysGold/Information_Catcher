# -*- coding: utf-8 -*-
"""商品图（自创）：Prompt 向导 + 同步生图 1-4 张。"""
from __future__ import annotations

import base64
import logging
import re
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import monitor_db, qiniu_uploader, local_storage
from ._common import (
    DEFAULT_SIZE, MAX_TOTAL,
    call_edits, call_generations, max_per_batch_for,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class GeneratePromptsRequest(BaseModel):
    subject: str
    scenes: List[str] = []
    style: str = ""
    platform: str = "小红书"
    extras: str = ""
    language: str = "en"  # zh | en


class GenerateRequest(BaseModel):
    """商品图同步生图。极简：prompt + 数量 1-4 + 可选参考图。"""
    prompt: str
    negative_prompt: Optional[str] = ""
    n: Optional[int] = 1
    size: Optional[str] = None
    reference_image_b64: Optional[str] = None


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
            "你是专业的电商商品图 AI 提示词工程师。\n"
            "根据用户提供的商品信息，生成 5 条不同风格/场景的中文 prompt。\n"
            "要求：\n"
            "1. 每条 prompt 单独一行，以 '数字. ' 开头（如 '1. xxx'）\n"
            "2. 包含：商品特写描述、背景/场景、光线、构图角度、画面风格\n"
            "3. 结尾加质量词：高质量，8k，专业商品摄影，清晰对焦\n"
            "4. 只输出 5 条编号 prompt，不要有其他说明文字\n"
            "5. 5 条之间要有差异化（角度 / 场景 / 配色变体）"
        )
    else:
        system_prompt = (
            "You are a professional e-commerce product photography prompt engineer.\n"
            "Based on the product info provided, generate 5 different prompts for AI image generation.\n"
            "Requirements:\n"
            "1. One prompt per line, starting with '1. ', '2. ', etc.\n"
            "2. Include: product close-up, background/scene, lighting, composition, style\n"
            "3. Append: high quality, 8k, professional product photography, sharp focus\n"
            "4. Output ONLY 5 numbered prompts, no extra explanations\n"
            "5. Each prompt must differ in angle / scene / palette"
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
                return {"error": f"AI 服务地址配置有误，返回了 HTML 页面（URL：{url}）。"}
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


@router.post("/generate", summary="商品图：调用图像 API 生成 1-4 张")
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

    n = max(1, min(int(req.n or 1), MAX_TOTAL))
    size = (req.size or "").strip() or cfg_size
    auth_headers = {"Authorization": f"Bearer {api_key}"}

    img_bytes: Optional[bytes] = None
    if req.reference_image_b64:
        try:
            img_bytes = base64.b64decode(req.reference_image_b64)
        except Exception as e:
            return {"error": f"参考图解码失败：{e}", "status": 400}

    # 分批：模型不支持 n>1 时一张一调
    max_per_batch = max_per_batch_for(model)
    batches: list[int] = []
    remaining = n
    while remaining > 0:
        take = min(remaining, max_per_batch)
        batches.append(take)
        remaining -= take

    user_id = current_user.get("id") if current_user else None
    used_reference = img_bytes is not None
    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()

    all_images: List[dict] = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for batch_n in batches:
            if img_bytes is not None:
                images, err = await call_edits(
                    client, base_url=base_url, model=model, prompt=final_prompt,
                    n=batch_n, size=size, img_bytes=img_bytes, headers=auth_headers,
                )
            else:
                images, err = await call_generations(
                    client, base_url=base_url, model=model, prompt=final_prompt,
                    n=batch_n, size=size, headers=auth_headers,
                )
            if err:
                if all_images:
                    return {
                        "images": all_images,
                        "partial": True,
                        "requested": n,
                        "error": err.get("error"),
                    }
                return err

            for offset, img in enumerate(images or []):
                local_url = ""
                qiniu_url_sync = ""

                if local_ready and img.get("b64"):
                    lurl, lerr = await local_storage.upload_b64(img["b64"], user_id=user_id)
                    if lurl:
                        local_url = lurl
                        img["url"] = lurl
                    elif lerr:
                        logger.warning(f"[image_gen] local write failed: {lerr}")

                if not local_url and qiniu_ready and img.get("b64"):
                    qurl, qerr = await qiniu_uploader.upload_b64(img["b64"], user_id=user_id)
                    if qurl:
                        qiniu_url_sync = qurl
                        img["url"] = qurl
                    elif qerr:
                        logger.warning(f"[image_gen] qiniu sync upload failed: {qerr}")

                if local_url and qiniu_ready:
                    upload_status = "pending"
                elif qiniu_url_sync:
                    upload_status = "uploaded"
                elif local_url:
                    upload_status = "skipped"
                else:
                    upload_status = "failed"

                try:
                    await monitor_db.add_image_history(
                        user_id=user_id, prompt=prompt,
                        negative_prompt=neg, size=size, model=model,
                        set_idx=1, in_set_idx=len(all_images) + offset + 1,
                        local_url=local_url,
                        qiniu_url=qiniu_url_sync or local_url,
                        upload_status=upload_status,
                        generated_title="",
                        generated_body="",
                        batch_id="",
                        source_post_url="",
                        source_post_title="",
                        used_reference=used_reference,
                    )
                except Exception as e:
                    logger.warning(f"[image_gen] write history failed: {e}")

            all_images.extend(images or [])

    return {
        "images": all_images,
        "requested": n,
        "local_ready": local_ready,
        "qiniu_async_pending": qiniu_ready,
        "storage_backend": "local+async-qiniu" if (local_ready and qiniu_ready) else
                           ("local" if local_ready else "none"),
    }
