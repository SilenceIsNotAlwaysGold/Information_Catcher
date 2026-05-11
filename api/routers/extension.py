"""浏览器扩展 (Pulse Helper) WebSocket 路由 + 调度入口。

架构（多 worker 部署）:
    扩展 ──[ws]── /api/extension/ws  ─┐
                                      │
                  ExtensionRegistry (per-worker)
                                      │
                  ┌───────── Redis routing table ─────────┐
                  │  ext:online:{user_id}  → Set<ws_id>   │
                  │  ext:ws:{ws_id}:worker → worker_id    │
                  │  ext:ws:{ws_id}:meta   → Hash         │
                  │  pubsub: ext:task:{worker_id}         │
                  │  pubsub: ext:result:{task_id}         │
                  └───────────────────────────────────────┘
                                      │
    Pulse 服务端业务逻辑 ──dispatch()──┘

任务协议 (server → ext):
    {"type": "task", "task": {"id": "...", "type": "xhs.search", "payload": {...}}}
结果协议 (ext → server):
    {"type": "result", "id": "...", "ok": true|false, "data": {...}, "error": "..."}
心跳:
    ext → {"type": "ping", "ts": ...}
    server → {"type": "pong", "ts": ...}

跨 worker 路由:
    每个 worker 启动时生成自己的 worker_id (uuid)，订阅
      - ext:task:{worker_id}    收发到自己负责 ws 的任务
      - ext:result:*            收任意 worker 发起任务的结果回流
    扩展 ws 连入时：把 ws_id 注册到 Redis；本地 ws_registry[ws_id] = ws。
    dispatch 时：从 Redis 找目标 worker；同 worker 走本地 ws.send_json，
    否则通过 pubsub 发到目标 worker 的 task channel，等 result channel 回流。

Redis 不可用时全部降级为 in-memory 单进程模式（WARN 日志）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, Dict, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..services.auth_service import verify_token
from .auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/extension", tags=["Extension"])


# ============================================================================
# Redis routing backend
# ============================================================================

REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
WS_TTL_SEC = 60           # ext:ws:{ws_id}:worker / :meta 的 TTL
HEARTBEAT_SEC = 30         # 续 TTL 间隔
WORKER_ID = uuid.uuid4().hex  # 本 worker 进程唯一 ID


def _redis_key_online(user_id: int) -> str:
    return f"ext:online:{int(user_id)}"


def _redis_key_ws_worker(ws_id: str) -> str:
    return f"ext:ws:{ws_id}:worker"


def _redis_key_ws_meta(ws_id: str) -> str:
    return f"ext:ws:{ws_id}:meta"


def _redis_chan_task(worker_id: str) -> str:
    return f"ext:task:{worker_id}"


def _redis_chan_result(task_id: str) -> str:
    return f"ext:result:{task_id}"


class ExtensionRegistry:
    """跨 worker 维护扩展 ws 路由表。

    存储分层:
      - Redis（共享）: 在线状态、ws → worker 路由、meta、跨 worker 任务/结果 channel
      - 本地内存:     ws_id → WebSocket 实例（不可序列化）、task_id → 本地 future

    所有公开方法对调用方保持原有签名（add/remove 同步，dispatch/resolve async）。
    Redis 写在同步入口里通过 asyncio.create_task 异步执行。
    """

    def __init__(self) -> None:
        # 本地 WS 实例表：只存当前 worker 持有的连接。
        # ws_id → (user_id, WebSocket, meta_dict, heartbeat_task)
        self._local_ws: Dict[str, Dict[str, Any]] = {}
        # WebSocket 实例 → ws_id 反查表（add/remove 都是按 ws 对象调用的）
        self._ws_to_id: Dict[WebSocket, str] = {}
        # 本地待响应任务表：task_id → future（无论任务是本地派还是 pubsub 派都先建本地 future）
        self.pending: Dict[str, asyncio.Future] = {}
        # Redis 客户端 / pubsub 句柄（懒初始化）
        self._redis = None  # type: ignore[assignment]
        self._pubsub = None  # type: ignore[assignment]
        self._pubsub_task: Optional[asyncio.Task] = None
        self._init_lock: Optional[asyncio.Lock] = None  # 延迟到首次 ensure_started 时创建
        self._initialized = False
        self._redis_ok = False  # False 时一律走 in-memory fallback

        # In-memory fallback（Redis 不可用时）：user_id → set[ws_id]
        self._mem_online: Dict[int, Set[str]] = {}
        # 跨 worker 在线数缓存，用于让 sync online_count() 在 Redis 模式下也能反映全局视图。
        # 由 _async_register / _async_unregister / online_count_global / 定时 refresh 写入。
        self._online_cache_global: Dict[int, int] = {}
        # 防止 sync online_count() 短时间内重复触发后台 refresh
        self._refresh_inflight: Set[int] = set()

    # ── 初始化 ──────────────────────────────────────────────────────────────

    async def ensure_started(self) -> None:
        """首次需要 Redis 时建连接 + 启动 pubsub 后台任务。可多次调用幂等。"""
        if self._initialized:
            return
        if self._init_lock is None:
            self._init_lock = asyncio.Lock()
        async with self._init_lock:
            if self._initialized:
                return
            self._initialized = True
            try:
                import redis.asyncio as aioredis  # type: ignore
                client = aioredis.from_url(REDIS_URL, encoding="utf-8", decode_responses=True)
                await client.ping()
                self._redis = client
                self._redis_ok = True
                # 订阅本 worker 的 task channel + 所有 result channel
                pubsub = client.pubsub()
                await pubsub.subscribe(_redis_chan_task(WORKER_ID))
                await pubsub.psubscribe("ext:result:*")
                self._pubsub = pubsub
                self._pubsub_task = asyncio.create_task(self._pubsub_loop())
                logger.info(
                    f"[ext-registry] redis backend ready worker_id={WORKER_ID[:8]} url={REDIS_URL}"
                )
            except Exception as e:
                self._redis_ok = False
                logger.warning(
                    f"[ext-registry] redis unavailable ({e!r}); fallback to in-memory single-worker mode"
                )

    # ── 公开接口（保持原有签名）────────────────────────────────────────────

    def add(self, user_id: int, ws: WebSocket, meta: Optional[Dict[str, Any]] = None) -> None:
        """同步入口：分配 ws_id，本地落表，异步把路由信息写 Redis。"""
        ws_id = uuid.uuid4().hex
        meta = dict(meta or {})
        meta.setdefault("joined_at", int(time.time()))
        meta.setdefault("user_id", int(user_id))
        self._local_ws[ws_id] = {"user_id": int(user_id), "ws": ws, "meta": meta, "hb": None}
        self._ws_to_id[ws] = ws_id
        # 异步把状态推到 Redis + 启动心跳
        asyncio.create_task(self._async_register(ws_id, int(user_id), meta))

    def remove(self, user_id: int, ws: WebSocket) -> None:
        """同步入口：拿到 ws_id，本地剔除，异步清 Redis。"""
        ws_id = self._ws_to_id.pop(ws, None)
        if not ws_id:
            return
        entry = self._local_ws.pop(ws_id, None)
        if entry and entry.get("hb"):
            try:
                entry["hb"].cancel()
            except Exception:
                pass
        asyncio.create_task(self._async_unregister(ws_id, int(user_id)))

    def online_count(self, user_id: int) -> int:
        """同步签名，返回**跨 worker 在线数**估算值。

        实现：
          - Redis 不可用：直接看 in-memory fallback 表（单 worker 模式准确）
          - Redis 可用：取 _online_cache_global[user_id]；该缓存由 register/unregister 维护，
            并在事件循环可用时触发一次后台 refresh 兜底（防止漂移）。
        """
        uid = int(user_id)
        if not self._redis_ok:
            return len(self._mem_online.get(uid, set()))
        # 本地视图作为下限（本 worker 持有的连接一定在线）
        local = sum(1 for v in self._local_ws.values() if v["user_id"] == uid)
        cached = self._online_cache_global.get(uid, 0)
        # 触发一次后台 refresh 让缓存收敛（不阻塞调用方）
        if uid not in self._refresh_inflight:
            try:
                loop = asyncio.get_running_loop()
                self._refresh_inflight.add(uid)
                loop.create_task(self._refresh_global_count(uid))
            except RuntimeError:
                pass  # 没有运行中的事件循环（极少见，比如纯同步测试）
        return max(local, cached)

    async def _refresh_global_count(self, user_id: int) -> None:
        try:
            n = await self.online_count_global(user_id)
            self._online_cache_global[int(user_id)] = int(n)
        except Exception:
            pass
        finally:
            self._refresh_inflight.discard(int(user_id))

    async def online_count_global(self, user_id: int) -> int:
        """跨 worker 真实在线数。优先 Redis，否则降级到 in-memory。"""
        await self.ensure_started()
        if not self._redis_ok or self._redis is None:
            return len(self._mem_online.get(int(user_id), set()))
        try:
            n = int(await self._redis.scard(_redis_key_online(user_id)))
            self._online_cache_global[int(user_id)] = n
            return n
        except Exception as e:
            logger.warning(f"[ext-registry] scard failed: {e}")
            return self.online_count(user_id)

    def list_online(self, user_id: int) -> list:
        """同步签名：仅返回本 worker 持有的实例视图（meta 直接来自本地缓存）。
        如需跨 worker 聚合请用 list_online_global。"""
        out = []
        for entry in self._local_ws.values():
            if entry["user_id"] != int(user_id):
                continue
            m = entry["meta"]
            out.append({
                "ua": (m.get("ua") or "")[:120],
                "ext_version": m.get("ext_version", ""),
                "joined_at": m.get("joined_at", 0),
            })
        return out

    async def list_online_global(self, user_id: int) -> list:
        """跨 worker 聚合：从 Redis online set 拿 ws_id，再批量取每个 ws 的 meta hash。"""
        await self.ensure_started()
        if not self._redis_ok or self._redis is None:
            return self.list_online(user_id)
        try:
            ws_ids = list(await self._redis.smembers(_redis_key_online(user_id)) or [])
        except Exception as e:
            logger.warning(f"[ext-registry] smembers failed: {e}")
            return self.list_online(user_id)
        out = []
        for ws_id in ws_ids:
            try:
                h = await self._redis.hgetall(_redis_key_ws_meta(ws_id)) or {}
                out.append({
                    "ua": (h.get("ua") or "")[:120],
                    "ext_version": h.get("ext_version", ""),
                    "joined_at": int(h.get("joined_at") or 0),
                })
            except Exception:
                continue
        return out

    async def dispatch(self, user_id: int, task: Dict[str, Any], timeout: float = 60.0) -> Any:
        """跨 worker 派任务。

        - 同 worker：直接 ws.send_json + 本地 future
        - 跨 worker：通过 pubsub 发到目标 worker 的 task channel；本地 future 等 result channel 回流
        - in-memory fallback：等价于旧的单 worker 行为
        """
        await self.ensure_started()
        task_id = task.get("id") or uuid.uuid4().hex
        task["id"] = task_id

        # 选目标 ws_id
        target_ws_id, target_worker_id = await self._pick_target(int(user_id))
        if not target_ws_id:
            raise RuntimeError("no online extension for user")

        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self.pending[task_id] = future

        try:
            if target_worker_id == WORKER_ID or not self._redis_ok:
                # 本地直送
                entry = self._local_ws.get(target_ws_id)
                if not entry:
                    # in-memory fallback 时找 user_id 第一个本地连接
                    if not self._redis_ok:
                        for e in self._local_ws.values():
                            if e["user_id"] == int(user_id):
                                entry = e
                                break
                if not entry:
                    raise RuntimeError("ws gone before dispatch")
                ws = entry["ws"]
                await ws.send_json({"type": "task", "task": task})
            else:
                # 跨 worker pubsub
                assert self._redis is not None
                payload = json.dumps({
                    "ws_id": target_ws_id,
                    "task": task,
                    "origin_worker": WORKER_ID,
                })
                await self._redis.publish(_redis_chan_task(target_worker_id), payload)
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(f"task {task_id} timeout after {timeout}s")
        finally:
            self.pending.pop(task_id, None)

    def resolve(self, task_id: str, ok: bool, data: Any = None, error: str = "") -> None:
        """ws 收到 result 时调用。

        - 任务原本就是本 worker 派的 → pending 里有 future，直接 resolve
        - 任务是别的 worker 派来的（pubsub 收的）→ 本地没有 future，需要把 result 发回 result channel
        """
        fut = self.pending.get(task_id)
        if fut and not fut.done():
            if ok:
                fut.set_result(data)
            else:
                fut.set_exception(RuntimeError(error or "task failed"))
            return
        # 本地没有 future：尝试 publish 回 result channel（让原发起 worker 拿到）
        if self._redis_ok and self._redis is not None:
            asyncio.create_task(self._publish_result(task_id, ok, data, error))

    # ── 内部：Redis 注册 / 心跳 / pubsub ─────────────────────────────────────

    async def _async_register(self, ws_id: str, user_id: int, meta: Dict[str, Any]) -> None:
        await self.ensure_started()
        if not self._redis_ok or self._redis is None:
            self._mem_online.setdefault(user_id, set()).add(ws_id)
            return
        try:
            pipe = self._redis.pipeline()
            pipe.sadd(_redis_key_online(user_id), ws_id)
            pipe.set(_redis_key_ws_worker(ws_id), WORKER_ID, ex=WS_TTL_SEC)
            # meta hash 用 hset + expire
            safe_meta = {
                "user_id": str(user_id),
                "worker_id": WORKER_ID,
                "ua": str(meta.get("ua", ""))[:200],
                "ext_version": str(meta.get("ext_version", "")),
                "joined_at": str(int(meta.get("joined_at") or time.time())),
            }
            pipe.hset(_redis_key_ws_meta(ws_id), mapping=safe_meta)
            pipe.expire(_redis_key_ws_meta(ws_id), WS_TTL_SEC)
            await pipe.execute()
        except Exception as e:
            logger.warning(f"[ext-registry] redis register failed ws_id={ws_id[:8]}: {e}")
            self._mem_online.setdefault(user_id, set()).add(ws_id)
            return
        # 启动心跳
        entry = self._local_ws.get(ws_id)
        if entry is not None:
            entry["hb"] = asyncio.create_task(self._heartbeat_loop(ws_id, user_id))
        # 顺便刷一次全局在线数缓存（让 sync online_count() 在多 worker 下也能立即看到）
        try:
            n = int(await self._redis.scard(_redis_key_online(user_id)))
            self._online_cache_global[user_id] = n
        except Exception:
            pass

    async def _async_unregister(self, ws_id: str, user_id: int) -> None:
        if self._redis_ok and self._redis is not None:
            try:
                pipe = self._redis.pipeline()
                pipe.srem(_redis_key_online(user_id), ws_id)
                pipe.delete(_redis_key_ws_worker(ws_id))
                pipe.delete(_redis_key_ws_meta(ws_id))
                await pipe.execute()
            except Exception as e:
                logger.warning(f"[ext-registry] redis unregister failed: {e}")
            # 刷一次全局在线数缓存
            try:
                n = int(await self._redis.scard(_redis_key_online(user_id)))
                self._online_cache_global[user_id] = n
            except Exception:
                pass
        # 顺手清 in-memory fallback
        s = self._mem_online.get(user_id)
        if s:
            s.discard(ws_id)
            if not s:
                self._mem_online.pop(user_id, None)

    async def _heartbeat_loop(self, ws_id: str, user_id: int) -> None:
        """每 HEARTBEAT_SEC 续 worker/meta key 的 TTL；并刷一次 online set 防漂移。"""
        try:
            while ws_id in self._local_ws and self._redis_ok and self._redis is not None:
                await asyncio.sleep(HEARTBEAT_SEC)
                try:
                    pipe = self._redis.pipeline()
                    pipe.expire(_redis_key_ws_worker(ws_id), WS_TTL_SEC)
                    pipe.expire(_redis_key_ws_meta(ws_id), WS_TTL_SEC)
                    pipe.sadd(_redis_key_online(user_id), ws_id)
                    await pipe.execute()
                except Exception as e:
                    logger.warning(f"[ext-registry] heartbeat failed ws_id={ws_id[:8]}: {e}")
        except asyncio.CancelledError:
            pass

    async def _pick_target(self, user_id: int):
        """选一个在线 ws_id + 它所在的 worker_id。Redis 不可用时返回本地任一连接。"""
        if not self._redis_ok or self._redis is None:
            # in-memory：返回任一本地连接，worker_id 当成自己
            for ws_id, entry in self._local_ws.items():
                if entry["user_id"] == int(user_id):
                    return ws_id, WORKER_ID
            return None, None
        try:
            ws_ids = list(await self._redis.smembers(_redis_key_online(user_id)) or [])
        except Exception as e:
            logger.warning(f"[ext-registry] smembers failed: {e}")
            return None, None
        # 优先选本 worker 的连接（少一次 pubsub round-trip）
        for ws_id in ws_ids:
            if ws_id in self._local_ws:
                return ws_id, WORKER_ID
        # 否则任挑一个，查它的 worker
        for ws_id in ws_ids:
            try:
                wid = await self._redis.get(_redis_key_ws_worker(ws_id))
            except Exception:
                wid = None
            if wid:
                return ws_id, wid
            # worker key 过期 / 漂移 → 顺手清掉 stale 的 online 成员
            try:
                await self._redis.srem(_redis_key_online(user_id), ws_id)
            except Exception:
                pass
        return None, None

    async def _publish_result(self, task_id: str, ok: bool, data: Any, error: str) -> None:
        if not self._redis_ok or self._redis is None:
            return
        try:
            await self._redis.publish(
                _redis_chan_result(task_id),
                json.dumps({"id": task_id, "ok": bool(ok), "data": data, "error": error or ""}),
            )
        except Exception as e:
            logger.warning(f"[ext-registry] publish result failed task={task_id[:8]}: {e}")

    async def _pubsub_loop(self) -> None:
        """单循环处理：
          - ext:task:{WORKER_ID}     收到别人转发过来的任务，本地 ws.send_json
          - ext:result:*             收到别人 resolve 的结果，匹配本地 future
        """
        assert self._pubsub is not None
        logger.info(f"[ext-registry] pubsub loop started worker={WORKER_ID[:8]}")
        try:
            while True:
                try:
                    msg = await self._pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                except Exception as e:
                    logger.warning(f"[ext-registry] pubsub get_message err: {e}")
                    await asyncio.sleep(0.5)
                    continue
                if not msg:
                    continue
                try:
                    chan = msg.get("channel") or ""
                    raw = msg.get("data") or ""
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", errors="ignore")
                    if isinstance(chan, bytes):
                        chan = chan.decode("utf-8", errors="ignore")
                    body = json.loads(raw) if raw else {}
                except Exception as e:
                    logger.warning(f"[ext-registry] pubsub decode err: {e}")
                    continue

                if chan == _redis_chan_task(WORKER_ID):
                    await self._handle_remote_task(body)
                elif chan.startswith("ext:result:"):
                    await self._handle_remote_result(body)
        except asyncio.CancelledError:
            pass

    async def _handle_remote_task(self, body: Dict[str, Any]) -> None:
        ws_id = body.get("ws_id") or ""
        task = body.get("task") or {}
        entry = self._local_ws.get(ws_id)
        task_id = task.get("id") or ""
        if not entry:
            # ws 已掉线/不在本 worker 了，发个失败回去
            logger.warning(f"[ext-registry] remote task arrived but ws_id={ws_id[:8]} gone")
            await self._publish_result(task_id, False, None, "ws gone on target worker")
            return
        try:
            await entry["ws"].send_json({"type": "task", "task": task})
        except Exception as e:
            logger.warning(f"[ext-registry] forward remote task send err: {e}")
            await self._publish_result(task_id, False, None, f"ws send failed: {e}")

    async def _handle_remote_result(self, body: Dict[str, Any]) -> None:
        task_id = body.get("id") or ""
        fut = self.pending.get(task_id)
        if not fut or fut.done():
            return
        if body.get("ok"):
            fut.set_result(body.get("data"))
        else:
            fut.set_exception(RuntimeError(body.get("error") or "task failed"))

    # ── 兼容旧字段（meta dict 风格访问）─────────────────────────────────────
    # 旧 websocket handler 里有 `registry.meta[ws]` 这种用法；保留一个只读视图避免破坏行为。
    @property
    def meta(self) -> "_MetaView":
        return _MetaView(self)


class _MetaView:
    """兼容旧代码 `registry.meta[ws]` / `registry.meta[ws] = {...}` 的轻量包装。
    实际写在 _local_ws[ws_id]["meta"]，并同步刷一次 Redis hash。"""

    def __init__(self, owner: "ExtensionRegistry") -> None:
        self._owner = owner

    def get(self, ws: WebSocket, default: Any = None) -> Any:
        ws_id = self._owner._ws_to_id.get(ws)
        if not ws_id:
            return default
        entry = self._owner._local_ws.get(ws_id)
        if not entry:
            return default
        return entry["meta"]

    def __getitem__(self, ws: WebSocket) -> Dict[str, Any]:
        v = self.get(ws)
        if v is None:
            raise KeyError(ws)
        return v

    def __setitem__(self, ws: WebSocket, value: Dict[str, Any]) -> None:
        ws_id = self._owner._ws_to_id.get(ws)
        if not ws_id:
            return
        entry = self._owner._local_ws.get(ws_id)
        if not entry:
            return
        entry["meta"] = dict(value or {})
        # 异步刷一次 Redis hash（best effort）
        if self._owner._redis_ok and self._owner._redis is not None:
            async def _flush() -> None:
                try:
                    safe = {
                        "ua": str(entry["meta"].get("ua", ""))[:200],
                        "ext_version": str(entry["meta"].get("ext_version", "")),
                        "joined_at": str(int(entry["meta"].get("joined_at") or time.time())),
                    }
                    await self._owner._redis.hset(_redis_key_ws_meta(ws_id), mapping=safe)
                    await self._owner._redis.expire(_redis_key_ws_meta(ws_id), WS_TTL_SEC)
                except Exception as e:
                    logger.warning(f"[ext-registry] meta flush failed: {e}")
            asyncio.create_task(_flush())

    def pop(self, ws: WebSocket, default: Any = None) -> Any:
        # remove() 已经清理过；这里保留兼容即可
        return self.get(ws, default)


registry = ExtensionRegistry()


@router.websocket("/ws")
async def extension_ws(ws: WebSocket, token: str = Query(...)) -> None:
    """扩展长连入口。token 从 query string 传（浏览器 WebSocket 不支持自定义 header）。"""
    payload = verify_token(token)
    if not payload or "user_id" not in payload:
        # WebSocket 标准没有 401，按惯例用 4401 (4xxx 应用自定义)
        await ws.close(code=4401)
        return
    user_id = int(payload["user_id"])
    # 在 accept 之前先 ensure_started，让 Redis pubsub 在第一个连接时就建好
    await registry.ensure_started()
    await ws.accept()
    registry.add(user_id, ws, {"joined_at": int(time.time())})
    logger.info(f"[ext] user {user_id} connected (online local: {registry.online_count(user_id)})")

    try:
        while True:
            data = await ws.receive_json()
            t = data.get("type")
            if t == "ping":
                await ws.send_json({"type": "pong", "ts": data.get("ts")})
            elif t == "hello":
                # 更新 meta（UA、ext_version）
                meta = registry.meta.get(ws, {})
                meta["ua"] = data.get("ua", "")
                meta["ext_version"] = data.get("ext_version", "")
                registry.meta[ws] = meta
            elif t == "result":
                # 失败时只透传 error code（如 captcha_required / login_required /
                # no_response_captured）— 由 dispatcher 翻译成用户友好提示。
                # debug.seen_urls 仅记到 logger 供运维查询，不暴露给前端。
                err_msg = data.get("error", "")
                debug = data.get("debug")
                if debug and not data.get("ok"):
                    final_url = (debug.get("final_tab_url") or "")[:200]
                    seen_urls = debug.get("seen_urls") or []
                    logger.info(
                        f"[ext] task {data.get('id', '')[:8]} failed code={err_msg!r} "
                        f"final={final_url!r} seen={len(seen_urls)}"
                    )
                registry.resolve(
                    task_id=data.get("id", ""),
                    ok=bool(data.get("ok")),
                    data=data.get("data"),
                    error=err_msg,
                )
            else:
                logger.debug(f"[ext] unknown msg type from user {user_id}: {t}")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[ext] user {user_id} ws error: {e}")
    finally:
        registry.remove(user_id, ws)
        logger.info(f"[ext] user {user_id} disconnected (remaining: {registry.online_count(user_id)})")


# ========================================================================
# REST 调试 + 状态查询
# ========================================================================

class DispatchTestPayload(BaseModel):
    type: str = "echo"
    payload: Dict[str, Any] = {}
    timeout: float = 30.0


@router.post("/dispatch_test")
async def dispatch_test(
    body: DispatchTestPayload,
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """调试用：派一个任务给当前用户的扩展，等结果原样返回。

    用法（curl）:
        curl -X POST http://127.0.0.1:8080/api/extension/dispatch_test \\
          -H "Authorization: Bearer $TOKEN" \\
          -H "Content-Type: application/json" \\
          -d '{"type":"echo","payload":{"hello":"world"}}'
    """
    user_id = int(current_user["id"])
    if await registry.online_count_global(user_id) == 0:
        raise HTTPException(status_code=503, detail="no online extension for this user")
    task = {"id": uuid.uuid4().hex, "type": body.type, "payload": body.payload}
    try:
        result = await registry.dispatch(user_id, task, timeout=body.timeout)
        return {"task": task, "ok": True, "result": result}
    except Exception as e:
        return {"task": task, "ok": False, "error": str(e)}


@router.get("/status")
async def extension_status(current_user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """当前用户的在线扩展实例列表（跨 worker 聚合）。"""
    user_id = int(current_user["id"])
    return {
        "online_count": await registry.online_count_global(user_id),
        "instances": await registry.list_online_global(user_id),
    }


# 公开端点：扩展启动时拉一次，对比本地 manifest.version 决定是否提示升级。
# 不需要鉴权（version 不是敏感信息），扩展启动即查询。
@router.get("/version")
async def extension_recommended_version() -> Dict[str, Any]:
    """返回服务端推荐的扩展版本（直接读仓库的 extension/manifest.json）。

    流程：每次发新版只需 bump manifest.json 里的 version，重新部署后端，
    用户的 popup 启动时拉这个端点 → 比对本地 → 显示橙色更新提示。
    """
    import json
    from pathlib import Path
    manifest_path = Path(__file__).parent.parent.parent / "extension" / "manifest.json"
    try:
        data = json.loads(manifest_path.read_text())
        return {
            "recommended": data.get("version", ""),
            "name": data.get("name", "TrendPulse Helper"),
            "minimum_chrome": data.get("minimum_chrome_version", ""),
        }
    except Exception:
        return {"recommended": "", "name": "TrendPulse Helper"}


# ========================================================================
# 业务任务: XHS 关键词搜索（同步派单 + 入库）
# ========================================================================

class XhsSearchRequest(BaseModel):
    keyword: str
    min_likes: int = 0
    max_results: int = 30           # 想抓多少篇（1-200，超过 100 会被扩展端 5 页 cap）
    timeout_ms: int = 25000
    timeout: float = 60.0           # 整体调度超时（秒）
    pages: Optional[int] = None     # 兼容老调用；不传时按 max_results 自动算


@router.post("/run_xhs_search")
async def run_xhs_search(
    body: XhsSearchRequest,
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """同步派 1 次 XHS 关键词搜索任务给该用户的扩展，结果落 trending_posts。"""
    from ..services import extension_dispatcher

    user_id = int(current_user["id"])
    if not body.keyword.strip():
        raise HTTPException(status_code=400, detail="keyword required")
    if not extension_dispatcher.has_online_extension(user_id):
        raise HTTPException(status_code=503, detail="no online extension; please install TrendPulse Helper and login first")

    return await extension_dispatcher.dispatch_xhs_search(
        user_id=user_id,
        keyword=body.keyword.strip(),
        min_likes=body.min_likes,
        max_results=body.max_results,
        timeout_ms=body.timeout_ms,
        pages=body.pages,
        overall_timeout=body.timeout,
    )


@router.post("/run_douyin_search")
async def run_douyin_search(
    body: XhsSearchRequest,  # 复用结构（字段一致）
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """同步派 1 次抖音关键词搜索任务给该用户的扩展，结果落 trending_posts(platform=douyin)。"""
    from ..services import extension_dispatcher

    user_id = int(current_user["id"])
    if not body.keyword.strip():
        raise HTTPException(status_code=400, detail="keyword required")
    if not extension_dispatcher.has_online_extension(user_id):
        raise HTTPException(status_code=503, detail="no online extension")

    return await extension_dispatcher.dispatch_douyin_search(
        user_id=user_id,
        keyword=body.keyword.strip(),
        min_likes=body.min_likes,
        max_results=body.max_results,
        timeout_ms=body.timeout_ms,
        pages=body.pages,
        overall_timeout=body.timeout,
    )


class NoteDetailRequest(BaseModel):
    note_id: str
    xsec_token: str = ""
    timeout_ms: int = 15000


@router.post("/run_xhs_note_detail")
async def run_xhs_note_detail(
    body: NoteDetailRequest,
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """通过扩展抓单条 XHS 笔记详情（cookie-only 字段补全）。"""
    from ..services import extension_dispatcher
    if not extension_dispatcher.has_online_extension(int(current_user["id"])):
        raise HTTPException(503, "no online extension")
    return await extension_dispatcher.dispatch_xhs_note_detail(
        user_id=int(current_user["id"]),
        note_id=body.note_id, xsec_token=body.xsec_token,
        timeout_ms=body.timeout_ms,
    )


class PublishRequest(BaseModel):
    platform: str  # 'xhs' | 'douyin'
    title: str = ""
    body: str = ""
    images: list = []      # url 列表
    video_url: str = ""    # 抖音视频
    topics: list = []      # 话题列表


@router.post("/run_publish")
async def run_publish(
    body: PublishRequest,
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """通过扩展模拟用户在 creator 平台发布。

    前提：浏览器已登录对应 creator 域 (creator.xiaohongshu.com / creator.douyin.com)。
    """
    from ..services import extension_dispatcher
    user_id = int(current_user["id"])
    if not extension_dispatcher.has_online_extension(user_id):
        raise HTTPException(503, "no online extension")
    if body.platform not in ("xhs", "douyin"):
        raise HTTPException(400, f"unsupported platform {body.platform}")
    return await extension_dispatcher.dispatch_publish(
        user_id=user_id, platform=body.platform,
        payload={
            "title": body.title, "body": body.body,
            "images": body.images, "video_url": body.video_url,
            "topics": body.topics,
        },
    )


@router.get("/tasks")
async def list_ext_tasks(
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
) -> Dict[str, Any]:
    """当前用户的扩展任务历史（含 pending/running/done/failed）。"""
    from ..services import monitor_db
    rows = await monitor_db.ext_task_list_recent(int(current_user["id"]), limit=limit)
    return {"tasks": rows, "total": len(rows)}


@router.get("/install_token")
async def get_install_token(current_user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """生成一个长期 token 给扩展用（避免每天到期，扩展场景下 30 天合理）。

    实际上现在 verify_token 已经接受常规 token，先不强制区分；
    后续如果需要可以加一个独立的 ext_token claim。
    """
    # TODO: 单独签一个 30 天有效的 ext token；现在暂时返回提示用普通 login token
    return {
        "tip": "extension 暂时使用登录 token；从 localStorage.token 复制即可",
    }
