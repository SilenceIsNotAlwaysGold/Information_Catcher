# -*- coding: utf-8 -*-
"""image_gen router 装配。

子模块：
- product：商品图（自创）：generate-prompts、generate
- remix：仿写：fetch-post-cover、remix-tasks (CRUD)
- 本文件：公共端点（config、proxy、history、sync-bitable、retry-upload、upload-worker/run）

路由前缀 /monitor/image。
"""
from __future__ import annotations

import logging
from typing import List
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..auth import get_current_user
from ...services import monitor_db, image_upload_worker, storage
from ._common import DEFAULT_SIZE, SaveImageConfigRequest, SyncImageBitableRequest
from . import product, remix

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/monitor/image", tags=["ImageGen"])

# 子模块端点挂上来
router.include_router(product.router)
router.include_router(remix.router)


# ── 公共端点 ────────────────────────────────────────────────────────────────

_PLATFORM_CDN_SUFFIXES = (
    # 小红书图片 CDN（sns-img-* / sns-webpic-* / ci-*）
    ".xhscdn.com", ".xiaohongshu.com",
    # 抖音图片 CDN（p3-pc / p6-pc / ...douyinpic.com、byteimg.com、bytedance）
    ".douyinpic.com", ".byteimg.com", ".bytedance.com",
    # 公众号图片（mmbiz）
    ".qpic.cn", ".qq.com",
)
_QINIU_CDN_SUFFIXES = (".clouddn.com", ".qiniucdn.com", ".qbox.me")


def _referer_for(host: str) -> str:
    """部分平台 CDN 有 Referer 防盗链，按域名兜对应来源。"""
    if host.endswith((".xhscdn.com", ".xiaohongshu.com")):
        return "https://www.xiaohongshu.com/"
    if host.endswith((".douyinpic.com", ".byteimg.com", ".bytedance.com")):
        return "https://www.douyin.com/"
    if host.endswith((".qpic.cn", ".qq.com")):
        return "https://mp.weixin.qq.com/"
    return ""


@router.get("/proxy", summary="代理拉取图片（解决 mixed content + 平台 CDN 防盗链）")
async def proxy_image(url: str):
    """前端在 HTTPS 页面里加载 HTTP 七牛图 / 跨域 CDN 图会被浏览器拦截，统一走这个代理。

    白名单：
      - 七牛云 / 配置的 public_url_prefix（自有图）
      - 小红书 / 抖音 / 公众号 平台 CDN（作品仿写从外部抓回来的图）
    平台 CDN 走代理时按域名补 Referer，规避防盗链 403。
    """
    if not url:
        raise HTTPException(status_code=400, detail="缺少 url 参数")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="非法 URL")

    qiniu_domain = (await monitor_db.get_setting("qiniu_domain", "")).strip()
    qiniu_host = urlparse(qiniu_domain if qiniu_domain.startswith(("http://", "https://"))
                          else f"http://{qiniu_domain}").netloc
    public_prefix = (await monitor_db.get_setting("public_url_prefix", "")).strip()
    public_host = urlparse(public_prefix).netloc if public_prefix else ""
    allowed_hosts = {qiniu_host, public_host} - {""}
    suffix_ok = parsed.netloc.endswith(_QINIU_CDN_SUFFIXES + _PLATFORM_CDN_SUFFIXES)
    if not (parsed.netloc in allowed_hosts or suffix_ok):
        raise HTTPException(status_code=403, detail=f"域名 {parsed.netloc} 不在白名单")

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
    }
    referer = _referer_for(parsed.netloc)
    if referer:
        headers["Referer"] = referer

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as cli:
            r = await cli.get(url, headers=headers)
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


# ── 历史记录 ─────────────────────────────────────────────────────────────────

@router.get("/history", summary="商品图生成历史记录")
async def list_history(
    limit: int = 100, offset: int = 0,
    current_user: dict = Depends(get_current_user),
) -> dict:
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
        "qiniu_configured": backend != "none",
        "storage_backend": backend,
    }


@router.delete("/history/{record_id}", summary="删除历史记录")
async def delete_history(
    record_id: int,
    current_user: dict = Depends(get_current_user),
) -> dict:
    user_id = current_user.get("id") if current_user else None
    role = (current_user or {}).get("role") or "user"
    scope_uid = None if role == "admin" else user_id
    ok = await monitor_db.delete_image_history(record_id, user_id=scope_uid)
    return {"ok": ok}


@router.post("/history/{record_id}/retry-upload", summary="重置 failed 记录为 pending")
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

    from ...services.feishu import bitable as feishu_bitable_v2
    target = await feishu_bitable_v2.resolve_target(current_user, kind="image")
    if target["source"] == "none":
        return {
            "error": "未找到飞书图像表。请先「绑定飞书」让系统自动建表，"
                     "或让管理员在「系统配置」配 feishu_bitable_app_token + feishu_bitable_image_table_id 作为兜底。",
            "status": 400,
        }
    app_token = target["app_token"]
    table_id = target["table_id"]
    if (req.target_table_id or "").strip():
        table_id = req.target_table_id.strip()

    # 字段类型：1=多行文本 2=数字 15=超链接
    expected_fields = [
        ("套号", 2),
        ("张数", 2),
        ("标题", 1), ("正文", 1),
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

    # 按 (batch_id, set_idx) 分组：仿写任务用 batch_id=task:{id}，每套独立分组
    groups: dict = {}
    for rec in fetched:
        bid = (rec.get("batch_id") or "").strip()
        gkey = f"{bid}:{rec.get('set_idx', 1)}" if bid else f"single:{rec['id']}"
        groups.setdefault(gkey, []).append(rec)
    for gkey, items in groups.items():
        items.sort(key=lambda x: (x.get("in_set_idx") or 0))

    results: List[dict] = list(skip_results)
    for gkey, items in groups.items():
        first = items[0]
        src_url = (first.get("source_post_url") or "").strip()
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
            for rid in ids:
                results.append({"id": rid, "ok": True, "set_key": gkey})
        except Exception as e:
            for rid in ids:
                results.append({"id": rid, "ok": False, "reason": str(e), "set_key": gkey})

    ok_count = sum(1 for r in results if r.get("ok"))
    fail_count = len(results) - ok_count
    synced_rows = len({r.get("set_key") for r in results if r.get("ok") and r.get("set_key")})

    chat_id = (current_user.get("feishu_chat_id") or "").strip() if current_user else ""
    if ok_count > 0 and chat_id:
        try:
            from ...services.feishu import bitable as feishu_bitable_v2_2
            tables = await feishu_bitable_v2_2.list_tables(app_token)
            table_name = next((t["name"] for t in tables if t["table_id"] == table_id), "默认表")
        except Exception:
            table_name = "默认表"
        try:
            from ...services.feishu import chat as chat_api
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
