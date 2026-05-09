"""仿写任务后台 worker。

调度：scheduler 每 10 秒扫一次 pending 任务。一次只处理一条任务（避免上游限流），
该任务内部按"图 + 文案"的顺序串行跑 N 套，每套写一次进度，让前端轮询能看到流式更新。

设计取舍：
- 不并发：N 套之间串行，避免上游限流 + 让前端看到稳定的进度增长
- 单点重试：每套失败重试 1 次，再失败标记该套 error 但继续下一套（不挂整个任务）
- AI 文案失败不影响图：图是核心产出，文案缺失只在 items[i].error 标注
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Optional

import httpx

from . import monitor_db
from . import qiniu_uploader
from . import local_storage
from ..routers.image_gen._common import (
    DEFAULT_SIZE, call_edits, max_per_batch_for, MAX_TOTAL,
)

logger = logging.getLogger(__name__)

REMIX_PROMPT_ZH = (
    "仿照参考图的整体视觉风格、构图、配色和氛围。"
    "**核心约束：图片中所有的中文文字必须保持完全不变**——文字内容、字体、字号、颜色、位置都不能改。"
    "其他视觉元素（背景、装饰物、辅助配色、光影）请生成有差异化的新版本，"
    "整体风格与参考图保持一致，但视觉细节和场景元素要有变化。"
    "高质量，8k，专业商品摄影质感，清晰对焦。"
)

REMIX_PROMPT_EN = (
    "Recreate the same visual style, composition, color palette and mood as the reference image. "
    "CRITICAL: keep ALL Chinese text in the image EXACTLY as in the reference — same content, "
    "same font, same size, same color, same position. Do not modify, translate, or remove any text. "
    "Generate a fresh variation of the rest of the image: change the background, decorative props, "
    "secondary colors, lighting, and ambient details so this version looks like a sibling of the reference, "
    "not a copy. High quality, 8k, professional product photography, sharp focus."
)


async def _download_ref_image(url: str) -> Optional[bytes]:
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code >= 400:
                return None
            return r.content
    except Exception:
        return None


async def _generate_caption(
    *, post_title: str, post_desc: str, set_idx: int, n_total: int,
) -> tuple[str, str, str]:
    """让 AI 基于原文案改写一份新版本（标题 + 正文）。返回 (title, body, error)。"""
    ai_base_url = (await monitor_db.get_setting("ai_base_url", "")).strip()
    ai_api_key = (await monitor_db.get_setting("ai_api_key", "")).strip()
    ai_model = (await monitor_db.get_setting("ai_model", "gpt-4o-mini")).strip() or "gpt-4o-mini"
    if not ai_base_url or not ai_api_key:
        return "", "", "AI 未配置"

    system_prompt = (
        "你是专业的小红书爆款笔记仿写者。用户给你一篇原作品的标题和正文，"
        f"你要写一份新版本（这是 {n_total} 个版本中的第 {set_idx} 个）。\n\n"
        "**核心要求**：\n"
        "1. 保留原作品的核心卖点、商品信息、关键数字（如尺码、价格、用法）\n"
        "2. 标题：18 字内，换一个完全不同的钩子句（数字 / 反问 / 反差 / 提醒），不要照抄\n"
        "3. 正文：200-300 字，3-5 段，每段开头 emoji，关键词用 ** 加粗\n"
        "4. 第一人称视角，给生活场景细节（地点 / 心情 / 对比）\n"
        "5. 结尾给 3-5 个话题标签 #xxx#\n"
        "6. 多个版本之间要明显不同：换不同的切入角度、不同的故事场景、不同的情绪基调\n\n"
        '严格按 JSON 输出，不要任何解释：{"title": "...", "body": "..."}'
    )
    user_msg = (
        f"原标题：{post_title}\n\n"
        f"原正文：{post_desc[:600]}\n\n"
        f"请写第 {set_idx} 版本。注意要与其它版本有差异化的角度。"
    )
    headers = {"Authorization": f"Bearer {ai_api_key}", "Content-Type": "application/json"}
    payload = {
        "model": ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 1.05,
        "max_tokens": 1000,
        "response_format": {"type": "json_object"},
    }
    url = f"{ai_base_url.rstrip('/')}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                return "", "", f"AI HTTP {resp.status_code}: {resp.text[:200]}"
            data = resp.json()
    except httpx.TimeoutException:
        return "", "", "AI 响应超时（45s）"
    except Exception as e:
        return "", "", f"AI 调用异常：{e}"

    content = (data.get("choices", [{}])[0].get("message", {}).get("content", "") or "").strip()
    if not content:
        return "", "", "AI 未返回内容"
    try:
        obj = json.loads(content)
        return (obj.get("title") or "").strip(), (obj.get("body") or "").strip(), ""
    except Exception:
        return "", content[:1500], ""


async def _gen_one_set(
    client: httpx.AsyncClient, *, base_url: str, api_key: str, model: str,
    size: str, ref_bytes: bytes, set_idx: int, total: int,
    post_title: str, post_desc: str, user_id: Optional[int] = None,
) -> dict:
    """生成一套：1 张图 + 1 篇文案。返回 {idx, image_url, title, body, error}。"""
    prompt = REMIX_PROMPT_EN  # 用英文 prompt，多数图像模型对英文更稳
    auth_headers = {"Authorization": f"Bearer {api_key}"}

    images = None
    last_err = ""
    for attempt in range(2):  # 最多 2 次（首发 + 1 次重试）
        result, err = await call_edits(
            client, base_url=base_url, model=model, prompt=prompt,
            n=1, size=size, img_bytes=ref_bytes, headers=auth_headers,
        )
        if result:
            images = result
            break
        last_err = (err or {}).get("error", "未知错误")
        await asyncio.sleep(1.5)

    if not images:
        return {"idx": set_idx, "image_url": "", "title": "", "body": "",
                "error": f"图片生成失败：{last_err}"}

    img = images[0]
    image_url = ""
    image_b64 = img.get("b64") or ""

    # 优先本地存储；没本地配置就同步上传七牛
    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()

    if image_b64 and local_ready:
        lurl, lerr = await local_storage.upload_b64(image_b64, user_id=user_id)
        if lurl:
            image_url = lurl
    if not image_url and image_b64 and qiniu_ready:
        qurl, qerr = await qiniu_uploader.upload_b64(image_b64, user_id=user_id)
        if qurl:
            image_url = qurl
    if not image_url:
        image_url = img.get("url") or ""

    # 文案：失败也不挂任务，记下来即可
    title, body, cerr = await _generate_caption(
        post_title=post_title, post_desc=post_desc,
        set_idx=set_idx, n_total=total,
    )

    return {
        "idx": set_idx,
        "image_url": image_url,
        "image_b64": image_b64,  # 给 history 写入用，前端响应时不会带这个
        "title": title,
        "body": body,
        "error": cerr,
    }


async def _process_task(task: dict) -> None:
    task_id = task["id"]
    user_id = task.get("user_id")
    ref_url = (task.get("ref_image_url") or "").strip()
    if not ref_url:
        await monitor_db.finish_remix_task(task_id, status="error", error="参考图 URL 为空")
        return

    base_url = (await monitor_db.get_setting("image_api_base_url", "")).strip()
    api_key = (await monitor_db.get_setting("image_api_key", "")).strip()
    model = (await monitor_db.get_setting("image_api_model", "")).strip()
    cfg_size = (await monitor_db.get_setting("image_api_size", DEFAULT_SIZE)).strip() or DEFAULT_SIZE
    if not base_url or not api_key or not model:
        await monitor_db.finish_remix_task(task_id, status="error",
                                            error="图像 API 未配置")
        return

    # 模型不支持 image edits（n>1）也无所谓，我们一次本来就只调 n=1
    _ = max_per_batch_for(model)

    size = (task.get("size") or "").strip() or cfg_size
    count = max(1, min(int(task.get("count") or 1), 30))

    ref_bytes = await _download_ref_image(ref_url)
    if not ref_bytes:
        await monitor_db.finish_remix_task(task_id, status="error",
                                            error=f"参考图下载失败：{ref_url}")
        return

    items: list[dict] = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for i in range(1, count + 1):
            try:
                item = await _gen_one_set(
                    client, base_url=base_url, api_key=api_key, model=model,
                    size=size, ref_bytes=ref_bytes,
                    set_idx=i, total=count,
                    post_title=task.get("post_title") or "",
                    post_desc=task.get("post_desc") or "",
                    user_id=user_id,
                )
            except Exception as e:
                logger.exception(f"[remix_worker] task {task_id} set {i} crash: {e}")
                item = {"idx": i, "image_url": "", "title": "", "body": "",
                        "error": f"内部异常：{e}"}

            # 写历史（成功的才写，方便后续同步飞书）
            if item.get("image_url"):
                qiniu_ready = await qiniu_uploader.is_configured()
                local_ready = await local_storage.is_configured()
                upload_status = "pending" if (local_ready and qiniu_ready) else (
                    "uploaded" if qiniu_ready and not local_ready else "skipped"
                )
                try:
                    await monitor_db.add_image_history(
                        user_id=user_id,
                        prompt=REMIX_PROMPT_EN,
                        size=size, model=model,
                        set_idx=i, in_set_idx=1,
                        local_url=item.get("image_url", ""),
                        qiniu_url=item.get("image_url", ""),
                        upload_status=upload_status,
                        generated_title=item.get("title", ""),
                        generated_body=item.get("body", ""),
                        batch_id=f"remix:{task_id}",
                        source_post_url=task.get("post_url") or "",
                        source_post_title=task.get("post_title") or "",
                        used_reference=True,
                    )
                except Exception as e:
                    logger.warning(f"[remix_worker] write history failed: {e}")

            # 进度更新（前端轮询拿这个）；image_b64 不进 db
            public_item = {k: v for k, v in item.items() if k != "image_b64"}
            items.append(public_item)
            try:
                await monitor_db.update_remix_task_progress(
                    task_id, items_json=json.dumps(items, ensure_ascii=False),
                    done_count=len(items),
                )
            except Exception as e:
                logger.warning(f"[remix_worker] update progress failed: {e}")

    # 全跑完
    failed = sum(1 for it in items if it.get("error") and not it.get("image_url"))
    if failed == count:
        await monitor_db.finish_remix_task(task_id, status="error",
                                            error="所有套均失败（详见 items）")
    else:
        await monitor_db.finish_remix_task(task_id, status="done")


async def run_once() -> dict:
    """供 scheduler 调度。一次取一条 pending 任务跑完。"""
    if not await monitor_db.has_pending_remix_tasks():
        return {"ok": True, "skipped": "no pending"}
    task = await monitor_db.claim_pending_remix_task()
    if not task:
        return {"ok": True, "skipped": "no pending"}
    logger.info(f"[remix_worker] claim task #{task['id']} count={task.get('count')}")
    try:
        await _process_task(task)
    except Exception as e:
        logger.exception(f"[remix_worker] task {task['id']} crash: {e}")
        await monitor_db.finish_remix_task(
            task["id"], status="error", error=f"worker 异常：{e}",
        )
    return {"ok": True, "task_id": task["id"]}
