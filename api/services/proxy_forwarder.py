"""
本地代理转发管理：把上游"鉴权 SOCKS5 代理"转成本地"无鉴权 HTTP 代理"。

为什么需要：
  Playwright Chromium 不支持鉴权 SOCKS5 代理（用户名/密码会被静默丢弃，
  浏览器实际是直连出去）。我们让 gost 在本机起一个 HTTP 代理监听端口，
  内部把流量转发给上游 SOCKS5。Playwright 用 `http://127.0.0.1:port`
  即可走真实代理出口。

约定：
  - 仅 socks5(h)://USER:PASS@host:port 形式的上游 URL 才会触发转发
  - 其它（http/https/无鉴权 socks5）保留原值，调用方直接用
  - 每个 account 独占一个本地端口（1 进程），按 account.id 缓存
  - 启动 / 停止靠 ensure / drop 两个接口；FastAPI startup 全量 ensure，shutdown 时 stop_all
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import socket
from typing import Dict, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

GOST_BIN = shutil.which("gost") or "/usr/local/bin/gost"
LOCAL_HOST = "127.0.0.1"
PORT_RANGE = (18080, 18180)  # 给 gost 用的端口段

# {account_id: {"port": int, "process": asyncio.subprocess.Process, "src": str}}
_running: Dict[int, dict] = {}


def needs_forwarder(proxy_url: str) -> bool:
    """是否需要起本地转发：仅鉴权 SOCKS5 才需要。"""
    if not proxy_url:
        return False
    try:
        p = urlparse(proxy_url.strip())
    except Exception:
        return False
    scheme = (p.scheme or "").lower()
    return scheme.startswith("socks") and bool(p.username or p.password)


def effective_proxy_url(account: dict) -> str:
    """返回真正能用的代理 URL（本地转发地址 / 原值 / 空）。"""
    src = (account.get("proxy_url") or "").strip()
    if not src:
        return ""
    if not needs_forwarder(src):
        return src
    aid = account.get("id")
    info = _running.get(aid) if aid is not None else None
    if info and _is_alive(info):
        return f"http://{LOCAL_HOST}:{info['port']}"
    # 上游 socks5 鉴权但转发还没起来 → 直接退回原值（启动失败时不挂），
    # Playwright 仍会忽略，但 httpx 还能用。
    return src


def _is_alive(info: dict) -> bool:
    proc = info.get("process")
    return bool(proc and proc.returncode is None)


def _pick_free_port() -> int:
    used = {info["port"] for info in _running.values()}
    for port in range(PORT_RANGE[0], PORT_RANGE[1]):
        if port in used:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((LOCAL_HOST, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"无可用本地端口（{PORT_RANGE}）")


async def ensure_forwarder(account: dict) -> Optional[int]:
    """为 account 启动 gost 转发（幂等）。返回端口，失败返回 None。

    - 不需要转发 → 返回 None
    - 已在运行且 src 没变 → 直接返回老端口
    - src 变了 → 停旧的，起新的
    """
    src = (account.get("proxy_url") or "").strip()
    aid = account.get("id")
    if aid is None or not needs_forwarder(src):
        return None

    info = _running.get(aid)
    if info and _is_alive(info) and info.get("src") == src:
        return info["port"]

    if info:
        await drop_forwarder(aid)

    port = _pick_free_port()
    cmd = [
        GOST_BIN,
        "-L", f"http://:{port}?bind={LOCAL_HOST}",
        "-F", src,
    ]
    # 留一份 gost 日志方便诊断：/tmp/gost-{aid}.log
    log_path = f"/tmp/gost-{aid}.log"
    try:
        log_fd = open(log_path, "w")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=log_fd,
            stderr=log_fd,
        )
    except FileNotFoundError:
        logger.error(f"[proxy] gost 未找到，请先安装 ({GOST_BIN})")
        return None
    except Exception as e:
        logger.error(f"[proxy] gost 启动失败: {e}")
        return None

    # 等一下让端口就绪
    await asyncio.sleep(0.4)
    if proc.returncode is not None:
        # 立刻挂了
        err = (await proc.stderr.read(2000)).decode(errors="replace") if proc.stderr else ""
        logger.error(f"[proxy] gost for account#{aid} 启动后立即退出: {err[:300]}")
        return None

    _running[aid] = {"port": port, "process": proc, "src": src}
    logger.info(f"[proxy] account#{aid} ({account.get('name')}) → 转发 127.0.0.1:{port} → {_redact(src)}")
    return port


async def drop_forwarder(account_id: int) -> None:
    info = _running.pop(account_id, None)
    if not info:
        return
    proc = info["process"]
    try:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
    except Exception as e:
        logger.warning(f"[proxy] drop_forwarder({account_id}) 关闭异常: {e}")


async def stop_all() -> None:
    for aid in list(_running.keys()):
        await drop_forwarder(aid)


async def ensure_all_from_db() -> None:
    """启动时扫描所有 active 账号，给需要的拉起转发。"""
    from . import monitor_db as db
    accounts = await db.get_accounts(include_secrets=True)
    n = 0
    for acc in accounts:
        if needs_forwarder(acc.get("proxy_url") or ""):
            port = await ensure_forwarder(acc)
            if port:
                n += 1
    if n:
        logger.info(f"[proxy] 启动时拉起 {n} 个 socks5 鉴权代理转发")


def status_dump() -> dict:
    """给管理员看的诊断信息（不含密码）。"""
    return {
        aid: {
            "port": info["port"],
            "alive": _is_alive(info),
            "src": _redact(info["src"]),
        }
        for aid, info in _running.items()
    }


def _redact(url: str) -> str:
    try:
        p = urlparse(url)
        if p.password:
            netloc = f"{p.username}:***@{p.hostname}:{p.port}" if p.port else f"{p.username}:***@{p.hostname}"
            return f"{p.scheme}://{netloc}"
    except Exception:
        pass
    return url
