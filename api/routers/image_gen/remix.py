# -*- coding: utf-8 -*-
"""作品仿写：粘贴链接 → 异步生成 N 套（图 + 文案）。

异步任务流：
1. POST /remix-tasks 提交（仅入队，立即返回 task_id）
2. scheduler 后台 worker 取 pending 任务，逐套生图 + AI 写文案
3. GET /remix-tasks/{id} 轮询进度
"""
from __future__ import annotations

import base64
import logging
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ...services import monitor_db, monitor_fetcher, quota_service
from ...services.platforms import detect_platform

logger = logging.getLogger(__name__)

router = APIRouter()


class FetchPostRequest(BaseModel):
    """粘贴作品 URL → 返回所有图（前端选用哪张作参考）+ 文案。"""
    url: str


class CreateRemixTaskRequest(BaseModel):
    post_url: str
    # 多图（v2）：选哪几张作参考。优先用这个；空时 fallback ref_image_idx
    ref_image_idxs: Optional[List[int]] = None
    ref_image_idx: int = 0       # v1 向后兼容
    count: int = 5               # 1–30 套
    size: Optional[str] = None   # 留空用配置默认
    # 用户自定义风格关键词，附加到 image edits prompt 末尾（"日系简约"等）
    style_keywords: Optional[str] = ""
    # 高级：用户自定义 prompt（留空走默认模板）
    image_prompt: Optional[str] = ""     # 图片生成 prompt 模板（替代 REMIX_PROMPT_EN）
    caption_prompt: Optional[str] = ""   # 文案改写 system_prompt（替代 _generate_caption 默认）
    # 统一风格：开启时多套图共享同一份 image prompt（不注入每套差异化的文案主题）
    unified_style: Optional[bool] = False
    # P15.7: 可选指定 AI 模型 row id（null = 用用户偏好 / 系统默认）
    text_model_id: Optional[int] = None
    image_model_id: Optional[int] = None

    model_config = {"protected_namespaces": ()}


async def _fetch_image_dataurl(url: str, platform: str) -> str:
    """下载平台 CDN 图，返回 data:image/...;base64,... 串。失败返回空字符串。

    平台 CDN（小红书/抖音/公众号）有强防盗链：浏览器直拉 → 403。
    后端在服务端拉取（带正确 Referer），然后把图嵌进 data URL 给前端，
    前端就完全绕开 CDN 限制 / 代理白名单 / mixed content 的问题。
    """
    if not url:
        return ""
    referer = ""
    if platform == "xhs":
        referer = "https://www.xiaohongshu.com/"
    elif platform == "douyin":
        referer = "https://www.douyin.com/"
    elif platform == "mp":
        referer = "https://mp.weixin.qq.com/"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
    }
    if referer:
        headers["Referer"] = referer
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            if r.status_code != 200 or not r.content:
                return ""
            ct = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
            if not ct.startswith("image/"):
                # 没拿到图片（HTML 错误页等）
                return ""
            b64 = base64.b64encode(r.content).decode("ascii")
            return f"data:{ct};base64,{b64}"
    except Exception as e:
        logger.warning(f"[remix/fetch-cover] download failed {url[:80]}: {e}")
        return ""


