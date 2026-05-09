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


def _prompt_with_caption(caption_title: str, caption_body: str) -> str:
    """把当前套的"变种文案主题"注入图片 prompt，让图与文案氛围一致。

    用户期望的流程：先生成文案 → 用文案主题做图 prompt → 调 API 换背景换风格。
    这里只取标题/正文前 200 字作为风格提示，避免 prompt 过长被截断。
    """
    theme = (caption_title or caption_body or "").strip()
    if not theme:
        return REMIX_PROMPT_EN
    theme = theme[:200].replace("\n", " ").strip()
    return (
        REMIX_PROMPT_EN
        + f"\n\nAdditional theme guidance for this variant: \"{theme}\". "
        + "Adapt the background mood, lighting and decorative props to match this theme, "
        + "while keeping the main subject and any Chinese text completely unchanged."
    )


def _platform_referer(url: str) -> str:
    """根据 URL host 选合适的 Referer 绕 CDN 防盗链。"""
    h = url.lower()
    if "xhscdn.com" in h or "xiaohongshu.com" in h:
        return "https://www.xiaohongshu.com/"
    if "douyinpic.com" in h or "byteimg.com" in h or "bytedance.com" in h:
        return "https://www.douyin.com/"
    if "qpic.cn" in h or "weixin.qq.com" in h:
        return "https://mp.weixin.qq.com/"
    return ""


async def _download_ref_image(url: str) -> Optional[bytes]:
    """带 Referer + 桌面 UA 下载参考图。XHS/抖音/公众号 CDN 防盗链很硬，
    不带 Referer 会 403。"""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
    }
    referer = _platform_referer(url)
    if referer:
        headers["Referer"] = referer
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            if r.status_code >= 400:
                logger.warning(
                    f"[remix_worker] ref download HTTP {r.status_code}: {url[:80]}"
                )
                return None
            return r.content
    except Exception as e:
        logger.warning(f"[remix_worker] ref download exception ({e}): {url[:80]}")
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


async def _gen_one_image(
    client: httpx.AsyncClient, *, base_url: str, api_key: str, model: str,
    size: str, ref_bytes: bytes, user_id: Optional[int] = None,
    prompt: str = REMIX_PROMPT_EN,
) -> dict:
    """对一张参考图调一次 edits，返回 {image_url, image_b64, error}。

    prompt 默认用通用 REMIX_PROMPT_EN；调用方可注入"文案主题"个性化 prompt。
    """
    auth_headers = {"Authorization": f"Bearer {api_key}"}

    images = None
    last_err = ""
    for attempt in range(2):
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
        return {"image_url": "", "image_b64": "", "error": f"图片生成失败：{last_err}"}

    img = images[0]
    image_b64 = img.get("b64") or ""
    image_url = ""

    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()
    if image_b64 and local_ready:
        lurl, _ = await local_storage.upload_b64(image_b64, user_id=user_id)
        if lurl:
            image_url = lurl
    if not image_url and image_b64 and qiniu_ready:
        qurl, _ = await qiniu_uploader.upload_b64(image_b64, user_id=user_id)
        if qurl:
            image_url = qurl
    if not image_url:
        image_url = img.get("url") or ""

    return {"image_url": image_url, "image_b64": image_b64, "error": ""}


