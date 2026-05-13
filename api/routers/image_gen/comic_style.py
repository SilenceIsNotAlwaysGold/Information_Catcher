# -*- coding: utf-8 -*-
"""漫画风 — 上传图 + 预设/自定义漫画风提示词 → 图生图（image edits）。

跟商品图 / 仿写 / 文案换背景的区别：
- 主打"快速套风格"：8 个内置漫画风预设（日漫/国漫/美漫/线稿/水彩/像素/Q 版/黑色）
- 不持久化到 image_gen_history（不入飞书同步流程）
- 生成后前端直接下载，零依赖
- 仍走配额 total_image_gen
"""
from __future__ import annotations

import base64
import logging
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import ai_client, quota_service
from ._common import DEFAULT_SIZE, call_edits

logger = logging.getLogger(__name__)

router = APIRouter()


# ── 内置漫画风预设（key, 中文 label, 英文 prompt） ─────────────────────────

COMIC_PRESETS: dict = {
    "anime_jp": {
        "label": "日系动漫",
        "desc": "Studio Ghibli / 京阿尼风，大眼、cel shading",
        "prompt": (
            "convert into Japanese anime style illustration, vibrant cel shading, "
            "clean line art, big sparkling eyes, soft pastel palette, Studio Ghibli "
            "and Kyoto Animation aesthetics, detailed background"
        ),
    },
    "manhua_cn": {
        "label": "国漫风",
        "desc": "国创风格，水彩质感 + 电影感打光",
        "prompt": (
            "convert into Chinese donghua / manhua illustration style, "
            "soft watercolor textures, elegant character design, cinematic lighting, "
            "modern Chinese animation aesthetic, painterly background"
        ),
    },
    "marvel": {
        "label": "美式英雄",
        "desc": "漫威/DC 风格，粗墨线 + 网点",
        "prompt": (
            "convert into American superhero comic book illustration style, "
            "bold ink outlines, halftone dot shading, dynamic action pose, "
            "vivid saturated colors, comic book panel aesthetic"
        ),
    },
    "ink_bw": {
        "label": "黑白线稿",
        "desc": "纯线稿，无色，detail 排线",
        "prompt": (
            "convert into black and white manga ink line art, detailed line work, "
            "hatching and cross-hatching shading, pure monochrome, "
            "highly detailed pen and ink illustration, no color"
        ),
    },
    "watercolor": {
        "label": "水彩漫画",
        "desc": "手绘水彩质感，柔和温暖",
        "prompt": (
            "convert into soft watercolor painting illustration, gentle pastel palette, "
            "hand-painted texture, dreamy and warm mood, visible brush strokes, "
            "wet-on-wet watercolor technique"
        ),
    },
    "pixel_art": {
        "label": "像素艺术",
        "desc": "16-bit 复古游戏风",
        "prompt": (
            "convert into 16-bit pixel art style, retro video game aesthetic, "
            "limited color palette, sharp pixelated edges, dithering shadows, "
            "Super Nintendo / Sega Genesis era graphics"
        ),
    },
    "chibi": {
        "label": "Q 版萌系",
        "desc": "三头身，超大眼，可爱萌",
        "prompt": (
            "convert into chibi / super deformed style illustration, "
            "oversized head and eyes, tiny cute body proportions, kawaii aesthetic, "
            "soft pastel colors, adorable expression"
        ),
    },
    "noir": {
        "label": "黑色漫画",
        "desc": "Sin City 风格，高对比黑白",
        "prompt": (
            "convert into film noir comic book style, high contrast black and white, "
            "dramatic shadows, hardboiled atmosphere, ink-heavy rendering, "
            "Sin City Frank Miller aesthetic"
        ),
    },
}


@router.get("/comic-style/presets", summary="漫画风预设列表（前端展示用）")
async def list_presets() -> dict:
    return {
        "presets": [
            {"key": k, "label": v["label"], "desc": v["desc"]}
            for k, v in COMIC_PRESETS.items()
        ]
    }


class ComicGenerateRequest(BaseModel):
    reference_image_b64: str        # 必须 — 用户上传的图（不含 data: 前缀）
    style: str = "anime_jp"          # 预设 key 或 "custom"
    custom_prompt: Optional[str] = None  # style="custom" 时必填；预设 + custom 时叠加
    count: int = 1                   # 1-4
    size: Optional[str] = None
    image_model_id: Optional[int] = None

    model_config = {"protected_namespaces": ()}


@router.post("/comic-style/generate", summary="漫画风一键生成（图生图）")
async def comic_style_generate(
    req: ComicGenerateRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    # 1. 决定 prompt
    custom = (req.custom_prompt or "").strip()
    if req.style == "custom":
        if not custom:
            raise HTTPException(400, "选了「自定义」就必须填提示词")
        prompt = custom
    else:
        preset = COMIC_PRESETS.get(req.style)
        if not preset:
            raise HTTPException(400, f"未知风格：{req.style}")
        prompt = preset["prompt"]
        if custom:
            prompt = f"{prompt}. Additional style notes: {custom}"

    # 2. 解码图
    raw = (req.reference_image_b64 or "").strip()
    if not raw:
        raise HTTPException(400, "请先上传参考图")
    # 兼容前端可能传 data:image/...;base64,... 前缀
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        img_bytes = base64.b64decode(raw)
    except Exception as e:
        raise HTTPException(400, f"图片解码失败：{e}")
    if len(img_bytes) > 10 * 1024 * 1024:
        raise HTTPException(400, "图片超过 10MB")

    # 3. 配额（按生成张数预扣）
    n = max(1, min(int(req.count or 1), 4))
    await quota_service.check_or_raise(current_user, "total_image_gen", delta=n)

    # 4. 解析图像模型配置
    try:
        cfg = await ai_client.get_active_model_config(
            usage_type="image",
            user_id=int(current_user["id"]),
            model_id=req.image_model_id,
        )
    except ai_client.AIModelNotConfigured as e:
        raise HTTPException(400, str(e))
    base_url = cfg["base_url"]
    api_key = cfg["api_key"]
    model = cfg["model_id"]
    cfg_size = (cfg.get("extra_config") or {}).get("size") or DEFAULT_SIZE
    model_row_id = cfg["model_row_id"]
    max_concurrent = int(cfg.get("max_concurrent") or 0)
    size = (req.size or "").strip() or cfg_size
    headers_up = {"Authorization": f"Bearer {api_key}"}

    # 5. 调上游 /images/edits（用 call_edits）
    timeout = httpx.Timeout(600.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with ai_client.acquire_slot(model_row_id, max_concurrent):
            images, err = await call_edits(
                client, base_url=base_url, model=model, prompt=prompt,
                n=n, size=size, img_bytes=img_bytes, headers=headers_up,
            )
    if err:
        raise HTTPException(err.get("status", 502), err.get("error", "上游失败"))
    if not images:
        raise HTTPException(502, "上游未返回图片")

    # 6. 记 AI usage（计费统计；不入 image_gen_history）
    try:
        await ai_client.log_usage(
            user_id=int(current_user["id"]),
            model_row_id=model_row_id,
            model_id_str=model,
            usage_type="image",
            feature="comic_style",
            image_count=len(images),
            latency_ms=0,
        )
    except Exception as e:
        logger.warning(f"[comic_style] log_usage failed: {e}")

    return {
        "ok": True,
        "style": req.style,
        "count": len(images),
        "images": images,  # [{b64: "..."}, ...]
    }
