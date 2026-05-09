"""浏览器扩展 (Pulse Helper) WebSocket 路由 + 调度入口。

架构:
    扩展 ──[ws]── /api/extension/ws  ──┐
                                       │
                          ExtensionRegistry (in-memory)
                                       │
    Pulse 服务端业务逻辑 ──dispatch()──┘

任务协议 (server → ext):
    {"type": "task", "task": {"id": "...", "type": "xhs.search", "payload": {...}}}
结果协议 (ext → server):
    {"type": "result", "id": "...", "ok": true|false, "data": {...}, "error": "..."}
心跳:
    ext → {"type": "ping", "ts": ...}
    server → {"type": "pong", "ts": ...}
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Dict, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from ..services.auth_service import verify_token
from .auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/extension", tags=["Extension"])


class ExtensionRegistry:
    """内存中维护 user_id → 在线扩展连接集合，以及待响应任务表。

    单进程实例即可（FastAPI 在 uvicorn --reload 单 worker 模式下天然单实例）。
    多 worker 部署时需要换成 Redis pub/sub，目前规模未到。
    """

    def __init__(self) -> None:
        self.conns: Dict[int, Set[WebSocket]] = {}
        self.pending: Dict[str, asyncio.Future] = {}
        # 仅做 popup/状态查询用，{ws → {"ua": ..., "joined_at": ...}}
        self.meta: Dict[WebSocket, Dict[str, Any]] = {}

    def add(self, user_id: int, ws: WebSocket, meta: Optional[Dict[str, Any]] = None) -> None:
        self.conns.setdefault(user_id, set()).add(ws)
        self.meta[ws] = meta or {}

    def remove(self, user_id: int, ws: WebSocket) -> None:
        if user_id in self.conns:
            self.conns[user_id].discard(ws)
            if not self.conns[user_id]:
                del self.conns[user_id]
        self.meta.pop(ws, None)

    def online_count(self, user_id: int) -> int:
        return len(self.conns.get(user_id, set()))

    def list_online(self, user_id: int) -> list:
        out = []
        for ws in self.conns.get(user_id, set()):
            m = self.meta.get(ws, {})
            out.append({
                "ua": m.get("ua", "")[:120],
                "ext_version": m.get("ext_version", ""),
                "joined_at": m.get("joined_at", 0),
            })
        return out

    async def dispatch(self, user_id: int, task: Dict[str, Any], timeout: float = 60.0) -> Any:
        """派一个任务给该用户的某个在线扩展，等结果。
        简单选第一个连接（未来加最少使用 / 健康分轮询）。"""
        conns = self.conns.get(user_id) or set()
        if not conns:
            raise RuntimeError("no online extension for user")
        ws = next(iter(conns))

        task_id = task.get("id") or uuid.uuid4().hex
        task["id"] = task_id
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[task_id] = future
        try:
            await ws.send_json({"type": "task", "task": task})
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(f"task {task_id} timeout after {timeout}s")
        finally:
            self.pending.pop(task_id, None)

    def resolve(self, task_id: str, ok: bool, data: Any = None, error: str = "") -> None:
        fut = self.pending.get(task_id)
        if not fut or fut.done():
            return
        if ok:
            fut.set_result(data)
        else:
            fut.set_exception(RuntimeError(error or "task failed"))


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
    await ws.accept()
    registry.add(user_id, ws, {"joined_at": int(time.time())})
    logger.info(f"[ext] user {user_id} connected (online: {registry.online_count(user_id)})")

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
    if registry.online_count(user_id) == 0:
        raise HTTPException(status_code=503, detail="no online extension for this user")
    task = {"id": uuid.uuid4().hex, "type": body.type, "payload": body.payload}
    try:
        result = await registry.dispatch(user_id, task, timeout=body.timeout)
        return {"task": task, "ok": True, "result": result}
    except Exception as e:
        return {"task": task, "ok": False, "error": str(e)}


@router.get("/status")
async def extension_status(current_user: dict = Depends(get_current_user)) -> Dict[str, Any]:
    """当前用户的在线扩展实例列表。"""
    user_id = int(current_user["id"])
    return {
        "online_count": registry.online_count(user_id),
        "instances": registry.list_online(user_id),
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
    timeout_ms: int = 25000
    pages: int = 2
    timeout: float = 60.0  # 整体调度超时（秒）


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
