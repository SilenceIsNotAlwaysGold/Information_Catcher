"""异步把商品图历史里 pending 的本地图推到七牛云。

调度：scheduler.py 里注册一个 1 分钟一次的 job 调 run_batch()。

策略：
- 每次最多跑 BATCH_SIZE 张，避免一次占太多带宽（这台机器出向跟监控任务竞争）
- 每张内部串行（不并发），失败时重试，超过 MAX_RETRIES 标 failed 不再尝试
- 七牛未配置 / local_url 为空 / 文件已不存在 → 直接标 failed，不浪费重试
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from urllib.parse import urlparse

from . import monitor_db
from . import qiniu_uploader
from . import local_storage

logger = logging.getLogger(__name__)

BATCH_SIZE = 3        # 每次跑最多 3 张（带宽紧时容易卡）
MAX_RETRIES = 3       # 每条记录最多重试 3 次后标 failed


def _local_url_to_path(local_url: str) -> Path | None:
    """把本地静态 URL 还原为文件系统路径。

    URL 形如 https://host/static/images/product-image/.../xxx.png
    本地路径 = local_storage.IMAGES_ROOT / product-image/.../xxx.png
    """
    if not local_url:
        return None
    parsed = urlparse(local_url)
    if not parsed.path:
        return None
    mount = local_storage.URL_MOUNT_PATH.rstrip("/")
    if mount and mount in parsed.path:
        rel = parsed.path.split(mount, 1)[-1].lstrip("/")
    else:
        rel = parsed.path.lstrip("/")
    if not rel:
        return None
    return local_storage.IMAGES_ROOT / rel


async def _upload_one(record: dict) -> None:
    rid = record["id"]
    local_url = record.get("local_url") or ""
    path = _local_url_to_path(local_url)
    if path is None or not path.exists():
        await monitor_db.mark_image_upload_failed(
            rid, f"本地文件不存在：{path}", max_retries=1,  # 立即 failed
        )
        logger.warning(f"[image_upload] #{rid} local file missing: {path}")
        return

    try:
        with open(path, "rb") as f:
            img_bytes = f.read()
    except Exception as e:
        await monitor_db.mark_image_upload_failed(rid, f"读文件失败：{e}", max_retries=1)
        return

    # qiniu_uploader.upload_b64 接 base64，这里转一下少一层 decode
    import base64
    b64 = base64.b64encode(img_bytes).decode("ascii")
    user_id = record.get("user_id")

    url, err = await qiniu_uploader.upload_b64(b64, user_id=user_id)
    if url:
        await monitor_db.mark_image_upload_succeeded(rid, url)
        logger.info(f"[image_upload] #{rid} uploaded → {url}")
    else:
        await monitor_db.mark_image_upload_failed(rid, err or "未知错误", max_retries=MAX_RETRIES)
        logger.warning(f"[image_upload] #{rid} failed (will retry): {err}")


async def run_batch() -> dict:
    """供 scheduler 定时调度。返回这次的处理统计。"""
    if not await qiniu_uploader.is_configured():
        return {"ok": True, "skipped": "七牛未配置", "processed": 0}

    pending = await monitor_db.list_pending_image_uploads(limit=BATCH_SIZE)
    if not pending:
        return {"ok": True, "processed": 0}

    success = 0
    failed = 0
    for rec in pending:
        try:
            before = (await monitor_db.get_image_history(rec["id"]) or {}).get("upload_status")
            await _upload_one(rec)
            after = (await monitor_db.get_image_history(rec["id"]) or {}).get("upload_status")
            if after == "uploaded":
                success += 1
            else:
                failed += 1
        except Exception as e:
            logger.exception(f"[image_upload] worker error on #{rec.get('id')}: {e}")
            failed += 1

    return {"ok": True, "processed": len(pending), "success": success, "failed": failed}
