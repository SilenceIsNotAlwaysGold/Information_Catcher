"""图片存储统一入口：按配置自动选七牛云或本地存储。

优先级：
  1. 七牛云（如配了 access_key/secret_key/bucket/domain）
  2. 本地存储（如配了 public_url_prefix）
  3. 都没配 → 不上传，返回 (None, error)，调用方自行降级

调用方只需 import 这个模块的两个函数：
  is_configured() → bool
  upload_b64(b64, user_id) → (url_or_none, error_or_none)
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple

from . import qiniu_uploader, local_storage

logger = logging.getLogger(__name__)


async def is_configured() -> bool:
    return await qiniu_uploader.is_configured() or await local_storage.is_configured()


async def active_backend() -> str:
    """返回当前会用哪个后端：'qiniu' / 'local' / 'none'。"""
    if await qiniu_uploader.is_configured():
        return "qiniu"
    if await local_storage.is_configured():
        return "local"
    return "none"


async def upload_b64(
    b64_data: str, user_id: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    if await qiniu_uploader.is_configured():
        return await qiniu_uploader.upload_b64(b64_data, user_id=user_id)
    if await local_storage.is_configured():
        return await local_storage.upload_b64(b64_data, user_id=user_id)
    return None, "未配置图片存储（七牛云或本地公网地址至少配一个）"
