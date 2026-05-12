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
from ...services import ai_client, local_storage, monitor_db, qiniu_uploader, quota_service

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
    model_id: Optional[int] = None  # 可选指定 ai_models.id；None 走用户默认

    model_config = {"protected_namespaces": ()}


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
            model_id=req.model_id,
            feature="text_remix_ocr",
        )
    except ai_client.AIModelNotConfigured as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # 完整 traceback 进日志（用户看 502 时我们要能定位）
        logger.exception(
            "[text_remix.extract_text] OCR failed user=%s model_id=%s url=%s",
            current_user.get("id"), req.model_id, url[:80],
        )
        raw = str(e) or e.__class__.__name__
        low = raw.lower()
        # 仅对真正"模型不支持视觉"的 4xx 给 DeepSeek 提示。
        # 之前的 `"400" in raw or "image" in raw.lower()` 误伤过多
        # （所有错误都包含 image 字眼），把真实错误一并附带回去
        hint = ""
        is_unsupported = (
            "does not support" in low
            or "doesn't support" in low
            or "unsupported" in low
            or "no image" in low
            or "vision" in low and ("400" in raw or "not" in low)
        )
        if is_unsupported:
            hint = (
                "（疑似：当前选中的模型不支持图片输入，如 DeepSeek 仅文本。"
                "可在「OCR 模型」下拉里切到 GPT-4o / Claude / Gemini / Qwen-VL 等视觉模型）"
            )
        # 502 仅在调用上游真的失败时返回；rate-limit / 网络可以让前端重试
        raise HTTPException(status_code=502, detail=f"OCR 失败：{raw[:400]}{hint}")

    return {"ok": True, "text": text}


# ── 笔记正文 AI 改写 ──────────────────────────────────────────────────────


class RewriteTextRequest(BaseModel):
    text: str
    model_id: Optional[int] = None
    style_hint: Optional[str] = ""   # 用户额外提示（"更口语化 / 加 emoji" 等）
    n_variants: int = 3              # 1-3，多个不同温度


_DEFAULT_REWRITE_PROMPT = (
    "你是小红书爆款文案创作者，请将以下笔记正文改写得更吸引人："
    "保留核心信息，语气更活泼自然、有共鸣感，可适当加 emoji，"
    "结构清晰（短句、分点）。{style_hint}\n\n原文：\n{content}"
)