async def _gen_one_set(
    client: httpx.AsyncClient, *, base_url: str, api_key: str, model: str,
    size: str, refs_bytes: list, set_idx: int, total: int,
    post_title: str, post_desc: str, user_id: Optional[int] = None,
    progress_cb=None,
) -> dict:
    """生成一套：1 篇文案 → K 张图（用文案主题派生图 prompt，每张参考图各换一次）。

    流程顺序（响应用户期望）：
      1. 先调 AI 生成变种文案（标题+正文）—— 几秒
      2. 用文案主题派生 image edits prompt
      3. 对每张主体图调 image edits API 换背景换风格

    progress_cb(stage, payload) 在每个里程碑回调，让 worker 写中间进度，
    让前端能流式看到「文案出来了 → 第 1 张图出来了 → 第 2 张图... 」。
    """
    # ── 第 1 步：先出文案 ────────────────────────────────────────────────
    title, body, cerr = await _generate_caption(
        post_title=post_title, post_desc=post_desc,
        set_idx=set_idx, n_total=total,
    )
    # 立刻汇报"文案完成"给前端
    if progress_cb is not None:
        await progress_cb("caption_done", {
            "idx": set_idx,
            "title": title, "body": body,
            "images": [{"image_url": "", "error": ""}] * len(refs_bytes),
            "image_url": "",
            "error": cerr,
        })

    # ── 第 2 步：用文案主题派生 image prompt ─────────────────────────────
    image_prompt = _prompt_with_caption(title, body)

    # ── 第 3 步：对每张参考图调 edits ────────────────────────────────────
    images: list = []
    for j, ref_bytes in enumerate(refs_bytes):
        single = await _gen_one_image(
            client, base_url=base_url, api_key=api_key, model=model,
            size=size, ref_bytes=ref_bytes, user_id=user_id,
            prompt=image_prompt,
        )
        images.append(single)
        if progress_cb is not None:
            await progress_cb("image_done", {
                "idx": set_idx,
                "title": title, "body": body,
                "images": images + [{"image_url": "", "error": ""}] * (len(refs_bytes) - len(images)),
                "image_url": (images[0].get("image_url") or "") if images else "",
                "error": cerr,
            })

    succeeded = [im for im in images if im.get("image_url")]
    primary = succeeded[0] if succeeded else (images[0] if images else {})
    item_error = ""
    if not succeeded:
        errs = [im.get("error", "") for im in images if im.get("error")]
        item_error = "; ".join(errs)[:200] or "本套所有图均生成失败"
    elif len(succeeded) < len(images):
        item_error = f"部分失败（成功 {len(succeeded)}/{len(images)}）"

    return {
        "idx": set_idx,
        "images": images,
        "image_url": primary.get("image_url", ""),
        "title": title,
        "body": body,
        "error": item_error or cerr,
    }