@router.get("/remix-default-prompts", summary="获取仿写默认 prompt 模板（图片 + 文案）")
async def remix_default_prompts(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """前端"高级选项"展示+编辑默认 prompt 模板。
    用户留空时 worker 用这套默认；填了就用用户的覆盖。
    caption_prompt 里 {n_total} 和 {set_idx} 是占位符，worker 渲染时替换。
    """
    from ..services.remix_worker import REMIX_PROMPT_EN, CAPTION_PROMPT_TEMPLATE
    return {
        "image_prompt": REMIX_PROMPT_EN,
        "caption_prompt": CAPTION_PROMPT_TEMPLATE,
    }


@router.post("/fetch-post-cover", summary="拉取作品所有图 + 文案（仿写第一步）")
async def fetch_post_cover(
    req: FetchPostRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """返回 {images: [data-url-or-cdn-url, ...], image_urls: [原 CDN URL...], title, ...}。

    实现要点：
      - 后端先用正确的 Referer 把每张图下载下来 base64 内嵌，前端用 data: 渲染
        ⇒ 不需要代理路由、不被 CDN 防盗链拦截、不存在 mixed content。
      - 同时返回 image_urls（原 CDN URL）让 worker 提交任务时还能用 URL 引用。
      - 多张图并发下载，单张超时 15s。
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
        reason_map = {
            "deleted": "笔记已被删除 / 仅自己可见 / 被屏蔽。请换一篇匿名能打开的链接。",
            "login_required": "该链接需要登录态（XHS 跳转登录页）。请用「分享」链接（xsec_source=app_share）。",
            "error": "抓取失败，可能被风控或链接已失效，过几分钟重试。",
        }
        return {"error": reason_map.get(status, f"作品抓取失败（status={status}）")}

    image_urls = list(metrics.get("images") or [])
    cover_url = metrics.get("cover_url") or ""
    if cover_url and cover_url not in image_urls:
        image_urls.insert(0, cover_url)
    if not image_urls:
        return {"error": "未能从作品中提取到任何图片"}

    # 之前会把每张图 base64 内嵌进响应，导致 response 体积 N×MB（10 张图 ~14MB），
    # 经 cloudflare tunnel 慢得离谱。前端早已支持 proxyUrl() 走 /monitor/image/proxy
    # 代理拉图（带 Referer 绕 CDN 防盗链），不再需要内嵌 → response 几 KB，秒回。
    return {
        "images": image_urls,           # 展示用：前端 proxyUrl() 包裹后渲染
        "image_urls": image_urls,       # 原 CDN URL：worker 提交任务时引用
        "title": metrics.get("title") or "",
        "desc": (metrics.get("desc") or "")[:500],
        "platform": plat.name,
        "platform_label": plat.label,
        "post_id": info["post_id"],
        "post_url": info.get("url") or raw_url,
    }


@router.post("/remix-tasks", summary="提交仿写任务（异步）")
async def create_remix_task(
    req: CreateRemixTaskRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    if not (req.post_url or "").strip():
        raise HTTPException(status_code=400, detail="post_url 必填")
    count = max(1, min(int(req.count or 1), 30))

    # 选哪几张作为参考：v2 多选（ref_image_idxs）优先，v1 单选（ref_image_idx）兜底
    raw_idxs = req.ref_image_idxs if req.ref_image_idxs else [int(req.ref_image_idx or 0)]
    # 去重并保序，且都 >= 0
    seen: set = set()
    ref_idxs: List[int] = []
    for i in raw_idxs:
        v = max(0, int(i))
        if v in seen:
            continue
        seen.add(v)
        ref_idxs.append(v)
    if not ref_idxs:
        ref_idxs = [0]

    # 配额检查：每套图数 = len(ref_idxs)，套数 = count，总用量 = count * len(ref_idxs)
    # 仍按"套数"扣（用户感知一致），实际生图调用次数翻倍
    await quota_service.check_or_raise(current_user, "daily_remix_sets", delta=count)

    # 立刻先解析一次，验证可达 + 拿参考图 URL，避免任务跑起来才发现链接挂了
    plat = detect_platform(req.post_url)
    if not plat:
        raise HTTPException(status_code=400, detail="无法识别平台")
    info = await plat.resolve_url(req.post_url)
    if not info:
        raise HTTPException(status_code=400, detail="URL 解析失败")

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
        raise HTTPException(status_code=400, detail=f"作品抓取失败（status={status}）")

    imgs = list(metrics.get("images") or [])
    cover = metrics.get("cover_url") or ""
    if cover and cover not in imgs:
        imgs.insert(0, cover)
    if not imgs:
        raise HTTPException(status_code=400, detail="该作品没有图片可作为参考")

    # 越界的 idx 截掉；如果一个都不剩兜底成 [0]
    ref_idxs = [i for i in ref_idxs if i < len(imgs)] or [0]
    ref_urls = [imgs[i] for i in ref_idxs]

    user_id = current_user.get("id") if current_user else None
    task_id = await monitor_db.create_remix_task(
        user_id=user_id,
        post_url=req.post_url,
        post_title=metrics.get("title") or "",
        post_desc=(metrics.get("desc") or "")[:1000],
        platform=plat.name,
        ref_image_url=ref_urls[0],
        ref_image_idx=ref_idxs[0],
        ref_image_urls=ref_urls,
        ref_image_idxs=ref_idxs,
        count=count,
        size=(req.size or "").strip(),
        style_keywords=(req.style_keywords or "").strip(),
        image_prompt=(req.image_prompt or "").strip(),
        caption_prompt=(req.caption_prompt or "").strip(),
        unified_style=bool(req.unified_style),
        text_model_id=req.text_model_id,
        image_model_id=req.image_model_id,
    )

    try:
        await quota_service.record_usage(user_id, "remix_sets", delta=count)
    except Exception as e:
        logger.warning(f"[remix] record_usage failed: {e}")

    # 提交即唤醒：不等下个心跳（默认 10s）才开始处理
    try:
        from ...services import remix_worker as _rw
        import asyncio as _asyncio
        _asyncio.create_task(_rw.run_once())
    except Exception as e:
        logger.warning(f"[remix] kick worker failed (will fall back to next heartbeat): {e}")

    return {
        "task_id": task_id,
        "status": "pending",
        "count": count,
        "refs_per_set": len(ref_idxs),
    }


@router.post("/remix-tasks/{task_id}/cancel", summary="取消仿写任务")
async def cancel_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """取消进行中或排队中的任务。worker 跑完当前一套后会检查并提前退出。"""
    task = await monitor_db.get_remix_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and task.get("user_id") != current_user.get("id"):
        raise HTTPException(status_code=403, detail="无权操作此任务")
    if task.get("status") not in ("pending", "running"):
        return {"ok": False, "message": f"任务当前状态 {task.get('status')}，无需取消"}
    user_id = current_user.get("id") if role != "admin" else None
    affected = await monitor_db.cancel_remix_task(task_id, user_id=user_id)
    return {"ok": affected, "task_id": task_id}


@router.post("/remix-tasks/{task_id}/clone", summary="用相同参数重新生成（重试整个任务）")
async def clone_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """用相同参数复制一个新任务（推回队列），用于"重新生成"按钮。

    比较：
      - cancel = 停掉当前任务
      - clone  = 用同样的输入重做一次（拿到新 task_id）
    """
    src = await monitor_db.get_remix_task(task_id)
    if not src:
        raise HTTPException(status_code=404, detail="任务不存在")
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and src.get("user_id") != current_user.get("id"):
        raise HTTPException(status_code=403, detail="无权操作此任务")

    import json as _json
    user_id = src.get("user_id")
    ref_urls: list = []
    ref_idxs: list = []
    raw_urls = (src.get("ref_image_urls") or "").strip()
    raw_idxs = (src.get("ref_image_idxs") or "").strip()
    if raw_urls:
        try:
            ref_urls = list(_json.loads(raw_urls))
        except Exception:
            pass
    if raw_idxs:
        try:
            ref_idxs = list(_json.loads(raw_idxs))
        except Exception:
            pass
    if not ref_urls:
        ref_urls = [src.get("ref_image_url") or ""]
        ref_idxs = [int(src.get("ref_image_idx") or 0)]

    count = max(1, min(int(src.get("count") or 1), 30))
    await quota_service.check_or_raise(current_user, "daily_remix_sets", delta=count)
    new_id = await monitor_db.create_remix_task(
        user_id=user_id,
        post_url=src.get("post_url") or "",
        post_title=src.get("post_title") or "",
        post_desc=src.get("post_desc") or "",
        platform=src.get("platform") or "xhs",
        ref_image_url=ref_urls[0] if ref_urls else "",
        ref_image_idx=ref_idxs[0] if ref_idxs else 0,
        ref_image_urls=ref_urls,
        ref_image_idxs=ref_idxs,
        count=count,
        size=(src.get("size") or "").strip(),
        style_keywords=(src.get("style_keywords") or "").strip(),
        image_prompt=(src.get("image_prompt") or "").strip(),
        caption_prompt=(src.get("caption_prompt") or "").strip(),
        text_model_id=src.get("text_model_id"),
        image_model_id=src.get("image_model_id"),
    )
    try:
        await quota_service.record_usage(user_id, "remix_sets", delta=count)
    except Exception as e:
        logger.warning(f"[remix] clone record_usage failed: {e}")
    try:
        from ...services import remix_worker as _rw
        import asyncio as _asyncio
        _asyncio.create_task(_rw.run_once())
    except Exception:
        pass
    return {"task_id": new_id, "cloned_from": task_id, "status": "pending"}


@router.get("/remix-tasks/{task_id}", summary="查询仿写任务进度 + 结果")
async def get_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    task = await monitor_db.get_remix_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and task.get("user_id") != current_user.get("id"):
        raise HTTPException(status_code=403, detail="无权查看")
    return task


@router.get("/remix-tasks", summary="我的仿写任务列表")
async def list_remix_tasks(
    limit: int = 30,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """「我的任务」 — 始终按当前用户隔离，admin 也只看自己的（自己用工具时的任务）。
    admin 要查别人的任务请走 admin 后台（如有专门页面）。"""
    user_id = current_user.get("id") if current_user else None
    rows = await monitor_db.list_remix_tasks(
        user_id=user_id, limit=max(1, min(limit, 100)),
    )
    return {"tasks": rows}


@router.delete("/remix-tasks/{task_id}", summary="删除仿写任务")
async def delete_remix_task(
    task_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    task = await monitor_db.get_remix_task(task_id)
    if not task:
        return {"ok": False, "error": "任务不存在"}
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and task.get("user_id") != current_user.get("id"):
        return {"ok": False, "error": "无权操作"}
    await monitor_db.delete_remix_task(task_id)
    return {"ok": True}
