"""统一对象存储入口：按配置自动选 S3 / 七牛云 / 本地。

优先级：
  1. S3 兼容（aws / 阿里云 oss / 腾讯云 cos / r2 / b2 / minio）
  2. 七牛云（如配了 access_key/secret_key/bucket/domain）
  3. 本地存储（如配了 public_url_prefix）
  4. 都没配 → 不上传，返回 (None, error)，调用方自行降级

调用方接口：
  is_configured() / active_backend()
  upload_b64(b64, user_id) → (url, error)             # 老的图生图链路用
  upload_bytes(data, suffix, kind, ...) → (url, err)  # 媒体归档下载入库用
"""
from __future__ import annotations

import logging
from typing import Optional, Tuple

from . import qiniu_uploader, local_storage, s3_uploader

logger = logging.getLogger(__name__)


async def is_configured() -> bool:
    return (
        await s3_uploader.is_configured()
        or await qiniu_uploader.is_configured()
        or await local_storage.is_configured()
    )


async def active_backend() -> str:
    """返回当前会用哪个后端：'s3' / 'qiniu' / 'local' / 'none'。"""
    if await s3_uploader.is_configured():
        return "s3"
    if await qiniu_uploader.is_configured():
        return "qiniu"
    if await local_storage.is_configured():
        return "local"
    return "none"


async def upload_b64(
    b64_data: str, user_id: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    if await s3_uploader.is_configured():
        return await s3_uploader.upload_b64(b64_data, user_id=user_id)
    if await qiniu_uploader.is_configured():
        return await qiniu_uploader.upload_b64(b64_data, user_id=user_id)
    if await local_storage.is_configured():
        return await local_storage.upload_b64(b64_data, user_id=user_id)
    return None, "未配置图片存储（S3 / 七牛云 / 本地公网地址至少配一个）"


async def upload_bytes(
    data: bytes,
    *,
    suffix: str = "jpg",
    kind: str = "image",
    user_id: Optional[int] = None,
    note_id: str = "",
    content_type: str = "application/octet-stream",
) -> Tuple[Optional[str], Optional[str]]:
    """上传二进制（媒体归档专用：原图 / 视频 / livePhoto）。

    本地后端 local_storage 不支持二进制（它是 b64 接口），fallback 到 S3 才行。
    所以二进制路径要求至少配置 S3 或七牛之一；都没配返回 None。
    """
    if await s3_uploader.is_configured():
        return await s3_uploader.upload_bytes(
            data, suffix=suffix, kind=kind, user_id=user_id,
            note_id=note_id, content_type=content_type,
        )
    # 七牛兜底（七牛 SDK 同样支持 put_data 二进制）
    if await qiniu_uploader.is_configured():
        try:
            import base64
            b64 = base64.b64encode(data).decode("ascii")
            return await qiniu_uploader.upload_b64(b64, user_id=user_id)
        except Exception as e:
            return None, f"七牛兜底上传失败：{e}"
    return None, "二进制存储未配置（S3 / 七牛至少配一个）"