async def _process_task(task: dict) -> None:
    task_id = task["id"]
    user_id = task.get("user_id")

    # 解析参考图列表：v2 优先用 ref_image_urls(JSON)，v1 fallback 单值字段
    ref_urls: list = []
    raw_urls = (task.get("ref_image_urls") or "").strip()
    if raw_urls:
        try:
            parsed = json.loads(raw_urls)
            if isinstance(parsed, list):
                ref_urls = [str(u) for u in parsed if u]
        except Exception:
            ref_urls = []
    if not ref_urls:
        single = (task.get("ref_image_url") or "").strip()
        if single:
            ref_urls = [single]
    if not ref_urls:
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
    _ = max_per_batch_for(model)

    size = (task.get("size") or "").strip() or cfg_size
    count = max(1, min(int(task.get("count") or 1), 30))

    # 并发下载所有参考图
    refs_bytes_with_idx: list = []
    for idx, url in enumerate(ref_urls):
        b = await _download_ref_image(url)
        if b is None:
            logger.warning(f"[remix_worker] ref #{idx} download failed: {url[:80]}")
            continue
        refs_bytes_with_idx.append((idx, b))
    if not refs_bytes_with_idx:
        await monitor_db.finish_remix_task(
            task_id, status="error", error=f"全部 {len(ref_urls)} 张参考图都下载失败",
        )
        return
    refs_bytes = [b for (_, b) in refs_bytes_with_idx]

    items: list[dict] = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for i in range(1, count + 1):
            # 流式进度回调：每完成"文案/单张图"就把当前套写到 items_json
            async def _progress(stage: str, partial: dict):
                # 用 partial 临时覆盖 items 末尾位置（i 对应 items[i-1]）
                snapshot = list(items)
                # 剥 image_b64
                clean = dict(partial)
                if "images" in clean:
                    clean["images"] = [
                        {kk: vv for kk, vv in (sub or {}).items() if kk != "image_b64"}
                        for sub in clean["images"]
                    ]
                snapshot.append(clean)
                try:
                    await monitor_db.update_remix_task_progress(
                        task_id, items_json=json.dumps(snapshot, ensure_ascii=False),
                        done_count=len(items),  # 仍按"完成的套数"算（部分进度不+）
                    )
                except Exception:
                    pass

            try:
                item = await _gen_one_set(
                    client, base_url=base_url, api_key=api_key, model=model,
                    size=size, refs_bytes=refs_bytes,
                    set_idx=i, total=count,
                    post_title=task.get("post_title") or "",
                    post_desc=task.get("post_desc") or "",
                    user_id=user_id,
                    progress_cb=_progress,
                )
            except Exception as e:
                logger.exception(f"[remix_worker] task {task_id} set {i} crash: {e}")
                item = {"idx": i, "images": [], "image_url": "",
                        "title": "", "body": "",
                        "error": f"内部异常：{e}"}

            # 写历史：套号 i 下，每张成功的图占一行（in_set_idx 1..K）
            qiniu_ready = await qiniu_uploader.is_configured()
            local_ready = await local_storage.is_configured()
            upload_status = "pending" if (local_ready and qiniu_ready) else (
                "uploaded" if qiniu_ready and not local_ready else "skipped"
            )
            in_set = 0
            for sub in (item.get("images") or []):
                if not sub.get("image_url"):
                    continue
                in_set += 1
                try:
                    await monitor_db.add_image_history(
                        user_id=user_id,
                        prompt=REMIX_PROMPT_EN,
                        size=size, model=model,
                        set_idx=i, in_set_idx=in_set,
                        local_url=sub.get("image_url", ""),
                        qiniu_url=sub.get("image_url", ""),
                        upload_status=upload_status,
                        # 文案只在第一张写，避免一套同一篇文案被重复存
                        generated_title=item.get("title", "") if in_set == 1 else "",
                        generated_body=item.get("body", "") if in_set == 1 else "",
                        batch_id=f"remix:{task_id}",
                        source_post_url=task.get("post_url") or "",
                        source_post_title=task.get("post_title") or "",
                        used_reference=True,
                    )
                except Exception as e:
                    logger.warning(f"[remix_worker] write history failed: {e}")

            # 进度（image_b64 不进 db；嵌套结构里也剥掉）
            public_item = {k: v for k, v in item.items() if k != "image_b64"}
            if "images" in public_item:
                public_item["images"] = [
                    {kk: vv for kk, vv in (sub or {}).items() if kk != "image_b64"}
                    for sub in public_item["images"]
                ]
            items.append(public_item)
            try:
                await monitor_db.update_remix_task_progress(
                    task_id, items_json=json.dumps(items, ensure_ascii=False),
                    done_count=len(items),
                )
            except Exception as e:
                logger.warning(f"[remix_worker] update progress failed: {e}")

    failed = sum(1 for it in items if it.get("error") and not it.get("image_url"))
    if failed == count:
        await monitor_db.finish_remix_task(task_id, status="error",
                                            error="所有套均失败（详见 items）")
    else:
        await monitor_db.finish_remix_task(task_id, status="done")


async def run_once() -> dict:
    """供 scheduler 调度。一次取一条 pending 任务跑完。

    心跳开头先复活僵尸 running 任务（worker 进程 kill / service 重启会留下
    永远卡在 running 的任务），让它们重新进入 pending 队列被 claim。
    """
    try:
        revived = await monitor_db.revive_stuck_running_remix_tasks(stuck_minutes=5)
        if revived > 0:
            logger.info(f"[remix_worker] revived {revived} stuck running task(s) → pending")
    except Exception as e:
        logger.warning(f"[remix_worker] revive check failed: {e}")

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
