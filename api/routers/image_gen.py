# -*- coding: utf-8 -*-
"""商品图生成：调第三方图像 API（OpenAI 兼容）。

路由前缀 /monitor/image。

端点：
- GET  /monitor/image/config             读取配置（不返回 api_key 明文）
- POST /monitor/image/config             保存配置
- POST /monitor/image/generate-prompts   AI 一键生成商品图 Prompt 列表
- POST /monitor/image/generate           调用 OpenAI 兼容接口生成图片（支持参考图）
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .auth import get_current_user
from ..services import monitor_db
from ..services.platforms import get_platform, detect_platform
from ..services import monitor_fetcher
from ..services import storage
from ..services import qiniu_uploader
from ..services import local_storage
from ..services import feishu_bitable
from ..services import image_upload_worker

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/monitor/image", tags=["ImageGen"])


# ── Pydantic models ─────────────────────────────────────────────────────────

class SaveImageConfigRequest(BaseModel):
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    size: Optional[str] = None


class GeneratePromptsRequest(BaseModel):
    subject: str                        # 商品主体，例如"护肤精华"
    scenes: List[str] = []             # 场景列表，例如["白底","生活场景"]
    style: str = ""                    # 风格，例如"电商简洁"
    platform: str = "小红书"           # 目标平台
    extras: str = ""                   # 额外描述
    language: str = "en"               # prompt 语言："zh"=中文，"en"=英文


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = ""
    n: Optional[int] = 1
    size: Optional[str] = None
    reference_image_b64: Optional[str] = None  # base64 编码的参考图
    # 套图维度（用于历史记录编号）。前端分批请求时通过 start_index 累加。
    images_per_set: Optional[int] = 1
    start_index: Optional[int] = 0          # 这一批是全局第几张开始（0-indexed）
    # 来源标记：如果 prompt 是从某个小红书/抖音作品 URL 拉来的
    source_post_url: Optional[str] = ""
    source_post_title: Optional[str] = ""
    # 同时生成配套文案（标题 + 正文）：勾选时 AI 基于 prompt + 平台调性写一篇笔记，
    # 同一批次的所有图共用一份文案，省 AI 成本
    auto_rewrite: Optional[bool] = False
    target_platform: Optional[str] = "xhs"  # xhs / douyin / mp
    # 多批次共享文案：前端首批拿到 title/body 后，后续批次回传过来直接复用，避免每批都调 AI
    forced_title: Optional[str] = ""
    forced_body: Optional[str] = ""
    # 同一次"生成"操作的 uuid：前端生成，所有图共享，用于历史 UI 按 (batch_id, set_idx) 分组
    batch_id: Optional[str] = ""


class FetchPostCoverRequest(BaseModel):
    """从小红书/抖音 URL 拉取封面图（作为生成参考）。"""
    url: str


class SyncImageBitableRequest(BaseModel):
    """把若干历史记录同步到飞书多维表格的图像专用 sheet。"""
    record_ids: List[int]
    # 可选：指定目标 table_id；不传则用 resolve_target 算出来的默认（用户级 image_table > 全局 image_table）
    target_table_id: Optional[str] = None


class GenerateSetPlanRequest(BaseModel):
    """让 AI 一次生成 N 套 × M 张差异化方案。

    每套返回 {title, body, image_prompts: [M 条不同视角的 prompt]}。

    mode：
      - product（商品图）：每套主题/卖点全不同，镜头/构图全不同
      - remix（作品仿写）：保持原作品主体一致（人物动作/商品/构图），
        每套只换背景 / 场景 / 光线 / 时间 / 天气
    """
    base_prompt: str
    sets: int = 1
    images_per_set: int = 1
    target_platform: str = "xhs"
    source_post_url: Optional[str] = ""
    source_post_title: Optional[str] = ""
    source_post_desc: Optional[str] = ""
    mode: Optional[str] = "product"  # product | remix


# ── Endpoints ───────────────────────────────────────────────────────────────

DEFAULT_SIZE = "1024x1024"


@router.get("/proxy", summary="代理拉取图片（解决 mixed content）")
async def proxy_image(url: str):
    """前端在 HTTPS 页面里加载 HTTP 七牛图会被浏览器拦截，统一走这个代理。

    白名单：仅允许七牛域名（*.clouddn.com / *.qiniucdn.com / 配置的 qiniu_domain）
    + 本地存储 public_url_prefix。其他来源拒绝。
    """
    from urllib.parse import urlparse
    from fastapi.responses import StreamingResponse, Response

    if not url:
        raise HTTPException(status_code=400, detail="缺少 url 参数")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="非法 URL")

    # 白名单校验
    qiniu_domain = (await monitor_db.get_setting("qiniu_domain", "")).strip()
    qiniu_host = urlparse(qiniu_domain if qiniu_domain.startswith(("http://", "https://"))
                          else f"http://{qiniu_domain}").netloc
    public_prefix = (await monitor_db.get_setting("public_url_prefix", "")).strip()
    public_host = urlparse(public_prefix).netloc if public_prefix else ""
    allowed_hosts = {qiniu_host, public_host} - {""}
    # 七牛默认域后缀也放行
    suffix_ok = parsed.netloc.endswith((".clouddn.com", ".qiniucdn.com", ".qbox.me"))
    if not (parsed.netloc in allowed_hosts or suffix_ok):
        raise HTTPException(status_code=403, detail=f"域名 {parsed.netloc} 不在白名单")

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as cli:
            r = await cli.get(url)
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail="上游返回错误")
            content_type = r.headers.get("content-type", "image/png")
            return Response(
                content=r.content,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"代理失败：{e}")


@router.get("/config", summary="读取图像 API 配置")
async def get_image_config(current_user: dict = Depends(get_current_user)) -> dict:
    base_url = await monitor_db.get_setting("image_api_base_url", "")
    model = await monitor_db.get_setting("image_api_model", "")
    size = await monitor_db.get_setting("image_api_size", DEFAULT_SIZE)
    api_key = await monitor_db.get_setting("image_api_key", "")
    return {
        "base_url": base_url,
        "model": model,
        "size": size or DEFAULT_SIZE,
        "has_key": bool(api_key),
    }


@router.post("/config", summary="保存图像 API 配置")
async def save_image_config(
    req: SaveImageConfigRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    if req.base_url is not None:
        await monitor_db.set_setting("image_api_base_url", req.base_url.strip())
    if req.model is not None:
        await monitor_db.set_setting("image_api_model", req.model.strip())
    if req.size is not None and req.size.strip():
        await monitor_db.set_setting("image_api_size", req.size.strip())
    if req.api_key is not None and req.api_key.strip():
        await monitor_db.set_setting("image_api_key", req.api_key.strip())
    return {"ok": True}


@router.post("/generate-prompts", summary="AI 一键生成商品图 Prompt")
async def generate_prompts(
    req: GeneratePromptsRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    ai_base_url = (await monitor_db.get_setting("ai_base_url", "")).strip()
    ai_api_key = (await monitor_db.get_setting("ai_api_key", "")).strip()
    ai_model = (await monitor_db.get_setting("ai_model", "gpt-4o-mini")).strip() or "gpt-4o-mini"

    if not ai_base_url or not ai_api_key:
        return {"error": "AI 服务未配置，请在「系统配置」中填写 AI Base URL 和 API Key"}

    scenes_str = "、".join(req.scenes) if req.scenes else "白底纯色"
    style_str = req.style or "电商简洁"
    platform_str = req.platform or "小红书"

    use_chinese = req.language == "zh"
    if use_chinese:
        system_prompt = (
            "你是专业的电商商品图 AI 提示词工程师，擅长为各类电商平台生成高转化率的商品图生成提示词。\n"
            "根据用户提供的商品信息，生成 5 条不同风格/场景的中文 prompt，用于 AI 图像生成。\n"
            "要求：\n"
            "1. 每条 prompt 单独一行，以 '数字. ' 开头（如 '1. xxx'）\n"
            "2. 每条 prompt 语言简洁精准，包含：商品特写描述、背景/场景、光线、构图角度、画面风格\n"
            "3. 结尾统一加质量词：高质量，8k，专业商品摄影，清晰对焦\n"
            "4. 只输出 5 条编号 prompt，不要有其他说明文字\n"
            "5. 每条 prompt 要有差异化，覆盖不同角度或场景变体"
        )
    else:
        system_prompt = (
            "你是专业的电商商品图 AI 提示词工程师，擅长为各类电商平台生成高转化率的商品图生成提示词。\n"
            "根据用户提供的商品信息，生成 5 条不同风格/场景的英文 prompt，用于 AI 图像生成。\n"
            "要求：\n"
            "1. 每条 prompt 单独一行，以 '数字. ' 开头（如 '1. xxx'）\n"
            "2. 每条 prompt 语言简洁精准，包含：商品特写描述、背景/场景、光线、构图角度、画面风格\n"
            "3. 结尾统一加质量词：high quality, 8k, professional product photography, sharp focus\n"
            "4. 只输出 5 条编号 prompt，不要有其他说明文字\n"
            "5. 每条 prompt 要有差异化，覆盖不同角度或场景变体"
        )

    user_msg = (
        f"商品主体：{req.subject}\n"
        f"期望场景：{scenes_str}\n"
        f"画面风格：{style_str}\n"
        f"目标平台：{platform_str}\n"
        f"补充描述：{req.extras or '无'}\n\n"
        "请生成 5 条适合该商品的图像生成 prompt。"
    )

    headers_ai = {
        "Authorization": f"Bearer {ai_api_key}",
        "Content-Type": "application/json",
    }
    url = f"{ai_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.85,
        "max_tokens": 1200,
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=payload, headers=headers_ai)
            if resp.status_code >= 400:
                try:
                    body = resp.json()
                    err = body.get("error") or {}
                    detail = (err.get("message") if isinstance(err, dict) else err) or resp.text
                except Exception:
                    detail = resp.text or f"HTTP {resp.status_code}"
                return {"error": f"AI 服务错误：{detail}"}
            ct = resp.headers.get("content-type", "")
            if "text/html" in ct or resp.text.lstrip().startswith("<!"):
                return {"error": f"AI 服务地址配置有误，返回了 HTML 页面（URL：{url}）。请在「系统配置」中填写正确的 AI Base URL。"}
            try:
                data = resp.json()
            except Exception:
                return {"error": f"AI 服务返回了非 JSON 响应（状态 {resp.status_code}）：{resp.text[:200]}"}
    except httpx.TimeoutException:
        return {"error": "AI 服务响应超时（30s），请稍后重试"}
    except httpx.HTTPError as e:
        return {"error": f"网络错误：{e}"}
    except Exception as e:
        logger.exception(f"[generate_prompts] unexpected: {e}")
        return {"error": f"未知错误：{e}"}

    content = (
        data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    )
    if not content:
        return {"error": "AI 未返回有效内容"}

    prompts: List[str] = []
    for line in content.split("\n"):
        line = line.strip()
        m = re.match(r"^\d+[.)、:：]\s*(.+)$", line)
        if m:
            prompts.append(m.group(1).strip())
        elif line and len(line) > 20 and not re.match(r"^\d+$", line) and len(prompts) < 5:
            prompts.append(line)

    if not prompts:
        prompts = [l.strip() for l in content.split("\n") if l.strip() and len(l.strip()) > 10][:5]

    return {"prompts": prompts[:5]}


def _normalize_image_items(data: dict) -> List[dict]:
    items: List[dict] = []
    raw = data.get("data") or []
    if isinstance(raw, list):
        for it in raw:
            if not isinstance(it, dict):
                continue
            b64 = it.get("b64_json") or it.get("b64")
            url = it.get("url")
            if b64:
                items.append({"b64": b64})
            elif url:
                items.append({"url": url})
    return items


# 单次上游请求最多生成几张：超过此值后端会拆成多次循环调用。
# 多数 OpenAI 兼容图像 API 单次最多 4 张，gpt-image / dall-e-3 单次只支持 1 张
# （即使传 n=4 也只返 1 张，导致总数只剩 1/4）。
_MAX_PER_BATCH_DEFAULT = 4
_SINGLE_IMAGE_MODELS = ("gpt-image", "dall-e-3", "dall-e-2", "wanx2", "cogview")


def _max_per_batch_for(model: str) -> int:
    """根据模型名判定单次最多生成张数。"""
    m = (model or "").lower()
    for keyword in _SINGLE_IMAGE_MODELS:
        if keyword in m:
            return 1
    return _MAX_PER_BATCH_DEFAULT
# /generate 单次请求最多生成的总张数。
# 套图场景上限 = 10 套账号 × 9 张轮播 = 90，但实际是前端按 4 张/批多次调用，
# 所以这里只是"单次最大"。设 60 已经足够（覆盖绝大多数自定义组合），
# 防止误填超大数字一锅端打爆上游。
_MAX_TOTAL = 60


async def _call_generations(
    client: httpx.AsyncClient, *, base_url: str, model: str, prompt: str,
    n: int, size: str, headers: dict,
) -> tuple[Optional[List[dict]], Optional[dict]]:
    """调上游 /images/generations 一次。返回 (images, error_dict)。"""
    gen_url = f"{base_url.rstrip('/')}/images/generations"
    try:
        resp = await client.post(
            gen_url,
            json={
                "model": model, "prompt": prompt, "n": n,
                "size": size, "response_format": "b64_json",
            },
            headers={**headers, "Content-Type": "application/json"},
        )
    except httpx.TimeoutException:
        return None, {"error": "图像生成超时（180s），请稍后重试", "status": 504}
    except httpx.HTTPError as e:
        return None, {"error": f"网络错误：{e}", "status": 502}

    if resp.status_code >= 400:
        try:
            err = (resp.json().get("error") or {})
            detail = (err.get("message") if isinstance(err, dict) else err) or resp.text
        except Exception:
            detail = resp.text or f"HTTP {resp.status_code}"
        logger.warning(f"[image_gen] upstream {resp.status_code}: {detail}")
        return None, {"error": f"上游接口错误：{detail}", "status": resp.status_code}

    ct = resp.headers.get("content-type", "")
    if "text/html" in ct or resp.text.lstrip().startswith("<!"):
        hint = "Base URL 末尾可能缺少 /v1" if "/v1" not in base_url else "请确认 Base URL 指向正确的图像生成服务"
        return None, {
            "error": f"上游返回了 HTML 页面而非 JSON（状态 {resp.status_code}）。{hint}。",
            "status": 502,
        }
    try:
        data = resp.json()
    except Exception:
        return None, {"error": f"上游返回了非 JSON 响应：{resp.text[:200]}", "status": 502}

    images = _normalize_image_items(data)
    if not images:
        return None, {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return images, None


async def _call_edits(
    client: httpx.AsyncClient, *, base_url: str, model: str, prompt: str,
    n: int, size: str, img_bytes: bytes, headers: dict,
) -> tuple[Optional[List[dict]], Optional[dict]]:
    """调上游 /images/edits 一次（参考图）。返回 (images, error_dict)。"""
    edit_url = f"{base_url.rstrip('/')}/images/edits"
    try:
        resp = await client.post(
            edit_url,
            files={"image": ("reference.png", img_bytes, "image/png")},
            data={
                "model": model, "prompt": prompt, "n": str(n),
                "size": size, "response_format": "b64_json",
            },
            headers=headers,
        )
    except httpx.TimeoutException:
        return None, {"error": "图像生成超时（180s），请稍后重试", "status": 504}
    except httpx.HTTPError as e:
        return None, {"error": f"网络错误：{e}", "status": 502}

    if resp.status_code >= 400:
        try:
            err = (resp.json().get("error") or {})
            detail = (err.get("message") if isinstance(err, dict) else err) or resp.text
        except Exception:
            detail = resp.text or f"HTTP {resp.status_code}"
        logger.warning(f"[image_gen][edits] upstream {resp.status_code}: {detail}")
        return None, {
            "error": f"参考图生成失败：{detail}（当前模型可能不支持图片编辑）",
            "status": resp.status_code,
        }

    try:
        data = resp.json()
    except Exception:
        return None, {"error": f"上游返回非 JSON 响应：{resp.text[:200]}", "status": 502}

    images = _normalize_image_items(data)
    if not images:
        return None, {"error": "上游未返回图片（响应格式不兼容）", "status": 502}
    return images, None


_CAPTION_PLATFORM_BRIEFS = {
    "xhs": (
        "你为小红书写笔记。**核心原则：写真实使用感受 / 心情 / 故事，不要重复或描述图片本身。**\n"
        "- 标题 18 字内，带数字 / 钩子句 / 反问，吸引点击\n"
        "- 正文 200-300 字，3-5 段，每段开头 emoji，关键词加粗（用 **）\n"
        "- 写第一人称视角，给生活场景细节（地点 / 时间 / 心情 / 用过/没用过的对比）\n"
        "- 不要照搬图片场景词，把它当作配图灵感即可\n"
        "- 结尾给 3-5 个话题标签 #xxx#，与生活场景相关\n"
    ),
    "douyin": (
        "你为抖音视频写口播脚本（图文版也按这个调性）。**核心原则：写抓眼球的口播，不是描述画面。**\n"
        "- 标题 12 字内，开头 3 秒抓眼球（数字 / 反差 / 提问）\n"
        "- 正文 100-200 字，按口播节奏分行，每行 15-25 字\n"
        "- 用强烈情绪词、反差词、口语化表达\n"
        "- 不要复述图片场景词，从「为什么观众应该看」切入\n"
        "- 结尾留钩子（点关注 / 问问题）\n"
    ),
    "mp": (
        "你为微信公众号写文章导言（图文版）。**核心原则：观点先行，图片只是论据。**\n"
        "- 标题 25 字内，正式、信息量足\n"
        "- 正文 300-500 字，分段叙述，论据/观点为主，少用 emoji\n"
        "- 给读者一个明确的「为什么读这篇」\n"
        "- 不要把图片场景描述当成正文素材\n"
        "- 结尾给 1-2 句行动呼吁\n"
    ),
}


async def _generate_caption(
    image_prompt: str,
    platform: str = "xhs",
    source_title: str = "",
) -> tuple[str, str, str]:
    """让 AI 基于图片场景描述写一篇配套笔记（标题 + 正文）。

    返回 (title, body, error)；error 非空表示失败，前两个返回 ""。
    """
    ai_base_url = (await monitor_db.get_setting("ai_base_url", "")).strip()
    ai_api_key = (await monitor_db.get_setting("ai_api_key", "")).strip()
    ai_model = (await monitor_db.get_setting("ai_model", "gpt-4o-mini")).strip() or "gpt-4o-mini"
    if not ai_base_url or not ai_api_key:
        return "", "", "AI 服务未配置（ai_base_url / ai_api_key）"

    brief = _CAPTION_PLATFORM_BRIEFS.get(platform, _CAPTION_PLATFORM_BRIEFS["xhs"])
    system_prompt = (
        "你是专业的爆款内容创作者。配图已经画好了，"
        "你要做的是基于配图主题，写一篇**会让人想点赞收藏的真实笔记**——而不是描述图片。\n\n"
        + brief
        + "\n严格按 JSON 输出，不要任何解释：{\"title\": \"...\", \"body\": \"...\"}"
    )
    # 把 image_prompt 弱化为「灵感参考」，并明确 anti-pattern
    user_msg = (
        "配图灵感（仅供参考主题，不要复述其中的视觉描写词）：\n"
        f"{image_prompt}\n\n"
        + (f"参考标题（参考调性，不要照抄）：{source_title}\n\n" if source_title else "")
        + "请写一篇这个主题的真实笔记。\n"
        + "**禁止**：复述图片描述词、提到「图片」「画面」「场景」、把 prompt 当文案。\n"
        + "**应当**：站在第一人称，写感受、故事、对比、避坑、清单。"
    )

    url = f"{ai_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        # 温度提高到 1.1，让仿写多样化（避免每套都长得像）
        "temperature": 1.1,
        "max_tokens": 1000,
        "response_format": {"type": "json_object"},  # 部分兼容模型支持
    }
    headers = {"Authorization": f"Bearer {ai_api_key}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                return "", "", f"AI HTTP {resp.status_code}: {resp.text[:200]}"
            data = resp.json()
    except httpx.TimeoutException:
        return "", "", "AI 响应超时（45s）"
    except Exception as e:
        return "", "", f"AI 调用异常：{e}"

    content = (
        data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    )
    if not content:
        return "", "", "AI 未返回内容"

    # 尝试 JSON parse；不行就退回到正则提取
    import json as _json, re as _re
    try:
        obj = _json.loads(content)
        return (obj.get("title") or "").strip(), (obj.get("body") or "").strip(), ""
    except Exception:
        m_t = _re.search(r'"title"\s*:\s*"([^"]+)"', content)
        m_b = _re.search(r'"body"\s*:\s*"([^"]+)"', content, _re.DOTALL)
        if m_t and m_b:
            return m_t.group(1), m_b.group(1), ""
        # 兜底：把整段内容当 body
        return "", content[:1500], ""


async def _generate_caption_variants(
    base_prompt: str,
    n_variants: int,
    images_per_set: int = 1,
    platform: str = "xhs",
    source_title: str = "",
    source_desc: str = "",
    mode: str = "product",
) -> tuple[List[dict], str]:
    """让 AI 一次生成 N 套 × M 张差异化方案。

    返回 ([{title, body, image_prompts: [M 条]}, ...], error)。

    mode：
      - product：套间 title/body/角度全不同；套内 image_prompts 镜头/构图不同
      - remix：保持原作品主体（人物动作/商品/构图）一致；
               套间换不同的背景方向（咖啡店 / 户外 / 夜景 / ...）；
               套内 M 张是同一背景的不同细节角度
    """
    if n_variants < 1:
        return [], "n_variants 必须 ≥ 1"
    images_per_set = max(1, int(images_per_set))
    ai_base_url = (await monitor_db.get_setting("ai_base_url", "")).strip()
    ai_api_key = (await monitor_db.get_setting("ai_api_key", "")).strip()
    ai_model = (await monitor_db.get_setting("ai_model", "gpt-4o-mini")).strip() or "gpt-4o-mini"
    if not ai_base_url or not ai_api_key:
        return [], "AI 服务未配置（ai_base_url / ai_api_key）"

    brief = _CAPTION_PLATFORM_BRIEFS.get(platform, _CAPTION_PLATFORM_BRIEFS["xhs"])

    if mode == "remix":
        # 作品仿写：保持原作品主体不变，只换背景/场景
        system_prompt = (
            f"你是专业的「内容仿写」创作者，用户已经选定一个**爆款作品作为模板**，"
            f"你要为它生成 {n_variants} 套不同的「换背景」版本，每套含 "
            f"{images_per_set} 张配图描述。\n\n"
            f"**核心约束（最关键）：保持原作品的主体元素不变**——\n"
            f"  • 人物姿态 / 表情 / 动作 / 服装风格保持一致\n"
            f"  • 商品 / 道具的形态、颜色、构图位置不变\n"
            f"  • 整体画面构图、人/物比例不变\n\n"
            f"**只允许变化的元素**：\n"
            f"  • 背景场景（咖啡店、户外街道、海边、家居室内、办公室、酒店大堂、夜市…）\n"
            f"  • 光线 / 时段（晨光、正午、黄昏、夜间）\n"
            f"  • 天气 / 氛围（晴天、阴天、雨天、雾、雪）\n"
            f"  • 季节 / 装饰（圣诞、夏日、新年）\n\n"
            f"两层差异化：\n"
            f"1. **套与套之间**：换不同方向的背景（套1-咖啡店、套2-户外公园、套3-室内阳光房…）。"
            f"title/body 描述同一产品在不同场景的体验差异，让读者感觉「同一作者在不同地方都用这个产品」。\n"
            f"2. **每套内 {images_per_set} 张**：同一背景下的不同角度（推近/拉远、左右切换），"
            f"主体保持一致，背景细节微调。\n\n"
            + brief
            + f"\n严格按 JSON 输出（{n_variants} 个 variant）：\n"
            + '{"variants": [{"title": "...", "body": "...", "image_prompts": ['
            + ', '.join(['"prompt_' + str(i+1) + '"' for i in range(min(images_per_set, 3))])
            + (', ...]' if images_per_set > 3 else ']')
            + ']}, ...]}\n'
            + "image_prompts 用英文写，每条 prompt 必须以「Same subject as reference image, "
            + "preserve pose/composition/products. Change ONLY background to: ...」开头。"
        )
        user_msg = (
            f"原作品场景 prompt（基于参考图分析得出）：\n{base_prompt}\n\n"
            + (f"原作品标题：{source_title}\n" if source_title else "")
            + (f"原作品正文（前 300 字）：{source_desc[:300]}\n" if source_desc else "")
            + f"\n请生成 {n_variants} 套换背景版本，每套 {images_per_set} 张。"
            + "记住：主体不变，只换背景。"
        )
    else:
        # 商品图（默认）：套间套内全维度差异化
        system_prompt = (
            f"你是专业的内容创作者。为同一个产品/选题生成 {n_variants} 套笔记，每套含 "
            f"{images_per_set} 张差异化的配图描述。\n\n"
            f"两层差异化要求：\n"
            f"1. **套与套之间**：title / body 必须**完全不同的角度**（亲身经历、对比测评、"
            f"干货清单、提问钩子、反差体验等），避免被识别为矩阵号搬运。\n"
            f"2. **每套内 {images_per_set} 张**：image_prompts 是 {images_per_set} 个 prompt，"
            f"必须**保持商品主体一致**（同一产品/同一服务），但**镜头、构图、前景物、"
            f"光线、机位、人物动作要明显不同**（特写 vs 全景；俯拍 vs 平视；"
            f"主体单独 vs 加配饰；正面 vs 侧面；白天 vs 夜晚；室内 vs 户外 等）。\n\n"
            + brief
            + f"\n严格按 JSON 输出（必须有 {n_variants} 个 variant，每个的 image_prompts "
            + f"长度必须 ≥ {images_per_set}）：\n"
            + '{"variants": [{"title": "...", "body": "...", "image_prompts": ['
            + ', '.join(['"prompt_' + str(i+1) + '"' for i in range(min(images_per_set, 3))])
            + (', ...]' if images_per_set > 3 else ']')
            + '}, ...]}'
        )
        user_msg = (
            f"原图片 / 商品场景 prompt：\n{base_prompt}\n\n"
            + (f"参考来源标题：{source_title}\n" if source_title else "")
            + (f"参考来源正文（前 300 字）：{source_desc[:300]}\n" if source_desc else "")
            + f"\n请生成 {n_variants} 套 × {images_per_set} 张的方案。"
            + f"image_prompts 用英文写更稳，每条都要明确视觉差异（不要复制粘贴）。"
        )

    url = f"{ai_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.95,
        "max_tokens": min(8000, (400 + 200 * images_per_set) * n_variants),
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {ai_api_key}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                return [], f"AI HTTP {resp.status_code}: {resp.text[:200]}"
            data = resp.json()
    except httpx.TimeoutException:
        return [], "AI 响应超时（120s）"
    except Exception as e:
        return [], f"AI 调用异常：{e}"

    content = (
        data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    )
    if not content:
        return [], "AI 未返回内容"

    import json as _json
    try:
        obj = _json.loads(content)
        variants = obj.get("variants") or []
    except Exception as e:
        return [], f"AI 输出 JSON 解析失败：{e}"
    if not variants:
        return [], "AI 未返回 variants"

    cleaned = []
    for v in variants:
        if not isinstance(v, dict):
            continue
        prompts = v.get("image_prompts") or []
        if isinstance(prompts, str):  # 容错：AI 偶尔返回字符串
            prompts = [prompts]
        prompts = [str(p).strip() for p in prompts if p]
        # 套内不足 M 张：用 base_prompt 加视角后缀补齐
        while len(prompts) < images_per_set:
            i = len(prompts)
            angles = [
                "wide angle shot, full scene", "close-up detail shot",
                "from above, top-down view", "side angle, 45 degree",
                "with hand interaction in frame", "lifestyle scene with subtle props",
                "evening warm light", "morning soft light",
                "minimal background, isolated subject",
            ]
            angle = angles[i % len(angles)]
            prompts.append(f"{base_prompt}, {angle}")
        cleaned.append({
            "title": (v.get("title") or "").strip(),
            "body": (v.get("body") or "").strip(),
            "image_prompts": prompts[:images_per_set],
        })
    if not cleaned:
        return [], "AI 输出格式异常，无可用 variant"
    while len(cleaned) < n_variants:
        cleaned.append(dict(cleaned[-1]))
    return cleaned[:n_variants], ""


@router.post("/generate-set-plan", summary="为 N 套 × M 张图生成差异化方案（每套独立文案 + image prompt）")
async def generate_set_plan(
    req: GenerateSetPlanRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """前端在生成 N 套图前先调这个，拿到 N 份独立的 {title, body, image_prompt}，
    然后循环按每套的 image_prompt 生成对应图片，写历史时带各套自己的 title/body。
    """
    if req.sets < 1:
        return {"error": "sets 必须 ≥ 1"}
    if req.sets > 30:
        return {"error": "sets 上限 30（避免 AI 一次输出过长）"}
    variants, err = await _generate_caption_variants(
        base_prompt=(req.base_prompt or "").strip(),
        n_variants=req.sets,
        images_per_set=max(1, int(req.images_per_set or 1)),
        platform=req.target_platform or "xhs",
        source_title=(req.source_post_title or "").strip(),
        source_desc=(req.source_post_desc or "").strip(),
        mode=(req.mode or "product"),
    )
    if err:
        return {"error": err}
    return {"plan": variants}


@router.post("/generate", summary="调用第三方图像 API 生成图片（支持参考图）")
async def generate_image(
    req: GenerateRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    base_url = (await monitor_db.get_setting("image_api_base_url", "")).strip()
    api_key = (await monitor_db.get_setting("image_api_key", "")).strip()
    model = (await monitor_db.get_setting("image_api_model", "")).strip()
    cfg_size = (await monitor_db.get_setting("image_api_size", DEFAULT_SIZE)).strip() or DEFAULT_SIZE

    if not base_url or not api_key or not model:
        return {"error": "图像 API 未配置（base_url / api_key / model 必填）", "status": 400}

    prompt = (req.prompt or "").strip()
    if not prompt:
        return {"error": "prompt 不能为空", "status": 400}

    neg = (req.negative_prompt or "").strip()
    final_prompt = f"{prompt}\n\nNegative prompt: {neg}" if neg else prompt

    n = max(1, min(int(req.n or 1), _MAX_TOTAL))
    size = (req.size or "").strip() or cfg_size
    auth_headers = {"Authorization": f"Bearer {api_key}"}

    img_bytes: Optional[bytes] = None
    if req.reference_image_b64:
        try:
            img_bytes = base64.b64decode(req.reference_image_b64)
        except Exception as e:
            return {"error": f"参考图解码失败：{e}", "status": 400}

    # 多张时分批：根据 model 决定单次上游最大张数（gpt-image / dall-e-3 只能 n=1）。
    # 顺序调用而非并发——避免触发上游限流，也方便把第一次失败的错误直接返回。
    max_per_batch = _max_per_batch_for(model)
    batches: list[int] = []
    remaining = n
    while remaining > 0:
        take = min(remaining, max_per_batch)
        batches.append(take)
        remaining -= take

    # 历史记录 + 七牛上传上下文
    user_id = current_user.get("id") if current_user else None
    images_per_set = max(1, int(req.images_per_set or 1))
    start_index = max(0, int(req.start_index or 0))
    used_reference = img_bytes is not None
    src_url = (req.source_post_url or "").strip()
    src_title = (req.source_post_title or "").strip()
    # 异步上传策略：始终先写本地（拿到立即可用的 URL），如配了七牛就把记录标 pending
    # 后台 scheduler 异步推到云端，用户立刻能拿到 URL 同步飞书也能用。
    local_ready = await local_storage.is_configured()
    qiniu_ready = await qiniu_uploader.is_configured()

    # AI 配套文案：
    # - 前端传了 forced_title/body（后续批次复用首批结果）→ 直接用
    # - 否则首批 + auto_rewrite=true → 调 AI 生成一次
    # - 其它情况 → 留空
    gen_title, gen_body, caption_err = "", "", ""
    if (req.forced_title or "").strip() or (req.forced_body or "").strip():
        gen_title = (req.forced_title or "").strip()
        gen_body = (req.forced_body or "").strip()
    elif req.auto_rewrite:
        gen_title, gen_body, caption_err = await _generate_caption(
            prompt, platform=(req.target_platform or "xhs"), source_title=src_title,
        )
        if caption_err:
            logger.warning(f"[image_gen] caption skipped: {caption_err}")

    all_images: List[dict] = []
    timeout = httpx.Timeout(180.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for batch_n in batches:
            if img_bytes is not None:
                images, err = await _call_edits(
                    client, base_url=base_url, model=model, prompt=final_prompt,
                    n=batch_n, size=size, img_bytes=img_bytes, headers=auth_headers,
                )
            else:
                images, err = await _call_generations(
                    client, base_url=base_url, model=model, prompt=final_prompt,
                    n=batch_n, size=size, headers=auth_headers,
                )
            if err:
                # 已经拿到一部分时，返回部分成功 + 错误原因，避免用户白等
                if all_images:
                    return {
                        "images": all_images,
                        "partial": True,
                        "requested": n,
                        "error": err.get("error"),
                    }
                return err

            # 每张：①写本地拿到立即可用 URL ②写历史 ③配了七牛就标 pending
            # 用户立刻能下载 + 同步飞书；后台 scheduler 慢慢把图推到七牛 CDN
            for offset, img in enumerate(images or []):
                global_idx = start_index + len(all_images) + offset
                set_idx = global_idx // images_per_set + 1
                in_set_idx = global_idx % images_per_set + 1

                local_url = ""
                qiniu_url_sync = ""

                # 1) 优先写本地，异步 worker 后续推七牛
                if local_ready and img.get("b64"):
                    lurl, lerr = await local_storage.upload_b64(img["b64"], user_id=user_id)
                    if lurl:
                        local_url = lurl
                        img["url"] = lurl
                    elif lerr:
                        logger.warning(f"[image_gen] local write failed (set {set_idx}-{in_set_idx}): {lerr}")

                # 2) 没本地存储但配了七牛 → 同步直传（fallback）
                if not local_url and qiniu_ready and img.get("b64"):
                    qurl, qerr = await qiniu_uploader.upload_b64(img["b64"], user_id=user_id)
                    if qurl:
                        qiniu_url_sync = qurl
                        img["url"] = qurl
                    elif qerr:
                        logger.warning(f"[image_gen] qiniu sync upload failed (set {set_idx}-{in_set_idx}): {qerr}")

                # upload_status:
                #   pending  → 本地 + 七牛都配，待 worker 异步推
                #   uploaded → 同步直传七牛已成功
                #   skipped  → 仅本地，没七牛
                #   failed   → 都没存储成功
                if local_url and qiniu_ready:
                    upload_status = "pending"
                elif qiniu_url_sync:
                    upload_status = "uploaded"
                elif local_url:
                    upload_status = "skipped"
                else:
                    upload_status = "failed"

                try:
                    await monitor_db.add_image_history(
                        user_id=user_id, prompt=prompt,
                        negative_prompt=neg, size=size, model=model,
                        set_idx=set_idx, in_set_idx=in_set_idx,
                        local_url=local_url,
                        qiniu_url=qiniu_url_sync or local_url,  # 同步传成功用七牛；否则用本地（worker 会覆盖）
                        upload_status=upload_status,
                        generated_title=gen_title,
                        generated_body=gen_body,
                        batch_id=(req.batch_id or "").strip(),
                        source_post_url=src_url, source_post_title=src_title,
                        used_reference=used_reference,
                    )
                except Exception as e:
                    logger.warning(f"[image_gen] write history failed: {e}")

            all_images.extend(images or [])

    return {
        "images": all_images,
        "requested": n,
        "local_ready": local_ready,
        "qiniu_async_pending": qiniu_ready,  # 是否会异步推七牛
        "storage_backend": "local+async-qiniu" if (local_ready and qiniu_ready) else
                           ("local" if local_ready else "none"),
        # AI 配套文案（首批生成；前端拿到后续批次回传）
        "generated_title": gen_title,
        "generated_body": gen_body,
        "caption_error": caption_err,
    }


@router.post("/fetch-post-cover", summary="从小红书/抖音作品 URL 拉取封面图作为参考")
async def fetch_post_cover(
    req: FetchPostCoverRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """粘贴作品 URL → 返回 {cover_b64, title, desc, platform}。
    用于"基于一个小红书作品生成 N 套图"的快捷流程。
    """
    raw_url = (req.url or "").strip()
    if not raw_url:
        return {"error": "URL 不能为空"}

    plat = detect_platform(raw_url)
    if not plat:
        return {"error": "无法识别 URL 所属平台（仅支持小红书/抖音）"}

    info = await plat.resolve_url(raw_url)
    if not info:
        return {"error": "URL 解析失败，请确认链接有效"}

    if plat.name == "xhs":
        metrics, status = await monitor_fetcher.fetch_note_metrics(
            note_id=info["post_id"],
            xsec_token=info.get("xsec_token", ""),
            xsec_source=info.get("xsec_source", "app_share"),
            account=None,
        )
    else:
        metrics, status = await plat.fetch_detail(
            {"post_id": info["post_id"], "note_id": info["post_id"],
             "url": info.get("url", "")}, account=None,
        )

    if not metrics:
        # 按状态给具体原因，方便用户判断是 Pulse 问题还是源链接问题
        reason_map = {
            "deleted": "笔记已被作者删除 / 设为仅自己可见 / 被平台屏蔽（XHS 跳转 404，errorCode=-510001）。请换一篇能在浏览器无痕窗口正常打开的链接。",
            "login_required": "该链接需要登录态才能访问（XHS 跳转登录页）。这种 token（如来自 pc_user / 个人主页）通常只在登录浏览器内有效，建议复制爆款笔记的「分享」链接，分享链接的 xsec_source=app_share，匿名可访问。",
            "error": "抓取失败，可能被风控或链接已失效（也可能是临时网络问题，过几分钟重试）。",
        }
        return {"error": reason_map.get(status, f"作品抓取失败（status={status}）")}

    cover_url = metrics.get("cover_url") or ""
    images = metrics.get("images") or []
    if not cover_url and images:
        cover_url = images[0]
    if not cover_url:
        return {"error": "未能从作品中提取到封面图"}

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(cover_url)
            if resp.status_code >= 400:
                return {"error": f"封面图下载失败：HTTP {resp.status_code}"}
            cover_b64 = base64.b64encode(resp.content).decode("ascii")
    except Exception as e:
        return {"error": f"封面图下载错误：{e}"}

    return {
        "cover_b64": cover_b64,
        "title": metrics.get("title") or "",
        "desc": (metrics.get("desc") or "")[:500],
        "platform": plat.name,
        "platform_label": plat.label,
        "post_id": info["post_id"],
    }


# ── 历史记录 ─────────────────────────────────────────────────────────────────

@router.get("/history", summary="商品图生成历史记录")
async def list_history(
    limit: int = 100, offset: int = 0,
    current_user: dict = Depends(get_current_user),
) -> dict:
    """admin 看全部，普通用户只看自己的。"""
    user_id = current_user.get("id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    scope_uid = None if role == "admin" else user_id
    rows = await monitor_db.list_image_history(
        user_id=scope_uid,
        limit=max(1, min(limit, 500)),
        offset=max(0, offset),
    )
    backend = await storage.active_backend()
    return {
        "records": rows,
        "qiniu_configured": backend != "none",  # 兼容前端字段名（实际指"图片存储已配置"）
        "storage_backend": backend,
    }


@router.delete("/history/{record_id}", summary="删除历史记录")
async def delete_history(
    record_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    # admin 传 None 可删任何，普通用户只能删自己的
    scope_uid = None if role == "admin" else user_id
    ok = await monitor_db.delete_image_history(record_id, user_id=scope_uid)
    return {"ok": ok}


@router.post("/history/{record_id}/retry-upload", summary="把 failed 记录重置为 pending 重试")
async def retry_upload(
    record_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    rec = await monitor_db.get_image_history(record_id)
    if not rec:
        return {"ok": False, "error": "记录不存在"}
    role = (current_user or {}).get("role") or "user"
    if role != "admin" and rec.get("user_id") != current_user.get("id"):
        return {"ok": False, "error": "无权操作"}
    await monitor_db.reset_image_upload_failed(record_id)
    return {"ok": True}


@router.post("/upload-worker/run", summary="立即触发一次七牛上传（admin only，调试用）")
async def trigger_upload_worker(
    current_user: dict = Depends(get_current_user),
) -> dict:
    role = (current_user or {}).get("role") or "user"
    if role != "admin":
        return {"ok": False, "error": "需要管理员权限"}
    return await image_upload_worker.run_batch()


@router.post("/history/sync-bitable", summary="把历史记录同步到飞书多维表格")
async def sync_history_to_bitable(
    req: SyncImageBitableRequest,
    current_user: dict = Depends(get_current_user),
) -> dict:
    if not req.record_ids:
        return {"error": "未选中任何记录", "status": 400}

    # 优先写用户专属表（OAuth 绑定后自动建），缺失时 fallback 到全局 admin 表
    from ..services.feishu import bitable as feishu_bitable_v2
    target = await feishu_bitable_v2.resolve_target(current_user, kind="image")
    if target["source"] == "none":
        return {
            "error": "未找到飞书图像表。请先「绑定飞书」让系统自动建表，"
                     "或让管理员在「系统配置」配 feishu_bitable_app_token + feishu_bitable_image_table_id 作为兜底。",
            "status": 400,
        }
    app_token = target["app_token"]
    table_id = target["table_id"]
    # 用户在前端选了非默认 table → 覆盖 table_id（app_token 共用一个 bitable）
    if (req.target_table_id or "").strip():
        table_id = req.target_table_id.strip()

    # 字段校验：一行 = 一套（同 batch_id + 同 set_idx 的多张图合并为一行）
    # 字段类型：1=多行文本 2=数字 15=超链接
    expected_fields = [
        ("套号", 2),
        ("张数", 2),
        ("标题", 1), ("正文", 1),
        # 9 列图片 URL（小红书轮播图最多 9 张）。不够 9 张时多余字段留空。
        ("图片1", 15), ("图片2", 15), ("图片3", 15),
        ("图片4", 15), ("图片5", 15), ("图片6", 15),
        ("图片7", 15), ("图片8", 15), ("图片9", 15),
        ("Prompt", 1), ("尺寸", 1), ("模型", 1),
        ("来源链接", 15), ("来源标题", 1),
        ("生成时间", 1),
    ]
    try:
        for fname, ftype in expected_fields:
            await feishu_bitable_v2.ensure_field(app_token, table_id, fname, ftype)
    except Exception as e:
        return {"error": f"准备表格字段失败：{e}", "status": 400}

    user_id = current_user.get("id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    scope_uid = None if role == "admin" else user_id

    # 先把 record_ids 全部捞出来，按 (batch_id, set_idx) 分组
    # 一行 = 一套（同 batch_id + 同 set_idx 的 N 张图合并）。老数据 batch_id="" 时按 record id 单独成组。
    fetched: List[dict] = []
    skip_results: List[dict] = []
    for rid in req.record_ids:
        rec = await monitor_db.get_image_history(rid)
        if not rec:
            skip_results.append({"id": rid, "ok": False, "reason": "记录不存在"})
            continue
        if scope_uid is not None and rec.get("user_id") != scope_uid:
            skip_results.append({"id": rid, "ok": False, "reason": "无权同步该记录"})
            continue
        url = (rec.get("qiniu_url") or "").strip()
        if not url:
            skip_results.append({"id": rid, "ok": False, "reason": "图片未上传到七牛（先配七牛再生成）"})
            continue
        fetched.append(rec)

    # 按 (batch_id || "single:{id}", set_idx) 分组
    groups: dict = {}
    for rec in fetched:
        bid = (rec.get("batch_id") or "").strip()
        gkey = f"{bid}:{rec.get('set_idx', 1)}" if bid else f"single:{rec['id']}"
        groups.setdefault(gkey, []).append(rec)
    # 组内按套内序号排序，让"图片1"对应套内第 1 张
    for gkey, items in groups.items():
        items.sort(key=lambda x: (x.get("in_set_idx") or 0))

    results: List[dict] = list(skip_results)
    for gkey, items in groups.items():
        first = items[0]
        src_url = (first.get("source_post_url") or "").strip()
        # 构造 9 列图片（不够 9 张时多余字段空字符串）
        image_cols = {}
        for i in range(9):
            field = f"图片{i+1}"
            if i < len(items):
                u = (items[i].get("qiniu_url") or "").strip()
                image_cols[field] = {"link": u, "text": u} if u else ""
            else:
                image_cols[field] = ""
        fields_payload = {
            "套号": first.get("set_idx", 1),
            "张数": len(items),
            "标题": first.get("generated_title", ""),
            "正文": first.get("generated_body", ""),
            **image_cols,
            "Prompt": first.get("prompt", ""),
            "尺寸": first.get("size", ""),
            "模型": first.get("model", ""),
            "来源链接": ({"link": src_url, "text": src_url} if src_url else ""),
            "来源标题": first.get("source_post_title", ""),
            "生成时间": first.get("created_at", ""),
        }
        ids = [it["id"] for it in items]
        try:
            await feishu_bitable_v2.add_record(app_token, table_id, fields=fields_payload)
            for rid in ids:
                await monitor_db.mark_image_history_synced(rid)
            # 每组算 N 条成功（让前端 toast 数量直观）
            for rid in ids:
                results.append({"id": rid, "ok": True, "set_key": gkey})
        except Exception as e:
            for rid in ids:
                results.append({"id": rid, "ok": False, "reason": str(e), "set_key": gkey})

    ok_count = sum(1 for r in results if r.get("ok"))
    fail_count = len(results) - ok_count
    # 实际写入飞书的"行数" = 成功的组数（一组一行）
    synced_rows = len({r.get("set_key") for r in results if r.get("ok") and r.get("set_key")})

    # 同步成功 → 给用户的飞书专属群发一条卡片通知（含 bitable 链接 + 数量 + 表名）
    chat_id = (current_user.get("feishu_chat_id") or "").strip() if current_user else ""
    if ok_count > 0 and chat_id:
        try:
            from ..services.feishu import bitable as feishu_bitable_v2_2
            tables = await feishu_bitable_v2_2.list_tables(app_token)
            table_name = next((t["name"] for t in tables if t["table_id"] == table_id), "默认表")
        except Exception:
            table_name = "默认表"
        try:
            from ..services.feishu import chat as chat_api
            bitable_url = f"https://feishu.cn/base/{app_token}?table={table_id}"
            content = (
                f"已同步 **{synced_rows}** 套（共 {ok_count} 张图）到表「**{table_name}**」"
                + (f"，{fail_count} 张失败" if fail_count else "")
                + f"\n\n[👉 打开飞书表格]({bitable_url})"
            )
            card = chat_api.build_alert_card(
                "📋 商品图同步完成", content,
                template="green" if fail_count == 0 else "orange",
            )
            await chat_api.send_card(chat_id, card)
        except Exception as e:
            logger.warning(f"[image_gen] post-sync chat notify failed: {e}")

    return {"results": results, "target": target["source"]}