@router.post("/text-remix/rewrite-text", summary="AI 改写笔记正文（多变体）")
async def rewrite_text(
    req: RewriteTextRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 必填")
    n = max(1, min(int(req.n_variants or 1), 3))

    style = (req.style_hint or "").strip()
    style_part = f"额外要求：{style}。" if style else ""
    prompt = _DEFAULT_REWRITE_PROMPT.format(
        style_hint=style_part,
        content=text[:3000],   # cap 保护
    )

    import asyncio
    temps = [0.7, 1.0, 1.3][:n]

    async def _one(t: float) -> Optional[str]:
        try:
            out = await ai_client.call_text(
                prompt=prompt,
                user_id=int(current_user["id"]),
                model_id=req.model_id,
                feature="text_remix_rewrite",
                temperature=t,
                max_tokens=1500,
            )
            return out.strip() if out else None
        except ai_client.AIModelNotConfigured as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.warning(f"[text_remix.rewrite] variant t={t} failed: {e}")
            return None

    try:
        results = await asyncio.gather(*[_one(t) for t in temps])
    except HTTPException:
        raise
    variants = [r for r in results if r]
    if not variants:
        raise HTTPException(status_code=502, detail="AI 改写全部失败，请稍后重试或换模型")
    return {"variants": variants}


# ── 生成：背景图 + 文字 → 新图 ────────────────────────────────────────────


class GenerateRequest(BaseModel):
    background_id: int          # 用哪张背景图模板
    text_content: str           # 用户确认后的文字（可编辑）
    count: int = 1              # 生成几张（MVP 同步实现，建议 1-3）
    size: Optional[str] = None
    style_hint: Optional[str] = ""  # 附加风格提示（"小红书风 / 简约清新" 等）
    image_model_id: Optional[int] = None  # 可选指定 ai_models.id（image）；None 走用户默认

    model_config = {"protected_namespaces": ()}


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

    # 图配额：text-remix 每次生 count 张图（每张 1 次 image edits 调用）
    await quota_service.check_or_raise(
        current_user, "total_image_gen", delta=count,
    )

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
    try:
        img_cfg = await ai_client.get_active_model_config(
            usage_type="image", user_id=user_id, model_id=req.image_model_id,
        )
    except ai_client.AIModelNotConfigured as e:
        raise HTTPException(status_code=400, detail=str(e))
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

    # 按实际生成成功的张数扣配额（失败的不扣，对用户更友好）
    success_count = sum(1 for r in results if r.get("image_url"))
    if success_count > 0:
        try:
            await quota_service.record_usage(user_id, "image_gen", delta=success_count)
        except Exception as e:
            logger.warning(f"[text_remix] record_usage failed: {e}")

    return {
        "ok": True,
        "results": results,
        "background_id": bg["id"],
        "background_url": bg["image_url"],
        "text": text,
        "total_images": success_count,
    }


# ── 异步任务：替代同步 /generate（CF tunnel 100s 会超时；async 后任务由 worker 跑）─


class TextSource(BaseModel):
    src_idx: int          # 原作品图序号（仅做标签）
    text: str             # OCR 后用户确认的文字


class TextRemixTaskRequest(BaseModel):
    post_url: str = ""
    post_title: str = ""
    platform: str = ""
    text_sources: List[TextSource]   # ≥1
    background_ids: List[int]         # ≥1
    count: int = 1                    # 套数 1-30
    size: Optional[str] = None
    style_hint: Optional[str] = ""
    image_model_id: Optional[int] = None

    model_config = {"protected_namespaces": ()}


@router.post("/text-remix-tasks", summary="提交文本仿写任务（异步，worker 跑）")
async def create_text_remix_task(
    req: TextRemixTaskRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = int(current_user["id"])
    if not req.text_sources:
        raise HTTPException(status_code=400, detail="text_sources 不能为空")
    if not req.background_ids:
        raise HTTPException(status_code=400, detail="background_ids 不能为空")
    # 过滤空文字
    sources_clean = [
        {"src_idx": int(s.src_idx), "text": (s.text or "").strip()}
        for s in req.text_sources if (s.text or "").strip()
    ]
    if not sources_clean:
        raise HTTPException(status_code=400, detail="所有文字源都是空的")
    count = max(1, min(int(req.count or 1), 30))

    # 校验背景权限 + 收集元数据（让 worker 不必再查表）
    bgs_meta = []
    valid_ids = []
    for bid in req.background_ids:
        bg = await monitor_db.get_text_remix_background(int(bid), user_id)
        if not bg:
            continue
        bgs_meta.append({
            "id": bg["id"],
            "name": bg.get("name", "") or "",
            "image_url": bg.get("image_url", "") or "",
        })
        valid_ids.append(bg["id"])
    if not valid_ids:
        raise HTTPException(
            status_code=404,
            detail="选中的背景图都不存在或无权访问",
        )

    # 图配额：worker 会跑 count × len(sources_clean) × len(valid_ids) 张图
    expected_images = count * len(sources_clean) * len(valid_ids)
    await quota_service.check_or_raise(
        current_user, "total_image_gen", delta=expected_images,
    )

    task_id = await monitor_db.add_text_remix_task(
        user_id=user_id,
        post_url=req.post_url or "",
        post_title=req.post_title or "",
        platform=req.platform or "",
        text_sources=sources_clean,
        background_ids=valid_ids,
        backgrounds_meta=bgs_meta,
        count=count,
        size=(req.size or "").strip(),
        style_hint=(req.style_hint or "").strip(),
        image_model_id=req.image_model_id,
    )
    if not task_id:
        raise HTTPException(status_code=500, detail="创建任务失败")

    # 提交时按"预期总图数"预扣（worker 跑失败的部分多扣的可以后续补偿）
    try:
        await quota_service.record_usage(user_id, "image_gen", delta=expected_images)
    except Exception as e:
        logger.warning(f"[text_remix] record_usage failed: {e}")

    return {
        "ok": True,
        "task_id": task_id,
        "total_images": expected_images,
    }


def _enrich_task(task: dict) -> dict:
    """把 DB row 转成前端可直接渲染的 dict（展开 JSON 字段）。"""
    import json as _json
    out = dict(task)
    for k in ("text_sources_json", "background_ids_json",
              "backgrounds_meta_json", "items_json"):
        try:
            out[k.replace("_json", "")] = _json.loads(out.get(k) or ("[]"))
        except Exception:
            out[k.replace("_json", "")] = []
        # 保留原字段名也行，但前端用解析后的更省事
    return out


@router.get("/text-remix-tasks", summary="我的文本仿写任务列表")
async def list_my_text_remix_tasks(
    limit: int = 30,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = int(current_user["id"])
    rows = await monitor_db.list_text_remix_tasks(user_id=user_id, limit=limit)
    return {"tasks": [_enrich_task(r) for r in rows]}


@router.get("/text-remix-tasks/{task_id}", summary="单个任务（带 items 进度）")
async def get_text_remix_task_detail(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = int(current_user["id"])
    task = await monitor_db.get_text_remix_task(task_id)
    if not task or task.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="任务不存在或无权访问")
    return {"task": _enrich_task(task)}


@router.post("/text-remix-tasks/{task_id}/cancel", summary="取消文本仿写任务")
async def cancel_text_remix_task_ep(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = int(current_user["id"])
    ok = await monitor_db.cancel_text_remix_task(task_id, user_id=user_id)
    return {"ok": ok}


@router.delete("/text-remix-tasks/{task_id}", summary="删除任务（仅 done/error/cancelled）")
async def delete_text_remix_task_ep(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = int(current_user["id"])
    task = await monitor_db.get_text_remix_task(task_id)
    if not task or task.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="任务不存在或无权访问")
    if task.get("status") in ("pending", "running"):
        raise HTTPException(status_code=400, detail="任务进行中，请先取消")
    await monitor_db.delete_text_remix_task(task_id)
    return {"ok": True}


@router.post("/text-remix-tasks/{task_id}/clone", summary="用相同参数重新提交")
async def clone_text_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    import json as _json
    user_id = int(current_user["id"])
    task = await monitor_db.get_text_remix_task(task_id)
    if not task or task.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="任务不存在或无权访问")
    try:
        text_sources = _json.loads(task.get("text_sources_json") or "[]")
        bg_ids = _json.loads(task.get("background_ids_json") or "[]")
        bgs_meta = _json.loads(task.get("backgrounds_meta_json") or "[]")
    except Exception:
        raise HTTPException(status_code=500, detail="原任务参数解析失败")

    # clone 同样扣图配额（克隆 = 重做一次）
    count = int(task.get("count") or 1)
    expected_images = count * len(text_sources) * len(bg_ids)
    if expected_images > 0:
        await quota_service.check_or_raise(
            current_user, "total_image_gen", delta=expected_images,
        )

    new_id = await monitor_db.add_text_remix_task(
        user_id=user_id,
        post_url=task.get("post_url") or "",
        post_title=task.get("post_title") or "",
        platform=task.get("platform") or "",
        text_sources=text_sources,
        background_ids=bg_ids,
        backgrounds_meta=bgs_meta,
        count=count,
        size=task.get("size") or "",
        style_hint=task.get("style_hint") or "",
        image_model_id=task.get("image_model_id"),
    )
    if expected_images > 0:
        try:
            await quota_service.record_usage(user_id, "image_gen", delta=expected_images)
        except Exception as e:
            logger.warning(f"[text_remix] clone record_usage failed: {e}")
    return {"ok": True, "task_id": new_id, "total_images": expected_images}
