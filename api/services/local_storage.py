"""本地文件存储：把生成的图片写到 data/images/，由 FastAPI 静态目录暴露。

适用场景：用户没有备案域名，无法用七牛云国内 bucket。直接用部署服务器自己的
公网 IP/HTTPS 端口，把生成的图片当作静态文件提供给飞书等外部系统。

配置项：
  public_url_prefix — 服务器对外可访问的 URL 前缀（如 https://my.example.com:8003）

URL 形式：{prefix}/static/images/product-image/{date}/{user}/{ts}-{rand}.png
对应文件：{repo_root}/data/images/product-image/{date}/{user}/{ts}-{rand}.png
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from pathlib import Path
from typing import Optional, Tuple
from uuid import uuid4

from . import monitor_db

logger = logging.getLogger(__name__)

# 仓库根 = api/services/local_storage.py 的上 3 层
_REPO_ROOT = Path(__file__).parent.parent.parent
IMAGES_ROOT = _REPO_ROOT / "data" / "images"
URL_MOUNT_PATH = "/static/images"


async def is_configured() -> bool:
    prefix = (await monitor_db.get_setting("public_url_prefix", "")).strip()
    return bool(prefix)


def _gen_relpath(user_id: Optional[int]) -> str:
    today = time.strftime("%Y%m%d")
    uid = user_id if user_id is not None else 0
    rand = uuid4().hex[:10]
    ts = int(time.time())
    return f"product-image/{today}/{uid}/{ts}-{rand}.png"


async def upload_b64(
    b64_data: str, user_id: Optional[int] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """把 b64 写到本地，返回 (public_url, error)。"""
    if not b64_data:
        return None, "b64 数据为空"

    prefix = (await monitor_db.get_setting("public_url_prefix", "")).strip().rstrip("/")
    if not prefix:
        return None, "本地存储未启用：请在系统配置中填「公网访问地址」"
    if not prefix.startswith(("http://", "https://")):
        prefix = f"https://{prefix}"

    try:
        img_bytes = base64.b64decode(b64_data)
    except Exception as e:
        return None, f"b64 解码失败：{e}"

    rel = _gen_relpath(user_id)
    full = IMAGES_ROOT / rel

    def _write():
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(img_bytes)

    try:
        await asyncio.to_thread(_write)
    except Exception as e:
        logger.exception(f"[local_storage] write error: {e}")
        return None, f"本地写入失败：{e}"

    return f"{prefix}{URL_MOUNT_PATH}/{rel}", None
