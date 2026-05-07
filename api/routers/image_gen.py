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
from ..services import storage
from ..services import qiniu_uploader
from ..services import local_storage
from ..services import feishu_bitable
from ..services import image_upload_worker

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
    # 套图维度（用于历史记录编号）。前端分批请求时通过 start_index 累加。
    images_per_set: Optional[int] = 1
    start_index: Optional[int] = 0          # 这一批是全局第几张开始（0-indexed）
    # 来源标记：如果 prompt 是从某个小红书/抖音作品 URL 拉来的
    source_post_url: Optional[str] = ""
    source_post_title: Optional[str] = ""


class FetchPostCoverRequest(BaseModel):
    """从小红书/抖音 URL 拉取封面图（作为生成参考）。"""
    url: str


class SyncImageBitableRequest(BaseModel):
    """把若干历史记录同步到飞书多维表格的图像专用 sheet。"""
    record_ids: List[int]


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
# /generate 单次请求最多生成的总张数。
# 套图场景上限 = 10 套账号 × 9 张轮播 = 90，但实际是前端按 4 张/批多次调用，
# 所以这里只是"单次最大"。设 60 已经足够（覆盖绝大多数自定义组合），
# 防止误填超大数字一锅端打爆上游。
_MAX_TOTAL = 60


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

    # 历史记录 + 七牛上传上下文
    user_id = current_user.get("user_id") if current_user else None
    images_per_set = max(1, int(req.images_per_set or 1))
    start_index = max(0, int(req.start_index or 0))
    used_reference = img_bytes is not None
    src_url = (req.source_post_url or "").strip()
    src_title = (req.source_post_title or "").strip()
    # 异步上传策略：始终先写本地（拿到立即可用的 URL），如配了七牛就把记录标 pending
    # 后台 scheduler 异步推到云端，用户立刻能拿到 URL 同步飞书也能用。
    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()

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

            # 每张：①写本地拿到立即可用 URL ②写历史 ③配了七牛就标 pending
            # 用户立刻能下载 + 同步飞书；后台 scheduler 慢慢把图推到七牛 CDN
            for offset, img in enumerate(images or []):
                global_idx = start_index + len(all_images) + offset
                set_idx = global_idx // images_per_set + 1
                in_set_idx = global_idx % images_per_set + 1

                local_url = ""
                if local_ready and img.get("b64"):
                    lurl, lerr = await local_storage.upload_b64(img["b64"], user_id=user_id)
                    if lurl:
                        local_url = lurl
                        img["url"] = lurl  # 立即返回给前端
                    elif lerr:
                        logger.warning(f"[image_gen] local write failed (set {set_idx}-{in_set_idx}): {lerr}")

                # qiniu_url 起初 = local_url（飞书同步先用本地，传到七牛后会被覆盖）
                # upload_status:
                #   pending  → 配了七牛，待 worker 异步推
                #   skipped  → 没配七牛，永远不传（local_url 就是终态）
                #   failed   → 没本地存储也没七牛，记录无 URL
                if local_url and qiniu_ready:
                    upload_status = "pending"
                elif local_url:
                    upload_status = "skipped"
                else:
                    upload_status = "failed"

                try:
                    await monitor_db.add_image_history(
                        user_id=user_id, prompt=prompt,
                        negative_prompt=neg, size=size, model=model,
                        set_idx=set_idx, in_set_idx=in_set_idx,
                        local_url=local_url,
                        qiniu_url=local_url,  # 起初等于本地，七牛传完后被 worker 覆盖
                        upload_status=upload_status,
                        source_post_url=src_url, source_post_title=src_title,
                        used_reference=used_reference,
                    )
                except Exception as e:
                    logger.warning(f"[image_gen] write history failed: {e}")

            all_images.extend(images or [])

    return {
        "images": all_images,
        "requested": n,
        "local_ready": local_ready,
        "qiniu_async_pending": qiniu_ready,  # 是否会异步推七牛
        "storage_backend": "local+async-qiniu" if (local_ready and qiniu_ready) else
                           ("local" if local_ready else "none"),
    }


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


# ── 历史记录 ─────────────────────────────────────────────────────────────────

