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
from . import ai_client
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

# 文案改写 system prompt 模板。{n_total} {set_idx} 是占位符，渲染时替换。
# 前端"高级选项"展示这份默认让用户编辑；空时 worker 用默认。
CAPTION_PROMPT_TEMPLATE = (
    "你是专业的小红书爆款笔记仿写者。用户给你一篇原作品的标题和正文，"
    "你要写一份新版本（这是 {n_total} 个版本中的第 {set_idx} 个）。\n\n"
    "**核心要求**：\n"
    "1. 保留原作品的核心卖点、商品信息、关键数字（如尺码、价格、用法）\n"
    "2. 标题：18 字内，换一个完全不同的钩子句（数字 / 反问 / 反差 / 提醒），不要照抄\n"
    "3. 正文：200-300 字，3-5 段，每段开头 emoji，关键词用 ** 加粗\n"
    "4. 第一人称视角，给生活场景细节（地点 / 心情 / 对比）\n"
    "5. 结尾给 3-5 个话题标签 #xxx#\n"
    "6. 多个版本之间要明显不同：换不同的切入角度、不同的故事场景、不同的情绪基调\n\n"
    '严格按 JSON 输出，不要任何解释：{{"title": "...", "body": "..."}}'
)


def _prompt_with_caption(
    caption_title: str, caption_body: str, style_keywords: str = "",
    base_prompt: str = "",
    unified_style: bool = False,
) -> str:
    """把当前套的"变种文案主题" + 用户自定义风格关键词 注入图片 prompt。

    unified_style=True 时：不注入每套文案主题，多套图风格统一（由 base_prompt
    和 style_keywords 决定基调）。文案仍按 _generate_caption 每套不同。
    """
    parts = [(base_prompt or REMIX_PROMPT_EN).strip()]
    theme = "" if unified_style else (caption_title or caption_body or "").strip()
    if theme:
        theme = theme[:200].replace("\n", " ").strip()
        parts.append(
            f'Additional theme guidance for this variant: "{theme}". '
            "Adapt the background mood, lighting and decorative props to match this theme, "
            "while keeping the main subject and any Chinese text completely unchanged."
        )
    sk = (style_keywords or "").strip()
    if sk:
        sk = sk[:120].replace("\n", " ").strip()
        parts.append(
            f'Visual style requirement (highest priority): {sk}. '
            "Apply this style to the entire image — colors, lighting, texture, "
            "composition mood — while still keeping subject and Chinese text intact."
        )
    return "\n\n".join(parts)


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
    prompt_template: str = "",
    user_id: Optional[int] = None,
    model_id: Optional[int] = None,  # P15.7: 任务指定模型
) -> tuple[str, str, str]:
    """让 AI 基于原文案改写一份新版本（标题 + 正文）。返回 (title, body, error)。"""
    # 用用户传入的模板（若有）或默认模板；占位符 {n_total} {set_idx} 渲染时替换
    tpl = (prompt_template or "").strip() or CAPTION_PROMPT_TEMPLATE
    try:
        system_prompt = tpl.format(n_total=n_total, set_idx=set_idx)
    except (KeyError, IndexError, ValueError):
        system_prompt = CAPTION_PROMPT_TEMPLATE.format(n_total=n_total, set_idx=set_idx)
    user_msg = (
        f"原标题：{post_title}\n\n"
        f"原正文：{post_desc[:600]}\n\n"
        f"请写第 {set_idx} 版本。注意要与其它版本有差异化的角度。"
    )
    try:
        content = await ai_client.call_text(
            user_msg,
            system_prompt=system_prompt,
            model_id=model_id,
            user_id=user_id,
            feature="remix_caption",
            temperature=1.05,
            max_tokens=1000,
            timeout=45.0,
            extra_payload={"response_format": {"type": "json_object"}},
        )
    except ai_client.AIModelNotConfigured as e:
        return "", "", str(e)
    except Exception as e:
        return "", "", f"AI 调用异常：{e}"

    content = (content or "").strip()
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
    image_model_row_id: int = 0,
    image_max_concurrent: int = 0,
) -> dict:
    """对一张参考图调一次 edits，返回 {image_url, image_b64, error}。

    prompt 默认用通用 REMIX_PROMPT_EN；调用方可注入"文案主题"个性化 prompt。
    P15.8: 走模型级并发控制（acquire_slot）。
    """
    auth_headers = {"Authorization": f"Bearer {api_key}"}

    images = None
    last_err = ""
    for attempt in range(2):
        async with ai_client.acquire_slot(image_model_row_id, image_max_concurrent):
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
    style_keywords: str = "",
    image_prompt_override: str = "",
    caption_prompt_template: str = "",
    unified_style: bool = False,
    text_model_id: Optional[int] = None,  # P15.7: 任务指定的文本模型
    image_model_row_id: int = 0,           # P15.8
    image_max_concurrent: int = 0,         # P15.8
    progress_cb=None,
    cancel_check=None,
) -> dict:
    """生成一套：1 篇文案 → K 张图（套内 K 张并发）。

    流程：
      1. _generate_caption 生成 1 篇变种文案
      2. _prompt_with_caption 把文案主题 + 用户 style_keywords 拼进 image prompt
      3. asyncio.gather K 张图同时调 image edits API
         （vs 老逻辑串行：5 张图从 2.5 分钟压到 ~30s）

    progress_cb(stage, payload) 在文案完成 / 每张图完成时回调，让 worker
    流式写 items_json。并发时多个回调可能同时到，调用方自己保证线程安全。

    cancel_check() -> bool：返回 True 表示任务已被用户取消，函数应早退。
    """
    images: list = [{"image_url": "", "error": ""} for _ in refs_bytes]

    async def _emit(title: str, body: str, cerr: str):
        if progress_cb is not None:
            await progress_cb("update", {
                "idx": set_idx,
                "title": title, "body": body,
                "images": [dict(im) for im in images],
                "image_url": next((im["image_url"] for im in images if im.get("image_url")), ""),
                "error": cerr,
            })

    # ── 第 1 步：文案 ────────────────────────────────────────────────────
    if cancel_check and await cancel_check():
        return {"idx": set_idx, "images": images, "image_url": "",
                "title": "", "body": "", "error": "任务已取消"}
    title, body, cerr = await _generate_caption(
        post_title=post_title, post_desc=post_desc,
        set_idx=set_idx, n_total=total,
        prompt_template=caption_prompt_template,
        user_id=user_id,
        model_id=text_model_id,
    )
    await _emit(title, body, cerr)

    # ── 第 2 步：派生 prompt ─────────────────────────────────────────────
    image_prompt = _prompt_with_caption(
        title, body, style_keywords=style_keywords,
        base_prompt=image_prompt_override,
        unified_style=unified_style,
    )

    # ── 第 3 步：套内 K 张并发 ───────────────────────────────────────────
    if cancel_check and await cancel_check():
        return {"idx": set_idx, "images": images, "image_url": "",
                "title": title, "body": body, "error": "任务已取消"}

    sem = asyncio.Lock()  # 保护 images 列表 + progress 顺序

    async def _one_with_progress(j: int, ref_bytes: bytes):
        result = await _gen_one_image(
            client, base_url=base_url, api_key=api_key, model=model,
            size=size, ref_bytes=ref_bytes, user_id=user_id,
            prompt=image_prompt,
            image_model_row_id=image_model_row_id,
            image_max_concurrent=image_max_concurrent,
        )
        async with sem:
            images[j] = result
            await _emit(title, body, cerr)

    await asyncio.gather(
        *[_one_with_progress(j, rb) for j, rb in enumerate(refs_bytes)],
        return_exceptions=True,
    )

    succeeded = [im for im in images if im.get("image_url")]
    primary = succeeded[0] if succeeded else {}
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
    # P15.7: 任务可携带显式的 AI 模型 row_id；不传走用户偏好 / 系统默认
    task_text_model_id = task.get("text_model_id")
    task_image_model_id = task.get("image_model_id")

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

    # P15: 通过 ai_client 解析图像模型（多渠道 + 用户偏好 + 任务显式选择）
    try:
        _img_cfg = await ai_client.get_active_model_config(
            usage_type="image", user_id=user_id, model_id=task_image_model_id,
        )
    except ai_client.AIModelNotConfigured as e:
        await monitor_db.finish_remix_task(task_id, status="error", error=str(e))
        return
    base_url = _img_cfg["base_url"]
    api_key = _img_cfg["api_key"]
    model = _img_cfg["model_id"]
    cfg_size = (_img_cfg.get("extra_config") or {}).get("size") or DEFAULT_SIZE
    img_model_row_id = int(_img_cfg.get("model_row_id") or 0)
    img_max_concurrent = int(_img_cfg.get("max_concurrent") or 0)  # P15.8
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

    style_keywords = (task.get("style_keywords") or "").strip()
    image_prompt_override = (task.get("image_prompt") or "").strip()
    caption_prompt_template = (task.get("caption_prompt") or "").strip()
    unified_style = bool(task.get("unified_style"))

    async def _is_cancelled() -> bool:
        try:
            st = await monitor_db.get_remix_task_status(task_id)
            return st == "cancelled"
        except Exception:
            return False

    items: list[dict] = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for i in range(1, count + 1):
            # 套间检查取消（套内并发到 _gen_one_set 里有更细的检查）
            if await _is_cancelled():
                logger.info(f"[remix_worker] task {task_id} cancelled at set {i}/{count}")
                break

            # 流式进度回调：每完成"文案/单张图"就把当前套写到 items_json
            async def _progress(stage: str, partial: dict):
                snapshot = list(items)
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
                        done_count=len(items),
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
                    style_keywords=style_keywords,
                    image_prompt_override=image_prompt_override,
                    caption_prompt_template=caption_prompt_template,
                    unified_style=unified_style,
                    text_model_id=task_text_model_id,  # P15.7
                    image_model_row_id=img_model_row_id,    # P15.8
                    image_max_concurrent=img_max_concurrent,
                    progress_cb=_progress,
                    cancel_check=_is_cancelled,
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

    # 末尾再查一次：用户中途取消就保留 cancelled 状态，不要 done/error 覆盖
    if await _is_cancelled():
        logger.info(f"[remix_worker] task {task_id} ended in cancelled state")
        return
    failed = sum(1 for it in items if it.get("error") and not it.get("image_url"))
    if failed >= count:
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
