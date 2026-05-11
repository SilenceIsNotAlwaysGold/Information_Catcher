# -*- coding: utf-8 -*-
"""Pulse 后台 worker 独立入口。

跑所有 APScheduler 定时任务（监控、热门、追新、媒体归档、仿写、创作者数据等），
不监听 HTTP 端口。FastAPI 主进程不再跑这些任务，HTTP 体验大幅平滑。

启动方式（生产）：systemd `redbook-worker.service` →
    /opt/redbook/.venv/bin/python -m api.worker

开发模式想单进程跑：仍然可以在 API 进程里设 PULSE_RUN_SCHEDULER=1，
此时不要再起 worker，否则两个进程都跑 cron 会重复抓数据。
"""
from __future__ import annotations

import asyncio
import logging
import signal
import sys

logger = logging.getLogger("pulse.worker")

# 与 uvicorn 默认 logger 风格对齐
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s (%(module)s.py:%(lineno)d) - %(message)s",
)


async def amain() -> None:
    from .services import monitor_db, proxy_forwarder
    from .services import scheduler as monitor_scheduler

    logger.info("[worker] starting Pulse background scheduler …")
    await monitor_db.init_db()
    await proxy_forwarder.ensure_all_from_db()
    await monitor_scheduler.start_scheduler()
    logger.info("[worker] scheduler started; idle-looping (SIGTERM to stop)")

    # 阻塞等信号
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            # Windows 不支持，开发环境可能撞到，忽略
            pass

    await stop.wait()
    logger.info("[worker] shutdown signal received")

    monitor_scheduler.scheduler.shutdown(wait=False)
    await proxy_forwarder.stop_all()
    # 关闭常驻 XHS 签名服务
    try:
        from .services.platforms.xhs.sign_service import shutdown_sign_service
        await shutdown_sign_service()
    except Exception:
        pass
    logger.info("[worker] bye")


def main() -> None:
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
    sys.exit(0)
