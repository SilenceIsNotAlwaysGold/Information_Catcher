"""文本仿写任务后台 worker（对标 remix_worker）。

调度：scheduler 每 10 秒扫一次 pending 任务，一次跑一条。
任务结构：每套 = N源 × M背景 张图（笛卡尔积）；count 套 = count × N × M 张总图。

设计取舍：
- 套间串行（让前端按"第 N 套"清晰看到进度）
- 套内并发（受 image 模型的 max_concurrent 兜底限流）
- 每张图独立成功/失败（一张失败不挂整个套）
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

import httpx

from . import monitor_db, qiniu_uploader, local_storage, ai_client
from ..routers.image_gen._common import DEFAULT_SIZE, call_edits

logger = logging.getLogger(__name__)


def _build_prompt(text: str, style_hint: str = "") -> str:
    """文本仿写 prompt：用背景图作风格模板，把目标文字按背景风格重绘。"""
    p = (
        "Generate a new image using the reference image as the visual style template "
        "(background layout, color palette, lighting, decorative elements, overall mood). "
        "Render the following Chinese text ON the image as prominent typography, "
        "using a font that matches the style of the reference. Keep typography balanced "
        "and visually consistent with the reference image.\n\n"
        f'TEXT TO RENDER (preserve line breaks EXACTLY):\n"""\n{text[:600]}\n"""\n\n'
    )
    if style_hint.strip():
        p += f"Additional style hint: {style_hint[:120]}.\n"
    p += "High quality 8k professional design, sharp typography."
    return p


async def _download_bg(url: str) -> Optional[bytes]:
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
            return r.content
    except Exception as e:
        logger.warning(f"[text_remix_worker] bg download failed ({e}): {url[:80]}")
        return None


async def _upload_image(b64: str, user_id: Optional[int]) -> str:
    """优先本地存储，七牛兜底。失败返回空串。"""
    if not b64:
        return ""
    if await local_storage.is_configured():
        url, _ = await local_storage.upload_b64(b64, user_id=user_id)
        if url:
            return url
    if await qiniu_uploader.is_configured():
        url, _ = await qiniu_uploader.upload_b64(b64, user_id=user_id)
        if url:
            return url
    return ""


async def _gen_one_cell(
    client: httpx.AsyncClient, *,
    base_url: str, api_key: str, model: str, size: str,
    bg_bytes: bytes, prompt: str,
    image_model_row_id: int, image_max_concurrent: int,
    user_id: Optional[int],
) -> dict:
    """生成一张图（一格 = 一个 src×bg 组合）。带重试 + 模型并发限流 + 用量日志。
    返回 {image_url, b64, error}。
    """
    auth_headers = {"Authorization": f"Bearer {api_key}"}
    _FATAL = ("Unauthorized", "Forbidden", "invalid api key",
              "model not found", "policy violation", "safety system")
    last_err = ""
    images = None
    t0 = time.perf_counter()
    for attempt in range(4):
        async with ai_client.acquire_slot(image_model_row_id, image_max_concurrent):
            imgs, err = await call_edits(
                client, base_url=base_url, model=model, prompt=prompt,
                n=1, size=size, img_bytes=bg_bytes, headers=auth_headers,
            )
        if imgs:
            images = imgs
            break
        last_err = (err or {}).get("error", "未知")
        if any(kw.lower() in last_err.lower() for kw in _FATAL):
            break
        if attempt < 3:
            await asyncio.sleep(min(1.5 * (2 ** attempt), 8.0))
    ms = int((time.perf_counter() - t0) * 1000)
    try:
        await ai_client.log_usage(
            user_id=user_id, model_row_id=image_model_row_id,
            model_id_str=model, usage_type="image", feature="text_remix",
            image_count=1 if images else 0, latency_ms=ms,
            status="ok" if images else "error",
            error=last_err if not images else "",
        )
    except Exception:
        pass
    if not images:
        return {"image_url": "", "b64": "", "error": last_err}
    b64 = (images[0] or {}).get("b64") or ""
    image_url = await _upload_image(b64, user_id) or (images[0] or {}).get("url", "")
    return {"image_url": image_url, "b64": b64, "error": ""}


async def _process_task(task: dict) -> None:
    task_id = task["id"]
    user_id = task.get("user_id")

    # 解析输入
    try:
        text_sources = json.loads(task.get("text_sources_json") or "[]")
        bg_ids = json.loads(task.get("background_ids_json") or "[]")
        bgs_meta = json.loads(task.get("backgrounds_meta_json") or "[]")
    except Exception as e:
        await monitor_db.finish_text_remix_task(
            task_id, status="error", error=f"任务参数解析失败：{e}")
        return

    if not text_sources or not bg_ids:
        await monitor_db.finish_text_remix_task(
            task_id, status="error", error="缺少文字源或背景图")
        return

    # 取图像模型配置（任务可指定 image_model_id；不传走用户默认）
    task_image_model_id = task.get("image_model_id")
    try:
        cfg = await ai_client.get_active_model_config(
            usage_type="image", user_id=user_id, model_id=task_image_model_id,
        )
    except ai_client.AIModelNotConfigured as e:
        await monitor_db.finish_text_remix_task(
            task_id, status="error", error=str(e))
        return
    base_url = cfg["base_url"]
    api_key = cfg["api_key"]
    model = cfg["model_id"]
    cfg_size = (cfg.get("extra_config") or {}).get("size") or DEFAULT_SIZE
    img_row_id = int(cfg.get("model_row_id") or 0)
    img_max_concurrent = int(cfg.get("max_concurrent") or 0)
    if not base_url or not api_key or not model:
        await monitor_db.finish_text_remix_task(
            task_id, status="error", error="图像 API 未配置")
        return

    size = (task.get("size") or "").strip() or cfg_size
    style_hint = (task.get("style_hint") or "").strip()
    count = max(1, min(int(task.get("count") or 1), 30))

    # 并发下载背景图（5 张内，~毫秒级）
    bg_bytes_map: dict = {}
    bgs_meta_map = {int(b.get("id", 0)): b for b in bgs_meta if b.get("id")}
    for bg_id in bg_ids:
        meta = bgs_meta_map.get(int(bg_id)) or {}
        url = (meta.get("image_url") or "").strip()
        if not url:
            continue
        b = await _download_bg(url)
        if b is not None:
            bg_bytes_map[int(bg_id)] = b
    if not bg_bytes_map:
        await monitor_db.finish_text_remix_task(
            task_id, status="error", error="所有背景图下载失败")
        return

    # 任务取消检查
    async def _is_cancelled() -> bool:
        try:
            return (await monitor_db.get_text_remix_task_status(task_id)) == "cancelled"
        except Exception:
            return False

    # 跨套全 fire：把所有 (set_idx × src × bg) cells 拍成一个大池子，
    # 由 image 模型的 max_concurrent semaphore 控制实际并发（用户设 20 就跑 20）。
    # 之前按套同步阻塞，每套小（如 1-2 张）时白白浪费并发额度。
    sets_cells: list[list[dict]] = []   # sets_cells[set_idx-1] = list of cells
    for _ in range(count):
        cells: list[dict] = []
        for src in text_sources:
            src_idx = int(src.get("src_idx", 0))
            text = (src.get("text") or "").strip()
            if not text:
                continue
            for bg_id in bg_ids:
                if int(bg_id) not in bg_bytes_map:
                    continue
                meta = bgs_meta_map.get(int(bg_id)) or {}
                cells.append({
                    "src_idx": src_idx,
                    "bg_id": int(bg_id),
                    "bg_name": meta.get("name", f"背景{bg_id}"),
                    "text": text,
                    "image_url": "",
                    "error": "",
                })
        sets_cells.append(cells)

    if not any(sets_cells):
        await monitor_db.finish_text_remix_task(
            task_id, status="error", error="没有可生成的格子（文字或背景全部无效）")
        return

    # items_indexed[set_idx-1]: {idx, items:[cells]} — 初始全部占位
    items_indexed: list[Optional[dict]] = [
        {"idx": i + 1, "items": [dict(c) for c in sets_cells[i]]}
        for i in range(count)
    ]
    progress_lock = asyncio.Lock()

    def _count_finished_sets() -> int:
        n = 0
        for s in items_indexed:
            if not s:
                continue
            if all((c.get("image_url") or c.get("error")) for c in s["items"]):
                n += 1
        return n

    async def _flush():
        try:
            await monitor_db.update_text_remix_task_progress(
                task_id, items_json=json.dumps(items_indexed, ensure_ascii=False),
                done_count=_count_finished_sets(),
            )
        except Exception as e:
            logger.warning(f"[text_remix_worker] flush failed: {e}")

    # 立刻写一次：让前端看到全部套的占位（不再"只能看到第 1 套"）
    await _flush()

    timeout = httpx.Timeout(600.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:

        async def _one_cell(set_idx: int, ci: int, cell: dict):
            # 任务取消：直接跳过（不算 error，前端会看到"未生成"占位）
            if await _is_cancelled():
                return
            prompt = _build_prompt(cell["text"], style_hint)
            bg_bytes = bg_bytes_map[cell["bg_id"]]
            try:
                result = await _gen_one_cell(
                    client, base_url=base_url, api_key=api_key, model=model,
                    size=size, bg_bytes=bg_bytes, prompt=prompt,
                    image_model_row_id=img_row_id,
                    image_max_concurrent=img_max_concurrent,
                    user_id=user_id,
                )
            except Exception as e:
                logger.exception(
                    f"[text_remix_worker] task {task_id} set {set_idx} cell {ci} crash")
                result = {"image_url": "", "b64": "",
                          "error": f"内部异常：{type(e).__name__}: {str(e)[:200]}"}

            cell["image_url"] = result.get("image_url", "")
            cell["error"] = result.get("error", "")
            async with progress_lock:
                items_indexed[set_idx - 1] = {
                    "idx": set_idx,
                    "items": [dict(c) for c in sets_cells[set_idx - 1]],
                }
                await _flush()

            # 写历史（image_gen_history）：飞书同步 + 全局历史用
            if cell["image_url"]:
                try:
                    await monitor_db.add_image_history(
                        user_id=user_id,
                        prompt=prompt[:500], size=size, model=model,
                        set_idx=set_idx, in_set_idx=ci + 1,
                        local_url=cell["image_url"],
                        qiniu_url=cell["image_url"],
                        upload_status="uploaded",
                        generated_title=cell["text"][:120],
                        generated_body="",
                        batch_id=f"text_remix:{task_id}",
                        source_post_url=task.get("post_url") or "",
                        source_post_title=task.get("post_title") or "",
                        used_reference=True,
                    )
                except Exception as e:
                    logger.warning(
                        f"[text_remix_worker] write history failed: {e}")

        # 一次 fire 全部 cells（跨套），由 acquire_slot semaphore 兜底限流
        all_jobs = []
        for si, cells in enumerate(sets_cells):
            for ci, c in enumerate(cells):
                all_jobs.append(_one_cell(si + 1, ci, c))
        await asyncio.gather(*all_jobs, return_exceptions=False)

    # 终态：done 或 cancelled
    final_status = "cancelled" if await _is_cancelled() else "done"
    await monitor_db.finish_text_remix_task(task_id, status=final_status)


# ── Worker loop（被 scheduler 调） ────────────────────────────────────────

_BUSY = False


async def process_once() -> None:
    """被 APScheduler 周期调度。一次只处理一条任务，避免上游并发风暴。"""
    global _BUSY
    if _BUSY:
        return
    _BUSY = True
    try:
        # 复活僵尸任务（worker 跑到一半挂了的）
        try:
            n = await monitor_db.revive_stuck_running_text_remix_tasks(stuck_minutes=5)
            if n:
                logger.info(f"[text_remix_worker] revived {n} stuck tasks")
        except Exception:
            pass

        task = await monitor_db.claim_pending_text_remix_task()
        if not task:
            return
        logger.info(f"[text_remix_worker] start task #{task['id']} user={task.get('user_id')}")
        try:
            await _process_task(task)
        except Exception as e:
            logger.exception(f"[text_remix_worker] task {task['id']} crashed")
            try:
                await monitor_db.finish_text_remix_task(
                    task["id"], status="error",
                    error=f"worker 异常：{type(e).__name__}: {str(e)[:200]}",
                )
            except Exception:
                pass
        logger.info(f"[text_remix_worker] task #{task['id']} finished")
    finally:
        _BUSY = False
