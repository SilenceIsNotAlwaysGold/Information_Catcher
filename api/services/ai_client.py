"""统一 AI 客户端 —— Phase A 实现。

调用方不再直接读 monitor_settings 里的 ai_*  / image_api_* —— 全部走这个模块：

  text = await call_text(prompt, user_id=u, feature="rewrite")
  image_b64 = await call_image(prompt, user_id=u, feature="product_image")

内部解析模型路由：
  1. 显式传 model_id（ai_models.id）→ 用之
  2. 否则查用户 preferred_*_model_id
  3. 仍无 → 取 usage_type 的 default model（is_default=1）
  4. 都没 → raise

调用完写 ai_usage_logs（token / 图片数 / 状态 / latency）。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import aiosqlite
import httpx

from . import monitor_db

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────
# Model resolution
# ──────────────────────────────────────────────────────────────


@dataclass
class _ResolvedModel:
    model_row_id: int
    model_id: str           # API 调用时传的 name
    display_name: str
    usage_type: str         # text / image
    provider_id: int
    base_url: str
    api_key: str
    extra_config: dict
    max_concurrent: int = 0  # P15.8: 0 = 不限


class AIModelNotConfigured(Exception):
    """没有可用的模型 —— admin 还没配置 / 用户偏好的 model 已下架。"""


# ──────────────────────────────────────────────────────────────
# P15.8: 模型级并发控制
# 每个 model_row_id 一个 Semaphore。第一次访问时按当前 max_concurrent 创建。
# 如果 admin 调整了 max_concurrent，新值在 service 重启或 _reset_semaphore 后生效
# （生产场景里 admin 改了限制并不期望立即对正在运行的请求生效，期望对新请求生效——
# 当前实现：限制变更后新请求仍用旧 semaphore 直到下次进程重启；要立刻生效就重启服务）
_model_semaphores: Dict[int, "asyncio.Semaphore"] = {}
_model_semaphore_caps: Dict[int, int] = {}  # 记录当前 semaphore 对应的 cap，cap 变化时重建


def _get_semaphore(model_row_id: int, max_concurrent: int) -> "asyncio.Semaphore" | None:
    """返回当前 model 的 semaphore；max_concurrent<=0 返回 None（不限并发）。"""
    if max_concurrent is None or max_concurrent <= 0:
        return None
    existing_cap = _model_semaphore_caps.get(model_row_id)
    if existing_cap != max_concurrent:
        # cap 变化：重建（旧 semaphore 残留对正在排队的请求继续生效，新请求走新的）
        _model_semaphores[model_row_id] = asyncio.Semaphore(max_concurrent)
        _model_semaphore_caps[model_row_id] = max_concurrent
    return _model_semaphores[model_row_id]


async def _resolve_model(
    *,
    usage_type: str,
    model_row_id: Optional[int],
    user_id: Optional[int],
) -> _ResolvedModel:
    """按优先级解析出实际使用的模型 + provider 配置。"""
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # 1. 显式传 model_row_id —— 但必须 published（或 admin 调用未做限制）
        async def _load(mid: int) -> Optional[aiosqlite.Row]:
            async with db.execute(
                "SELECT m.*, p.base_url AS p_base_url, p.api_key AS p_api_key, p.enabled AS p_enabled "
                "FROM ai_models m JOIN ai_providers p ON m.provider_id=p.id "
                "WHERE m.id=? AND p.enabled=1",
                (mid,),
            ) as cur:
                return await cur.fetchone()

        # 用户私有模型的归属判断（不需要 published，但要 enabled）
        def _is_owned_by(row, uid) -> bool:
            try:
                ow = row["owner_user_id"]
            except (KeyError, IndexError):
                ow = None
            return ow is not None and uid is not None and int(ow) == int(uid)

        # 取用户（用于白名单 + 偏好）
        u = None
        if user_id is not None:
            from . import auth_service
            u = auth_service.get_user_by_id(int(user_id))

        row = None
        if model_row_id is not None:
            candidate = await _load(int(model_row_id))
            # 自己拥有的模型直接放行（不走白名单 / published 检查）
            if candidate is not None and _is_owned_by(candidate, user_id):
                row = candidate
            elif u and not is_model_allowed_for_user(u, int(model_row_id), usage_type):
                logger.info(
                    f"[ai_client] user {user_id} not allowed to use model {model_row_id}, fallback to default"
                )
            else:
                row = candidate

        # 2. 用户偏好
        if row is None and u is not None:
            pref = u.get(
                "preferred_text_model_id" if usage_type == "text" else "preferred_image_model_id"
            )
            if pref and is_model_allowed_for_user(u, int(pref), usage_type):
                row = await _load(int(pref))

        # 3. 系统默认
        if row is None:
            async with db.execute(
                "SELECT m.*, p.base_url AS p_base_url, p.api_key AS p_api_key, p.enabled AS p_enabled "
                "FROM ai_models m JOIN ai_providers p ON m.provider_id=p.id "
                "WHERE m.usage_type=? AND m.is_default=1 AND p.enabled=1 "
                "ORDER BY m.sort_order, m.id LIMIT 1",
                (usage_type,),
            ) as cur:
                row = await cur.fetchone()

        # 4. 还兜底不到 → 取该 usage_type 任一可用模型
        if row is None:
            async with db.execute(
                "SELECT m.*, p.base_url AS p_base_url, p.api_key AS p_api_key, p.enabled AS p_enabled "
                "FROM ai_models m JOIN ai_providers p ON m.provider_id=p.id "
                "WHERE m.usage_type=? AND p.enabled=1 "
                "ORDER BY m.sort_order, m.id LIMIT 1",
                (usage_type,),
            ) as cur:
                row = await cur.fetchone()

        if row is None:
            raise AIModelNotConfigured(
                f"未配置任何可用的 {usage_type} 模型，请联系管理员"
            )

        try:
            extra = json.loads(row["extra_config"] or "{}")
            if not isinstance(extra, dict):
                extra = {}
        except Exception:
            extra = {}
        # max_concurrent 列若不存在（迁移前），row.keys() 不含该列 → 兜底 0
        try:
            mc = row["max_concurrent"]
        except (KeyError, IndexError):
            mc = 0
        return _ResolvedModel(
            model_row_id=row["id"],
            model_id=row["model_id"],
            display_name=row["display_name"],
            usage_type=row["usage_type"],
            provider_id=row["provider_id"],
            base_url=row["p_base_url"],
            api_key=row["p_api_key"],
            extra_config=extra,
            max_concurrent=int(mc or 0),
        )


# ──────────────────────────────────────────────────────────────
# Usage logging
# ──────────────────────────────────────────────────────────────


async def _log_usage(
    *,
    user_id: Optional[int],
    model: _ResolvedModel,
    feature: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    image_count: int = 0,
    latency_ms: int = 0,
    status: str = "ok",
    error: str = "",
) -> None:
    try:
        async with aiosqlite.connect(monitor_db.DB_PATH) as db:
            await db.execute(
                "INSERT INTO ai_usage_logs "
                "(user_id, model_id, model_id_str, usage_type, input_tokens, output_tokens, "
                " image_count, latency_ms, status, error, feature) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    user_id, model.model_row_id, model.model_id, model.usage_type,
                    input_tokens, output_tokens, image_count, latency_ms,
                    status, (error or "")[:500], feature or "",
                ),
            )
            await db.commit()
    except Exception as e:
        logger.warning(f"[ai_client] log_usage failed: {e}")


# ──────────────────────────────────────────────────────────────
# Text completion
# ──────────────────────────────────────────────────────────────


async def call_text(
    prompt: str,
    *,
    model_id: Optional[int] = None,
    user_id: Optional[int] = None,
    feature: str = "",
    temperature: float = 0.8,
    max_tokens: int = 2000,
    timeout: float = 60.0,
    system_prompt: Optional[str] = None,
    extra_payload: Optional[Dict[str, Any]] = None,
) -> str:
    """统一文本生成调用。返回 assistant 的文本内容。失败抛异常并记日志。

    system_prompt: 可选系统提示词（追加为 messages[0]）
    extra_payload: 透传到 chat/completions 的额外字段，如 {"response_format": {...}}
    """
    model = await _resolve_model(
        usage_type="text", model_row_id=model_id, user_id=user_id,
    )
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model.model_id,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if extra_payload:
        payload.update(extra_payload)
    url = f"{model.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {model.api_key}",
        "Content-Type": "application/json",
    }
    sem = _get_semaphore(model.model_row_id, model.max_concurrent)

    async def _do() -> str:
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
            text_out = data["choices"][0]["message"]["content"].strip()
            usage = data.get("usage") or {}
            await _log_usage(
                user_id=user_id, model=model, feature=feature,
                input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0),
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
            return text_out
        except Exception as e:
            await _log_usage(
                user_id=user_id, model=model, feature=feature,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status="error", error=str(e),
            )
            raise

    if sem is not None:
        async with sem:
            return await _do()
    return await _do()


async def call_vision_ocr(
    *,
    image_data_url: str,
    user_id: Optional[int] = None,
    model_id: Optional[int] = None,
    feature: str = "ocr",
    timeout: float = 60.0,
    prompt: str = (
        "你是 OCR 助手。请把图片里所有可见的中文/英文/数字文字按视觉阅读顺序"
        "原样提取出来（保留换行 / 段落结构）。只输出文字本身，不要加引号、"
        "解释、Markdown 标记。"
    ),
) -> str:
    """用文本模型的 vision 能力对图片做 OCR，返回提取出的纯文本。

    image_data_url：data:image/...;base64,... 或公开可访问的 https URL。
    """
    model = await _resolve_model(
        usage_type="text", model_row_id=model_id, user_id=user_id,
    )
    # OpenAI 兼容的多模态格式：messages[0].content = [{type:"text"},{type:"image_url"}]
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        }
    ]
    payload = {
        "model": model.model_id,
        "messages": messages,
        "max_tokens": 1500,
        "temperature": 0.2,
    }
    url = f"{model.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {model.api_key}",
        "Content-Type": "application/json",
    }
    sem = _get_semaphore(model.model_row_id, model.max_concurrent)

    async def _do() -> str:
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
                body_text = resp.text or ""
                ct = (resp.headers.get("content-type") or "").lower()

                # HTML 响应：base_url 几乎肯定配错（指向了前端 SPA / 反代未覆盖
                # /chat/completions），给最明确的提示让 admin 自查
                looks_like_html = (
                    "<!doctype html" in body_text[:200].lower()
                    or "<html" in body_text[:200].lower()
                    or "text/html" in ct
                )
                if looks_like_html:
                    raise RuntimeError(
                        f"模型 API 返回的是 HTML 而不是 JSON —— "
                        f"几乎可以确定 base_url 配错了。"
                        f"实际请求 URL：{url} ；"
                        f"请去 admin → AI 配置 检查模型「{model.display_name}」"
                        f"所属 provider 的 base_url（应是 https://xxx/v1 这种）。"
                    )
                if resp.status_code >= 400:
                    raise RuntimeError(
                        f"模型 API HTTP {resp.status_code}: {body_text[:300]}"
                    )
                if not body_text.strip():
                    raise RuntimeError(
                        f"模型 API 返回空响应（HTTP {resp.status_code}）。"
                        "可能模型不支持视觉或被网关截断。"
                    )
                try:
                    data = resp.json()
                except Exception:
                    raise RuntimeError(
                        f"模型 API 返回非 JSON：{body_text[:300]}"
                    )
            choices = data.get("choices") or []
            if not choices or not isinstance(choices, list):
                raise RuntimeError(
                    f"模型未返回 choices。原始响应：{str(data)[:300]}"
                )
            text_out = (choices[0].get("message", {}).get("content") or "").strip()
            usage = data.get("usage") or {}
            await _log_usage(
                user_id=user_id, model=model, feature=feature,
                input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0),
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
            return text_out
        except Exception as e:
            await _log_usage(
                user_id=user_id, model=model, feature=feature,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status="error", error=str(e),
            )
            raise

    if sem is not None:
        async with sem:
            return await _do()
    return await _do()


async def call_text_variants(
    prompt: str,
    *,
    n: int = 3,
    temperatures: Optional[List[float]] = None,
    model_id: Optional[int] = None,
    user_id: Optional[int] = None,
    feature: str = "",
) -> List[str]:
    """并行生成 n 个不同温度的变体；失败的丢弃，剩下的返回。"""
    n = max(1, min(int(n), 5))
    temps = (temperatures or [0.7, 1.0, 1.3, 1.5, 1.7])[:n]

    async def _one(t: float) -> Optional[str]:
        try:
            return await call_text(
                prompt, model_id=model_id, user_id=user_id,
                feature=feature, temperature=t,
            )
        except Exception as e:
            logger.warning(f"[ai_client] variant t={t} failed: {e}")
            return None

    results = await asyncio.gather(*[_one(t) for t in temps])
    return [r for r in results if r]


# ──────────────────────────────────────────────────────────────
# Image generation
# ──────────────────────────────────────────────────────────────


async def call_image(
    prompt: str,
    *,
    model_id: Optional[int] = None,
    user_id: Optional[int] = None,
    feature: str = "",
    n: int = 1,
    size: Optional[str] = None,
    timeout: float = 120.0,
) -> List[str]:
    """统一图像生成 —— OpenAI 兼容 /images/generations。

    返回 b64-encoded 图像列表（不返回 URL）。如需 URL 让调用方自行上传。
    """
    model = await _resolve_model(
        usage_type="image", model_row_id=model_id, user_id=user_id,
    )
    # size 优先级：显式参数 > 模型 extra_config.size > 默认
    final_size = size or model.extra_config.get("size") or "1024x1024"
    payload: Dict[str, Any] = {
        "model": model.model_id,
        "prompt": prompt,
        "n": max(1, min(int(n), 4)),
        "size": final_size,
        "response_format": "b64_json",
    }
    url = f"{model.base_url.rstrip('/')}/images/generations"
    headers = {
        "Authorization": f"Bearer {model.api_key}",
        "Content-Type": "application/json",
    }
    sem = _get_semaphore(model.model_row_id, model.max_concurrent)

    async def _do() -> List[str]:
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
            items = data.get("data") or []
            b64s: List[str] = []
            for it in items:
                b = it.get("b64_json") or ""
                if b:
                    b64s.append(b)
                elif it.get("url"):
                    try:
                        async with httpx.AsyncClient(timeout=timeout) as c2:
                            r2 = await c2.get(it["url"])
                            r2.raise_for_status()
                            b64s.append(base64.b64encode(r2.content).decode())
                    except Exception as e:
                        logger.warning(f"[ai_client] fetch image url fallback failed: {e}")
            await _log_usage(
                user_id=user_id, model=model, feature=feature,
                image_count=len(b64s),
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )
            return b64s
        except Exception as e:
            await _log_usage(
                user_id=user_id, model=model, feature=feature,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                status="error", error=str(e),
            )
            raise

    if sem is not None:
        async with sem:
            return await _do()
    return await _do()


# ──────────────────────────────────────────────────────────────
# 给复杂调用方（如 image_gen 的 edits API）单独拿 provider 配置
# ──────────────────────────────────────────────────────────────


async def get_active_model_config(
    *,
    usage_type: str,
    user_id: Optional[int] = None,
    model_id: Optional[int] = None,
) -> Dict[str, Any]:
    """返回 {model_row_id, model_id, base_url, api_key, extra_config, max_concurrent}
    供调用方自行发请求。调用方应：
    - 在请求结束后调 log_usage 记录消耗
    - 用 acquire_slot() context manager 拿并发名额（如果 max_concurrent > 0）
    """
    m = await _resolve_model(
        usage_type=usage_type, model_row_id=model_id, user_id=user_id,
    )
    return {
        "model_row_id": m.model_row_id,
        "model_id": m.model_id,
        "display_name": m.display_name,
        "base_url": m.base_url,
        "api_key": m.api_key,
        "extra_config": m.extra_config,
        "max_concurrent": m.max_concurrent,
    }


class _NoopSlot:
    """max_concurrent<=0 时返回的空操作 context manager。"""
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False


def acquire_slot(model_row_id: int, max_concurrent: int):
    """获取该模型的并发名额。用法：
        async with ai_client.acquire_slot(row_id, max_concurrent):
            ...  # 你的 HTTP 调用
    当 max_concurrent <= 0 时为空操作。
    """
    sem = _get_semaphore(model_row_id, max_concurrent)
    return sem if sem is not None else _NoopSlot()


async def log_usage(
    *,
    user_id: Optional[int],
    model_row_id: int,
    model_id_str: str,
    usage_type: str,
    feature: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    image_count: int = 0,
    latency_ms: int = 0,
    status: str = "ok",
    error: str = "",
) -> None:
    """供 image_gen 这种自己发请求的调用方手动写日志。"""
    try:
        async with aiosqlite.connect(monitor_db.DB_PATH) as db:
            await db.execute(
                "INSERT INTO ai_usage_logs "
                "(user_id, model_id, model_id_str, usage_type, input_tokens, output_tokens, "
                " image_count, latency_ms, status, error, feature) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    user_id, model_row_id, model_id_str or "", usage_type,
                    input_tokens, output_tokens, image_count, latency_ms,
                    status, (error or "")[:500], feature or "",
                ),
            )
            await db.commit()
    except Exception as e:
        logger.warning(f"[ai_client] log_usage failed: {e}")


# ──────────────────────────────────────────────────────────────
# Utility: 给前端用的「用户可见模型列表」
# ──────────────────────────────────────────────────────────────


async def list_user_visible_models(
    usage_type: str, user: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """返回某 usage_type 下所有可见模型：admin 共享 published + 用户自己私有的。

    admin 共享：m.owner_user_id IS NULL AND m.published=1 AND p.enabled=1，再按白名单过滤
    用户私有：m.owner_user_id = current_user.id AND p.enabled=1（不受 published / 白名单影响）
    """
    uid = int(user.get("id")) if user and user.get("id") is not None else None
    async with aiosqlite.connect(monitor_db.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # 共享 + 私有 一次查
        sql = (
            "SELECT m.id, m.model_id, m.display_name, m.usage_type, m.is_default, m.extra_config, "
            "       m.owner_user_id, "
            "       p.name AS provider_name "
            "FROM ai_models m JOIN ai_providers p ON m.provider_id=p.id "
            "WHERE m.usage_type=? AND p.enabled=1 "
            "  AND (m.published=1 OR m.owner_user_id IS NOT NULL) "
            "ORDER BY (m.owner_user_id IS NULL) DESC, m.sort_order, m.id"
        )
        async with db.execute(sql, (usage_type,)) as cur:
            rows = [dict(r) for r in await cur.fetchall()]
    out: List[Dict[str, Any]] = []
    is_admin = bool(user) and (user.get("role") or "").lower() == "admin"
    allowed = _parse_allowed_models(user, usage_type) if user and not is_admin else None
    for r in rows:
        ow = r.get("owner_user_id")
        if ow is None:
            # 共享模型：admin 永远看；普通用户按白名单
            if is_admin or not user:
                out.append(r)
            elif allowed is None or r["id"] in allowed:
                out.append(r)
        else:
            # 私有：只属于自己（admin 也看不到别人的）
            if uid is not None and int(ow) == uid:
                out.append(r)
    return out


def _parse_allowed_models(user: Dict[str, Any], usage_type: str) -> Optional[set]:
    """返回用户允许的 ai_models.id 集合；None = 不限制（默认）。空集 = 全禁。"""
    if not user:
        return None
    raw = user.get(
        "allowed_text_model_ids" if usage_type == "text" else "allowed_image_model_ids"
    ) or ""
    raw = str(raw).strip()
    if not raw:
        return None  # NULL/空 = 不限
    try:
        import json as _json
        arr = _json.loads(raw)
        if isinstance(arr, list):
            return {int(x) for x in arr if isinstance(x, (int, float, str)) and str(x).isdigit()}
    except Exception:
        pass
    return None


def is_model_allowed_for_user(
    user: Optional[Dict[str, Any]], model_row_id: int, usage_type: str,
) -> bool:
    """检查 user 是否能使用 ai_models.id=model_row_id 的模型。
    admin 永远 True；无 user → True（系统调用，scheduler 等）。
    自己创建的私有模型永远 True（不受 allowed_*_model_ids 白名单影响）。
    """
    if not user:
        return True
    if (user.get("role") or "").lower() == "admin":
        return True
    # 检查是否是该用户私有模型（同步 sqlite，简单且这条 hot path 也不会卡）
    try:
        import sqlite3 as _sq3
        conn = _sq3.connect(monitor_db.DB_PATH)
        try:
            cur = conn.execute(
                "SELECT owner_user_id FROM ai_models WHERE id=?", (int(model_row_id),),
            )
            r = cur.fetchone()
            if r and r[0] is not None and int(r[0]) == int(user.get("id") or 0):
                return True
        finally:
            conn.close()
    except Exception:
        pass
    allowed = _parse_allowed_models(user, usage_type)
    if allowed is None:
        return True
    return int(model_row_id) in allowed
