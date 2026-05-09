"""
XHS 签名服务 — 进程内单例。

为什么要这个：
  老路线每次拉取都 spawn 一个 Playwright 浏览器上下文（trending/creator）。
  签名核心算法是纯 Python（src/platforms/xhs/xhs_sign.py），唯一不能离线
  跑的是 window.mnsv2() 这个 JS 黑盒。
  本服务起一个"长驻 headless 浏览器 + xiaohongshu.com 页面"，让 mnsv2()
  和 localStorage.b1 持续可用。业务调用方只问 sign(uri, a1, params/payload)
  拿到签名头后用 httpx 直接调 edith.xiaohongshu.com 的 API。

  收益：
    - 单次签名 ~50ms（vs Playwright 全启动 2-5s）
    - 不再为每次抓取付出浏览器冷启动开销
    - 可水平扩展（未来可改成独立服务）

  风控考虑：
    - 启动用 _DEFAULT_UA + stealth.min.js
    - 失败自动 cleanup + 下次自愈重启
    - 调用方应保留 Playwright 兜底，签名服务返回 None 时降级
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# 复用 src 层的纯 Python 签名实现
from src.platforms.xhs.playwright_sign import sign_with_playwright

_RELOAD_INTERVAL_SEC = 60 * 30  # 30 分钟刷一次主页，避免 b1 / mnsv2 内部状态过期


def cookie_str_to_dict(cookie_str: str) -> Dict[str, str]:
    """`a1=xxx; web_session=yyy` -> {"a1": "xxx", "web_session": "yyy"}"""
    out: Dict[str, str] = {}
    if not cookie_str:
        return out
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            k, _, v = part.partition("=")
            out[k.strip()] = v.strip()
    return out


class XhsSignService:
    """常驻签名服务单例。线程不安全；asyncio 协程安全。"""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._pw: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._page: Any = None
        self._ready: bool = False
        self._loaded_at: float = 0.0
        self._fail_count: int = 0

    async def _ensure_started(self) -> None:
        if self._ready and (time.time() - self._loaded_at) < _RELOAD_INTERVAL_SEC:
            return
        async with self._lock:
            if self._ready and (time.time() - self._loaded_at) < _RELOAD_INTERVAL_SEC:
                return
            if self._ready:
                # 到期重载
                logger.info("[xhs-sign] periodic reload (b1/state may stale)")
                await self._cleanup_locked()
            await self._start_locked()

    async def _start_locked(self) -> None:
        from playwright.async_api import async_playwright
        from ...account_browser import _DEFAULT_UA, _load_stealth

        try:
            self._pw = await async_playwright().start()
            self._browser = await self._pw.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--single-process",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--js-flags=--max-old-space-size=256",
                ],
            )
            self._context = await self._browser.new_context(
                user_agent=_DEFAULT_UA,
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
            )
            stealth = _load_stealth()
            if stealth:
                await self._context.add_init_script(stealth)
            self._page = await self._context.new_page()
            await self._page.goto(
                "https://www.xiaohongshu.com/explore",
                wait_until="domcontentloaded",
                timeout=20000,
            )
            # 等 mnsv2 / b1 注入 localStorage
            await asyncio.sleep(2)
            self._ready = True
            self._loaded_at = time.time()
            self._fail_count = 0
            logger.info("[xhs-sign] sign service started")
        except Exception as e:
            logger.warning(f"[xhs-sign] start failed: {e}")
            await self._cleanup_locked()
            raise

    async def _cleanup_locked(self) -> None:
        for closer in (
            (lambda: self._page and self._page.close()),
            (lambda: self._context and self._context.close()),
            (lambda: self._browser and self._browser.close()),
            (lambda: self._pw and self._pw.stop()),
        ):
            try:
                co = closer()
                if asyncio.iscoroutine(co):
                    await co
            except Exception:
                pass
        self._page = None
        self._context = None
        self._browser = None
        self._pw = None
        self._ready = False

    async def sign(
        self,
        uri: str,
        a1: str,
        params: Optional[Dict] = None,
        payload: Optional[Dict] = None,
    ) -> Optional[Dict[str, str]]:
        """返回 X-S/X-T/X-S-Common/X-B3-Traceid 头，或 None（调用方应 fallback）。

        - uri 是 path（如 "/api/sns/web/v1/search/notes"）
        - a1 来自调用方账号 cookie（每个业务账号不同；mnsv2 与 a1 解耦）
        - params 与 payload 二选一（决定 GET/POST）
        """
        try:
            await self._ensure_started()
        except Exception:
            return None
        if not self._ready or self._page is None:
            return None

        try:
            data: Any
            method: str
            if params is not None:
                data, method = params, "GET"
            elif payload is not None:
                data, method = payload, "POST"
            else:
                return None

            signs = await sign_with_playwright(
                page=self._page, uri=uri, data=data, a1=a1, method=method,
            )
            if not signs.get("x-s"):
                logger.warning("[xhs-sign] x-s empty (mnsv2 returned empty); will reset")
                self._fail_count += 1
                async with self._lock:
                    await self._cleanup_locked()
                return None
            self._fail_count = 0
            return {
                "X-S":          signs["x-s"],
                "X-T":          signs["x-t"],
                "X-S-Common":   signs["x-s-common"],
                "X-B3-Traceid": signs["x-b3-traceid"],
            }
        except Exception as e:
            logger.warning(f"[xhs-sign] sign failed ({type(e).__name__}: {e}); will reset")
            self._fail_count += 1
            try:
                async with self._lock:
                    await self._cleanup_locked()
            except Exception:
                pass
            return None

    async def shutdown(self) -> None:
        async with self._lock:
            await self._cleanup_locked()


_INSTANCE: Optional[XhsSignService] = None
_GLOBAL_LOCK = asyncio.Lock()


async def get_sign_service() -> XhsSignService:
    global _INSTANCE
    if _INSTANCE is None:
        async with _GLOBAL_LOCK:
            if _INSTANCE is None:
                _INSTANCE = XhsSignService()
    return _INSTANCE


async def shutdown_sign_service() -> None:
    global _INSTANCE
    if _INSTANCE is not None:
        await _INSTANCE.shutdown()
        _INSTANCE = None
