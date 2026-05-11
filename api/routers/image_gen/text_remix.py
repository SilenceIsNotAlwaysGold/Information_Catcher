# -*- coding: utf-8 -*-
"""文本仿写：扒原图文字 + 换背景图重绘。

流程：
  1. 用户粘贴作品链接 → 拉所有图（复用 fetch-post-cover）
  2. 选某张图作为「文字源」→ POST /extract-text，OCR 出文字给用户确认
  3. 用户上传 / 选择背景图模板（POST/GET /backgrounds）
  4. POST /generate：用背景图作 reference + 含 OCR 文字的 prompt → 调图模型生成

MVP 设计：generate 同步调一次返回（~30s），不入队列。
后续可改异步入 remix_tasks。
"""
from __future__ import annotations

import base64
import logging
import time
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import ai_client, local_storage, monitor_db, qiniu_uploader

logger = logging.getLogger(__name__)

router = APIRouter()


# ── 背景图模板 CRUD ───────────────────────────────────────────────────────


@router.get("/text-remix/backgrounds", summary="我的背景图模板列表")
async def list_backgrounds(
    current_user: dict = Depends(get_current_user),
) -> dict:
    rows = await monitor_db.list_text_remix_backgrounds(int(current_user["id"]))
    return {"backgrounds": rows}


@router.post("/text-remix/backgrounds", summary="上传背景图模板")
async def upload_background(
    file: UploadFile = File(...),
    name: str = Form(""),
    current_user: dict = Depends(get_current_user),
) -> dict:
    if not file:
        raise HTTPException(status_code=400, detail="未提供文件")
    raw = await file.read()
    if not raw or len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件为空或超过 10MB")
    ct = (file.content_type or "image/png").lower()
    if not ct.startswith("image/"):
        raise HTTPException(status_code=400, detail="只接受图片文件")

    user_id = int(current_user["id"])
    b64 = base64.b64encode(raw).decode("ascii")

    # 优先本地，七牛兜底
    image_url = ""
    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()
    if local_ready:
        url, err = await local_storage.upload_b64(b64, user_id=user_id)
        if url:
            image_url = url
    if not image_url and qiniu_ready:
        url, err = await qiniu_uploader.upload_b64(b64, user_id=user_id)
        if url:
            image_url = url
    if not image_url:
        raise HTTPException(
            status_code=500,
            detail="存储未配置：请在系统设置中开启本地存储（公网访问地址）或七牛",
        )

    bg_id = await monitor_db.add_text_remix_background(
        user_id=user_id,
        name=(name or file.filename or "未命名").strip()[:100],
        image_url=image_url,
    )
    return {"ok": True, "id": bg_id, "image_url": image_url}


@router.delete("/text-remix/backgrounds/{bg_id}", summary="删除背景图模板")
async def delete_background(
    bg_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    ok = await monitor_db.delete_text_remix_background(bg_id, int(current_user["id"]))
    return {"ok": ok}


# ── OCR：从图片提取文字 ───────────────────────────────────────────────────


class ExtractTextRequest(BaseModel):
    image_url: str  # 作品原图的 URL（CDN），后端会代下


async def _fetch_image_as_dataurl(url: str) -> str:
    """带 Referer 下载平台 CDN 图并 base64 内嵌，返回 data:URL。"""
    if not url:
        return ""
    h = url.lower()
    referer = ""
    if "xhscdn.com" in h or "xiaohongshu.com" in h:
        referer = "https://www.xiaohongshu.com/"
    elif "douyinpic.com" in h or "byteimg.com" in h or "bytedance.com" in h:
        referer = "https://www.douyin.com/"
    elif "qpic.cn" in h or "weixin.qq.com" in h:
        referer = "https://mp.weixin.qq.com/"
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    }
    if referer:
        headers["Referer"] = referer
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        r = await client.get(url, headers=headers)
        r.raise_for_status()
        ct = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
        if not ct.startswith("image/"):
            raise ValueError(f"返回不是图片: {ct}")
        b64 = base64.b64encode(r.content).decode("ascii")
        return f"data:{ct};base64,{b64}"


@router.post("/text-remix/extract-text", summary="OCR 提取图片中的文字")
async def extract_text(
    req: ExtractTextRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    url = (req.image_url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="image_url 必填")
    # 远端 CDN 图需要代下成 dataurl（vision 模型需要能访问图）
    try:
        if url.startswith("data:"):
            data_url = url
        else:
            data_url = await _fetch_image_as_dataurl(url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"下载源图失败：{e}")

    try:
        text = await ai_client.call_vision_ocr(
            image_data_url=data_url,
            user_id=int(current_user["id"]),
            feature="text_remix_ocr",
        )
    except ai_client.AIModelNotConfigured as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"OCR 失败：{e}")

    return {"ok": True, "text": text}


