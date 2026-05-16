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
from ...services import monitor_db, qiniu_uploader, local_storage, quota_service, ai_client
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
    text_model_id: Optional[int] = None  # P15: 可选用户指定的文本模型

    model_config = {"protected_namespaces": ()}


class GenerateRequest(BaseModel):
    """商品图同步生图。极简：prompt + 数量 1-4 + 可选参考图。"""
    prompt: str
    negative_prompt: Optional[str] = ""
    n: Optional[int] = 1
    size: Optional[str] = None
    reference_image_b64: Optional[str] = None
    image_model_id: Optional[int] = None  # P15: 可选用户指定的图像模型

    model_config = {"protected_namespaces": ()}


@router.post("/generate-prompts", summary="AI 一键生成商品图 Prompt")
async def generate_prompts(
    req: GeneratePromptsRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
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

    # call_text 只接受一段 prompt，把 system + user 拼起来传
    full_prompt = system_prompt + "\n\n---\n\n" + user_msg
    try:
        content = await ai_client.call_text(
            full_prompt,
            model_id=req.text_model_id,
            user_id=int(current_user["id"]),
            feature="product_prompts",
            temperature=0.85,
            max_tokens=1200,
            task_ref=ai_client.make_task_ref(
                "product_prompts", int(current_user["id"]), full_prompt,
            ),
        )
    except ai_client.AIModelNotConfigured as e:
        return {"error": str(e)}
    except Exception as e:
        logger.exception(f"[generate_prompts] {e}")
        return {"error": f"AI 调用失败：{e}"}

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
    # P15: 通过 ai_client 解析图像模型配置（多渠道 + 用户偏好）
    try:
        cfg = await ai_client.get_active_model_config(
            usage_type="image",
            user_id=int(current_user["id"]),
            model_id=req.image_model_id,
        )
    except ai_client.AIModelNotConfigured as e:
        return {"error": str(e), "status": 400}
    base_url = cfg["base_url"]
    api_key = cfg["api_key"]
    model = cfg["model_id"]
    cfg_size = (cfg.get("extra_config") or {}).get("size") or DEFAULT_SIZE
    _model_row_id = cfg["model_row_id"]
    _max_concurrent = int(cfg.get("max_concurrent") or 0)  # P15.8

    prompt = (req.prompt or "").strip()
    if not prompt:
        return {"error": "prompt 不能为空", "status": 400}

    neg = (req.negative_prompt or "").strip()
    final_prompt = f"{prompt}\n\nNegative prompt: {neg}" if neg else prompt

    n = max(1, min(int(req.n or 1), MAX_TOTAL))

    # 配额检查：今日商品图生成数（admin 不限）
    await quota_service.check_or_raise(current_user, "total_image_gen", delta=n)

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
    timeout = httpx.Timeout(600.0, connect=30.0)  # 10min 给慢上游 API 留余地
    # 单批失败时的重试策略：最多 5 次，指数退避；认证 / 内容违规等致命错误不重试
    _FATAL_KW = ("认证失败", "Unauthorized", "Forbidden", "invalid api key",
                 "model not found", "policy violation", "safety system")
    async with httpx.AsyncClient(timeout=timeout) as client:
        for batch_n in batches:
            images, err = None, None
            for attempt in range(5):
                # P15.8: 走模型级并发限制
                async with ai_client.acquire_slot(_model_row_id, _max_concurrent):
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
                if images:
                    break
                err_msg = (err or {}).get("error", "")
                if any(kw.lower() in err_msg.lower() for kw in _FATAL_KW):
                    logger.info(f"[image_gen] fatal error, skip retry: {err_msg[:100]}")
                    break
                if attempt < 4:
                    import asyncio as _aio
                    wait_s = min(1.5 * (2 ** attempt), 12.0)
                    logger.info(
                        f"[image_gen] batch attempt {attempt+1}/5 failed: "
                        f"{err_msg[:80]} - retry in {wait_s}s"
                    )
                    await _aio.sleep(wait_s)
            if err and not images:
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

                # 兜底：上游只返 url 不返 b64 时（如 134.175.71.62/v1 这种），
                # 直接把上游 url 当 qiniu_url 存进历史，让前端 HistoryGrid 能显示
                if not local_url and not qiniu_url_sync and img.get("url"):
                    qiniu_url_sync = img["url"]

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

    # 记用量（按实际成功生成数）。admin 也记，方便看活跃度
    if all_images:
        try:
            await quota_service.record_usage(user_id, "image_gen", delta=len(all_images))
        except Exception as e:
            logger.warning(f"[image_gen] record_usage failed: {e}")
        # P15: 写 ai_usage_logs 用于按模型/用户聚合统计
        try:
            await ai_client.log_usage(
                user_id=user_id, model_row_id=_model_row_id, model_id_str=model,
                usage_type="image", feature="product_image",
                image_count=len(all_images),
            )
        except Exception as e:
            logger.warning(f"[image_gen] ai usage log failed: {e}")

    return {
        "images": all_images,
        "requested": n,
        "local_ready": local_ready,
        "qiniu_async_pending": qiniu_ready,
        "storage_backend": "local+async-qiniu" if (local_ready and qiniu_ready) else
                           ("local" if local_ready else "none"),
    }
