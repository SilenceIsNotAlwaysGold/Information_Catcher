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
import time
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import ai_client, local_storage, monitor_db, qiniu_uploader, quota_service
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
    if len(img_bytes) > 50 * 1024 * 1024:
        raise HTTPException(400, "图片超过 50MB")

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

    # 6. 入历史（存储到本地 / 七牛 + 写 image_gen_history）
    #    batch_id 用 comic_style:{ts} 让前端能筛出本工具的历史
    user_id = int(current_user["id"])
    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()
    batch_id = f"comic_style:{int(time.time())}"
    style_label = (COMIC_PRESETS.get(req.style) or {}).get("label", "自定义")
    saved: List[dict] = []
    for idx, img in enumerate(images):
        b64 = img.get("b64") or ""
        local_url = ""
        qiniu_url_sync = ""
        if local_ready and b64:
            lurl, lerr = await local_storage.upload_b64(b64, user_id=user_id)
            if lurl:
                local_url = lurl
                img["url"] = lurl
            elif lerr:
                logger.warning(f"[comic_style] local write failed: {lerr}")
        if not local_url and qiniu_ready and b64:
            qurl, qerr = await qiniu_uploader.upload_b64(b64, user_id=user_id)
            if qurl:
                qiniu_url_sync = qurl
                img["url"] = qurl
            elif qerr:
                logger.warning(f"[comic_style] qiniu sync upload failed: {qerr}")
        # 上游只给 url 不给 b64（某些渠道，如 134.175.71.62/v1）→ 直接把 url 当 qiniu_url 存
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
            rid = await monitor_db.add_image_history(
                user_id=user_id,
                prompt=prompt[:1000],
                size=size,
                model=model,
                set_idx=1,
                in_set_idx=idx + 1,
                local_url=local_url,
                qiniu_url=qiniu_url_sync or local_url,
                upload_status=upload_status,
                generated_title=style_label,   # 用风格名作为标题方便历史区分
                generated_body=req.custom_prompt or "",
                batch_id=batch_id,
                source_post_url="",
                source_post_title="",
                used_reference=True,            # 漫画风永远基于参考图
            )
            saved.append({"id": rid, **img})
        except Exception as e:
            logger.warning(f"[comic_style] add_image_history failed: {e}")
            saved.append(img)

    # 7. 记 AI usage（计费统计）
    try:
        await ai_client.log_usage(
            user_id=user_id,
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
        "style_label": style_label,
        "count": len(images),
        "batch_id": batch_id,
        "images": saved,  # [{id, b64, url?}, ...]
    }


@router.get("/comic-style/history", summary="漫画风历史记录（最近 50 套）")
async def comic_style_history(
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """列出当前用户的漫画风生成历史（按 batch_id 以 comic_style: 开头筛）。
    每条 batch 聚合成一行，含张数 + 风格 + 时间 + 缩略图列表。"""
    user_id = int(current_user["id"])
    rows = await monitor_db.list_image_history(user_id=user_id, limit=max(limit * 4, 100))
    # 按 batch_id 分组
    groups: dict = {}
    for r in rows:
        bid = (r.get("batch_id") or "")
        if not bid.startswith("comic_style:"):
            continue
        groups.setdefault(bid, []).append(r)
    out = []
    for bid, items in groups.items():
        items.sort(key=lambda x: (x.get("in_set_idx") or 0))
        first = items[0]
        out.append({
            "batch_id": bid,
            "style_label": first.get("generated_title") or "",
            "custom_prompt": first.get("generated_body") or "",
            "size": first.get("size") or "",
            "model": first.get("model") or "",
            "created_at": first.get("created_at") or "",
            "count": len(items),
            "images": [
                {
                    "id": it.get("id"),
                    "url": it.get("qiniu_url") or it.get("local_url") or "",
                }
                for it in items
            ],
        })
    out.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return {"history": out[:limit]}