@router.get("/history", summary="商品图生成历史记录")
async def list_history(
    limit: int = 100, offset: int = 0,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """admin 看全部，普通用户只看自己的。"""
    user_id = current_user.get("user_id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    scope_uid = None if role == "admin" else user_id
    rows = await monitor_db.list_image_history(
        user_id=scope_uid,
        limit=max(1, min(limit, 500)),
        offset=max(0, offset),
    )
    backend = await storage.active_backend()
    return {
        "records": rows,
        "qiniu_configured": backend != "none",  # 兼容前端字段名（实际指"图片存储已配置"）
        "storage_backend": backend,
    }


@router.delete("/history/{record_id}", summary="删除历史记录")
async def delete_history(
    record_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("user_id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    # admin 传 None 可删任何，普通用户只能删自己的
    scope_uid = None if role == "admin" else user_id
    ok = await monitor_db.delete_image_history(record_id, user_id=scope_uid)
    return {"ok": ok}


@router.post("/history/{record_id}/retry-upload", summary="把 failed 记录重置为 pending 重试")
async def retry_upload(
    record_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    rec = await monitor_db.get_image_history(record_id)
    if not rec:
        return {"ok": False, "error": "记录不存在"}
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and rec.get("user_id") != current_user.get("user_id"):
        return {"ok": False, "error": "无权操作"}
    await monitor_db.reset_image_upload_failed(record_id)
    return {"ok": True}


@router.post("/upload-worker/run", summary="立即触发一次七牛上传（admin only，调试用）")
async def trigger_upload_worker(
    current_user: dict = Depends(get_current_user),
) -> dict:
    role = (current_user or {}).get("role") or "user"
    if role != "admin":
        return {"ok": False, "error": "需要管理员权限"}
    return await image_upload_worker.run_batch()


@router.post("/history/sync-bitable", summary="把历史记录同步到飞书多维表格")
async def sync_history_to_bitable(
    req: SyncImageBitableRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    if not req.record_ids:
        return {"error": "未选中任何记录", "status": 400}

    # 优先写用户专属表（OAuth 绑定后自动建），缺失时 fallback 到全局 admin 表
    from ..services.feishu import bitable as feishu_bitable_v2
    target = await feishu_bitable_v2.resolve_target(current_user, kind="image")
    if target["source"] == "none":
        return {
            "error": "未找到飞书图像表。请先「绑定飞书」让系统自动建表，"
                     "或让管理员在「系统配置」配 feishu_bitable_app_token + feishu_bitable_image_table_id 作为兜底。",
            "status": 400,
        }
    app_token = target["app_token"]
    table_id = target["table_id"]

    # 全局表第一次同步时自动建字段（用旧路径，需要 app_id/secret）；
    # 用户专属表 provisioning 时已建好字段，跳过 ensure 即可。
    if target["source"] == "global":
        settings = await monitor_db.get_all_settings()
        app_id     = settings.get("feishu_app_id", "")
        app_secret = settings.get("feishu_app_secret", "")
        if not (app_id and app_secret):
            return {"error": "飞书 app_id / app_secret 未配置", "status": 400}
        try:
            await feishu_bitable.ensure_fields(
                app_id, app_secret, app_token, table_id,
                fields={
                    "Prompt": "text", "图片": "url",
                    "尺寸": "text", "模型": "text",
                    "套号": "number", "套内序号": "number",
                    "来源链接": "url", "来源标题": "text",
                    "生成时间": "text",
                },
            )
        except Exception as e:
            return {"error": f"准备表格字段失败：{e}", "status": 400}

    user_id = current_user.get("id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    scope_uid = None if role == "admin" else user_id

    results = []
    for rid in req.record_ids:
        rec = await monitor_db.get_image_history(rid)
        if not rec:
            results.append({"id": rid, "ok": False, "reason": "记录不存在"})
            continue
        # 普通用户不能同步别人的
        if scope_uid is not None and rec.get("user_id") != scope_uid:
            results.append({"id": rid, "ok": False, "reason": "无权同步该记录"})
            continue
        url = (rec.get("qiniu_url") or "").strip()
        if not url:
            results.append({"id": rid, "ok": False, "reason": "图片未上传到七牛（先配七牛再生成）"})
            continue
        try:
            src_url = (rec.get("source_post_url") or "").strip()
            await feishu_bitable_v2.add_record(
                app_token, table_id,
                fields={
                    "Prompt": rec.get("prompt", ""),
                    "图片": {"link": url, "text": url},
                    "尺寸": rec.get("size", ""),
                    "模型": rec.get("model", ""),
                    "套号": rec.get("set_idx", 1),
                    "套内序号": rec.get("in_set_idx", 1),
                    "来源链接": ({"link": src_url, "text": src_url} if src_url else ""),
                    "来源标题": rec.get("source_post_title", ""),
                    "生成时间": rec.get("created_at", ""),
                },
            )
            await monitor_db.mark_image_history_synced(rid)
            results.append({"id": rid, "ok": True})
        except Exception as e:
            results.append({"id": rid, "ok": False, "reason": str(e)})
    return {"results": results, "target": target["source"]}
