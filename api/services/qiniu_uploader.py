"""七牛云对象存储上传服务。

商品图工具生成的图片是 base64，但飞书多维表格的「附件」/「URL」字段需要
公网可访问的 URL，所以中间需要一层对象存储。这里用七牛云做这件事。

配置（存在 monitor_settings 表里，admin 在设置页填）：
  qiniu_access_key  — 七牛 AK
  qiniu_secret_key  — 七牛 SK（敏感，存库不返回明文）
  qiniu_bucket      — 存储空间名
  qiniu_domain      — 绑定域名（如 https://cdn.example.com，注意结尾不带 /）
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Optional, Tuple
from uuid import uuid4

from qiniu import Auth, put_data

from . import monitor_db

logger = logging.getLogger(__name__)


def _build_url(domain: str, key: str) -> str:
    domain = (domain or "").strip().rstrip("/")
    if not domain:
        return ""
    if not domain.startswith(("http://", "https://")):
        domain = f"https://{domain}"
    return f"{domain}/{key}"


def _gen_key(user_id: Optional[int], suffix: str = "png") -> str:
    """生成存储 key：product-image/{date}/{uid}/{ts-rand}.png

    用日期分目录方便后期管理；用户 id 隔离防止 key 冲突。
    """
    today = time.strftime("%Y%m%d")
    uid = user_id if user_id is not None else 0
    rand = uuid4().hex[:10]
    ts = int(time.time())
    return f"product-image/{today}/{uid}/{ts}-{rand}.{suffix}"


async def is_configured() -> bool:
    ak = (await monitor_db.get_setting("qiniu_access_key", "")).strip()
    sk = (await monitor_db.get_setting("qiniu_secret_key", "")).strip()
    bucket = (await monitor_db.get_setting("qiniu_bucket", "")).strip()
    domain = (await monitor_db.get_setting("qiniu_domain", "")).strip()
    return bool(ak and sk and bucket and domain)


async def upload_b64(
    b64_data: str, user_id: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """上传 base64 编码的图片到七牛云。

    返回 (public_url, error)。成功时 error=None；失败时 url=None。
    """
    if not b64_data:
        return None, "b64 数据为空"

    ak = (await monitor_db.get_setting("qiniu_access_key", "")).strip()
    sk = (await monitor_db.get_setting("qiniu_secret_key", "")).strip()
    bucket = (await monitor_db.get_setting("qiniu_bucket", "")).strip()
    domain = (await monitor_db.get_setting("qiniu_domain", "")).strip()
    if not all([ak, sk, bucket, domain]):
        return None, "七牛云未配置完整（access_key / secret_key / bucket / domain）"

    try:
        img_bytes = base64.b64decode(b64_data)
    except Exception as e:
        return None, f"b64 解码失败：{e}"

    key = _gen_key(user_id)
    # qiniu SDK 是同步的，丢到线程池别堵 event loop
    def _do_upload():
        q = Auth(ak, sk)
        token = q.upload_token(bucket, key, expires=600)
        ret, info = put_data(token, key, img_bytes)
        return ret, info

    try:
        ret, info = await asyncio.to_thread(_do_upload)
    except Exception as e:
        logger.exception(f"[qiniu] upload exception: {e}")
        return None, f"七牛上传异常：{e}"

    if not ret or ret.get("key") != key:
        status_code = getattr(info, "status_code", "?") if info else "?"
        return None, f"七牛上传失败（HTTP {status_code}）：{info}"

    return _build_url(domain, key), None
