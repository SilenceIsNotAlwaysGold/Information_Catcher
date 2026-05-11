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
import json
import logging
import os
import signal
import sys

logger = logging.getLogger("pulse.worker")

# 与 uvicorn 默认 logger 风格对齐
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s (%(module)s.py:%(lineno)d) - %(message)s",
)


async def _reload_listener(monitor_scheduler) -> None:
    """订阅 pulse:scheduler:reload 频道，收到 API 进程发来的通知后立即 reschedule。"""
    try:
        import redis.asyncio as aioredis
    except Exception as e:
        logger.warning(f"[worker] redis.asyncio 不可用，跳过 reload 监听: {e}")
        return
    url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
    r = aioredis.from_url(url, socket_timeout=5)
    pubsub = r.pubsub()
    try:
        await pubsub.subscribe("pulse:scheduler:reload")
        logger.info(f"[worker] subscribed pulse:scheduler:reload @ {url}")
        async for msg in pubsub.listen():
            if msg.get("type") != "message":
                continue
            try:
                data = json.loads(msg["data"])
                interval = int(data["interval_minutes"])
                report_time = str(data.get("report_time", "09:00"))
                monitor_scheduler.reschedule(interval, report_time)
                logger.info(f"[worker] reload applied: interval={interval}m report={report_time}")
            except Exception as e:
                logger.warning(f"[worker] reload handler failed: {e}")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.warning(f"[worker] redis listener exited: {e}")
    finally:
        try:
            await pubsub.aclose()
        except Exception:
            pass
        try:
            await r.aclose()
        except Exception:
            pass


async def amain() -> None:
    from .services import monitor_db, proxy_forwarder
    from .services import scheduler as monitor_scheduler

    logger.info("[worker] starting Pulse background scheduler …")
    await monitor_db.init_db()
    await proxy_forwarder.ensure_all_from_db()
    await monitor_scheduler.start_scheduler()
    logger.info("[worker] scheduler started; idle-looping (SIGTERM to stop)")

    # Redis 通知监听：API 进程改了 settings.check_interval_minutes 后立即 reload
    listener = asyncio.create_task(_reload_listener(monitor_scheduler))

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
    listener.cancel()

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