# ── 生成：背景图 + 文字 → 新图 ────────────────────────────────────────────


class GenerateRequest(BaseModel):
    background_id: int          # 用哪张背景图模板
    text_content: str           # 用户确认后的文字（可编辑）
    count: int = 1              # 生成几张（MVP 同步实现，建议 1-3）
    size: Optional[str] = None
    style_hint: Optional[str] = ""  # 附加风格提示（"小红书风 / 简约清新" 等）


@router.post("/text-remix/generate", summary="用背景图 + 文字生成新图")
async def text_remix_generate(
    req: GenerateRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = int(current_user["id"])
    text = (req.text_content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text_content 必填")
    count = max(1, min(int(req.count or 1), 3))   # MVP 同步上限 3

    bg = await monitor_db.get_text_remix_background(req.background_id, user_id)
    if not bg:
        raise HTTPException(status_code=404, detail="背景图不存在或无权访问")

    # 下载背景图 bytes
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(bg["image_url"])
            r.raise_for_status()
            ref_bytes = r.content
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"加载背景图失败：{e}")

    # 构造 prompt：在背景图上印这些文字 + 风格暗示
    style_hint = (req.style_hint or "").strip()
    prompt = (
        f'Generate a new image using the reference image as the visual style template '
        f'(background layout, color palette, lighting, decorative elements, overall mood). '
        f'Render the following Chinese text ON the image as prominent typography, '
        f'using a font that matches the style of the reference. Keep typography balanced '
        f'and visually consistent with the reference image.\n\n'
        f'TEXT TO RENDER (preserve line breaks EXACTLY):\n"""\n{text[:600]}\n"""\n\n'
    )
    if style_hint:
        prompt += f'Additional style hint: {style_hint[:120]}.\n'
    prompt += "High quality 8k professional design, sharp typography."

    # 调图模型 N 次
    from ._common import DEFAULT_SIZE, call_edits
    img_cfg = await ai_client.get_active_model_config(
        usage_type="image", user_id=user_id,
    )
    base_url = img_cfg.get("base_url")
    api_key = img_cfg.get("api_key")
    model = img_cfg.get("model_id")
    image_model_row_id = int(img_cfg.get("model_row_id") or 0)
    image_max_concurrent = int(img_cfg.get("max_concurrent") or 0)
    cfg_size = (img_cfg.get("extra_config") or {}).get("size") or DEFAULT_SIZE
    if not base_url or not api_key or not model:
        raise HTTPException(status_code=400, detail="图像 API 未配置")
    size = (req.size or "").strip() or cfg_size

    results: List[dict] = []
    auth_headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=30.0)) as client:
        for i in range(count):
            t0 = time.perf_counter()
            async with ai_client.acquire_slot(image_model_row_id, image_max_concurrent):
                imgs, err = await call_edits(
                    client, base_url=base_url, model=model, prompt=prompt,
                    n=1, size=size, img_bytes=ref_bytes, headers=auth_headers,
                )
            ms = int((time.perf_counter() - t0) * 1000)
            # 写 ai_usage_logs
            try:
                await ai_client.log_usage(
                    user_id=user_id,
                    model_row_id=image_model_row_id, model_id_str=model,
                    usage_type="image", feature="text_remix",
                    image_count=1 if imgs else 0,
                    latency_ms=ms,
                    status="ok" if imgs else "error",
                    error=(err or {}).get("error", "") if not imgs else "",
                )
            except Exception:
                pass
            if not imgs:
                results.append({"image_url": "", "error": (err or {}).get("error", "未知错误")})
                continue
            b64 = imgs[0].get("b64") or ""
            image_url = ""
            local_ready = await local_storage.is_configured()
            if b64 and local_ready:
                url, _ = await local_storage.upload_b64(b64, user_id=user_id)
                if url: image_url = url
            if not image_url and b64:
                qiniu_ready = await qiniu_uploader.is_configured()
                if qiniu_ready:
                    url, _ = await qiniu_uploader.upload_b64(b64, user_id=user_id)
                    if url: image_url = url
            if not image_url:
                image_url = imgs[0].get("url") or ""
            # 写历史
            try:
                await monitor_db.add_image_history(
                    user_id=user_id, prompt=prompt[:500], size=size, model=model,
                    set_idx=1, in_set_idx=i + 1,
                    local_url=image_url, qiniu_url=image_url,
                    upload_status="uploaded" if image_url else "failed",
                    generated_title=text[:120],
                    generated_body="",
                    batch_id=f"text_remix:{int(time.time())}",
                    source_post_url="", source_post_title="",
                    used_reference=True,
                )
            except Exception:
                pass
            results.append({"image_url": image_url, "error": ""})

    return {
        "ok": True,
        "results": results,
        "background_id": bg["id"],
        "background_url": bg["image_url"],
        "text": text,
    }
