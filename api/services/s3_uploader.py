"""S3 兼容对象存储上传服务。

兼容 AWS S3 / 阿里云 OSS / 腾讯云 COS / Cloudflare R2 / Backblaze B2 / MinIO。

配置（存在 monitor_settings 表里，admin 在设置页填）：
  s3_endpoint    — endpoint URL（如 https://oss-cn-hangzhou.aliyuncs.com；留空走 AWS 默认）
  s3_access_key  — Access Key ID
  s3_secret_key  — Secret Access Key（敏感）
  s3_bucket      — 存储桶名
  s3_region      — region（AWS 必填，其它兼容服务留空通常 'us-east-1' 即可）
  s3_url_prefix  — 公网访问前缀（如 https://cdn.example.com，结尾不带 /）
                   留空则用 endpoint/{bucket}/{key} 拼接
  s3_path_style  — '1' 强制 path-style（MinIO 必须）；'0' / 留空走默认 virtual-host
"""
from __future__ import annotations

import asyncio
import io
import logging
import time
from typing import Optional, Tuple
from uuid import uuid4

from . import monitor_db

logger = logging.getLogger(__name__)


async def _read_settings() -> dict:
    keys = (
        "s3_endpoint", "s3_access_key", "s3_secret_key", "s3_bucket",
        "s3_region", "s3_url_prefix", "s3_path_style",
    )
    out = {}
    for k in keys:
        out[k] = (await monitor_db.get_setting(k, "")).strip()
    return out


async def is_configured() -> bool:
    s = await _read_settings()
    return bool(s["s3_access_key"] and s["s3_secret_key"] and s["s3_bucket"])


def _build_url(s: dict, key: str) -> str:
    prefix = s.get("s3_url_prefix", "").rstrip("/")
    if prefix:
        return f"{prefix}/{key}"
    endpoint = s.get("s3_endpoint", "").rstrip("/")
    bucket = s["s3_bucket"]
    if not endpoint:
        return f"https://{bucket}.s3.amazonaws.com/{key}"
    if s.get("s3_path_style") == "1":
        return f"{endpoint}/{bucket}/{key}"
    # virtual-host 风格：把 bucket 拼到 host 前
    if "://" in endpoint:
        proto, host = endpoint.split("://", 1)
        return f"{proto}://{bucket}.{host}/{key}"
    return f"{endpoint}/{bucket}/{key}"


def _gen_key(
    user_id: Optional[int], kind: str, suffix: str = "jpg",
    note_id: str = "",
) -> str:
    today = time.strftime("%Y%m%d")
    uid = user_id if user_id is not None else 0
    rand = uuid4().hex[:8]
    nid = (note_id or "noid")[:24]
    return f"media-archive/{today}/{uid}/{kind}/{nid}-{rand}.{suffix}"


def _make_client(s: dict):
    """同步创建 boto3 client。在 to_thread 里调用避免阻塞 event loop。"""
    import boto3
    from botocore.client import Config

    cfg_kwargs = {"signature_version": "s3v4"}
    if s.get("s3_path_style") == "1":
        cfg_kwargs["s3"] = {"addressing_style": "path"}
    return boto3.client(
        "s3",
        endpoint_url=s["s3_endpoint"] or None,
        aws_access_key_id=s["s3_access_key"],
        aws_secret_access_key=s["s3_secret_key"],
        region_name=s.get("s3_region") or "us-east-1",
        config=Config(**cfg_kwargs),
    )


async def upload_bytes(
    data: bytes,
    *,
    suffix: str = "jpg",
    kind: str = "image",
    user_id: Optional[int] = None,
    note_id: str = "",
    content_type: str = "application/octet-stream",
) -> Tuple[Optional[str], Optional[str]]:
    """上传二进制数据。返回 (public_url, error)。"""
    if not data:
        return None, "data 为空"
    s = await _read_settings()
    if not (s["s3_access_key"] and s["s3_secret_key"] and s["s3_bucket"]):
        return None, "S3 未配置完整（access_key / secret_key / bucket）"

    key = _gen_key(user_id, kind, suffix, note_id=note_id)

    def _do_upload():
        client = _make_client(s)
        client.put_object(
            Bucket=s["s3_bucket"], Key=key, Body=data,
            ContentType=content_type,
        )
        return True

    try:
        await asyncio.to_thread(_do_upload)
    except Exception as e:
        logger.exception(f"[s3] upload exception: {e}")
        return None, f"S3 上传异常：{e}"

    return _build_url(s, key), None


async def upload_b64(
    b64_data: str, user_id: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """与 qiniu_uploader.upload_b64 同语义，方便接入 storage 抽象。"""
    import base64
    if not b64_data:
        return None, "b64 数据为空"
    try:
        data = base64.b64decode(b64_data)
    except Exception as e:
        return None, f"b64 解码失败：{e}"
    return await upload_bytes(
        data, suffix="png", kind="image",
        user_id=user_id, content_type="image/png",
    )
