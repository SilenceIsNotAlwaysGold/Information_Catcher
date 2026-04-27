from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks

from ..schemas.monitor import (
    AddPostsRequest,
    AddAccountRequest,
    UpdateAccountRequest,
    UpdateSettingsRequest,
    QRLoginStartRequest,
    CreatePromptRequest,
    UpdatePromptRequest,
    RewriteTrendingRequest,
    SyncBitableRequest,
)
from ..services import monitor_db as db
from ..services import monitor_fetcher as fetcher
from ..services import scheduler as sched
from ..services import qr_login
from ..services import cookie_health
from ..services import ai_rewriter
from ..services import feishu_bitable
from .auth import get_current_user

router = APIRouter(prefix="/monitor", tags=["监控"])


# ── Posts ────────────────────────────────────────────────────────────────────

@router.post("/posts", summary="添加监控帖子")
async def add_posts(
    req: AddPostsRequest,
    background_tasks: BackgroundTasks,
    _: dict = Depends(get_current_user),
):
    results = []
    for raw_link in req.links:
        link = raw_link.strip()
        if not link:
            continue

        # Resolve short link or plain note URL
        if "xhslink.com" in link or "xiaohongshu.com" not in link:
            info = await fetcher.resolve_short_link(link)
        else:
            # Already a full URL — parse it directly
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(link)
            params = parse_qs(parsed.query)
            parts = parsed.path.strip("/").split("/")
            if len(parts) >= 2 and parts[0] == "explore":
                info = {
                    "note_id": parts[1],
                    "xsec_token": params.get("xsec_token", [""])[0],
                    "xsec_source": params.get("xsec_source", ["app_share"])[0],
                    "note_url": link,
                }
            else:
                info = None

        if not info or not info.get("note_id"):
            results.append({"link": link, "ok": False, "reason": "无法解析链接"})
            continue

        note_id = info["note_id"]
        await db.add_post(
            note_id=note_id,
            title="",
            short_url=link,
            note_url=info["note_url"],
            xsec_token=info["xsec_token"],
            xsec_source=info["xsec_source"],
            account_id=req.account_id,
            post_type=req.post_type,
        )
        results.append({"link": link, "ok": True, "note_id": note_id})

    # Immediately do a first snapshot in the background
    background_tasks.add_task(sched.run_monitor)
    return {"results": results}


@router.get("/posts", summary="获取监控列表")
async def list_posts(_: dict = Depends(get_current_user)):
    return {"posts": await db.get_posts()}


@router.delete("/posts/{note_id}", summary="删除监控帖子")
async def delete_post(note_id: str, _: dict = Depends(get_current_user)):
    await db.delete_post(note_id)
    return {"ok": True}


@router.get("/posts/{note_id}/history", summary="帖子历史数据")
async def post_history(
    note_id: str, limit: int = 100, _: dict = Depends(get_current_user)
):
    return {"history": await db.get_post_history(note_id, limit)}


@router.post("/check", summary="立即检测一次")
async def manual_check(
    background_tasks: BackgroundTasks,
    _: dict = Depends(get_current_user),
):
    background_tasks.add_task(sched.run_monitor)
    return {"ok": True, "message": "检测任务已触发"}


# ── Alerts ───────────────────────────────────────────────────────────────────

@router.get("/alerts", summary="告警记录")
async def list_alerts(limit: int = 50, _: dict = Depends(get_current_user)):
    return {"alerts": await db.get_alerts(limit)}


@router.delete("/alerts", summary="清空告警记录")
async def clear_all_alerts(_: dict = Depends(get_current_user)):
    deleted = await db.clear_alerts()
    return {"ok": True, "deleted": deleted}


@router.delete("/alerts/{alert_id}", summary="删除单条告警")
async def remove_alert(alert_id: int, _: dict = Depends(get_current_user)):
    await db.delete_alert(alert_id)
    return {"ok": True}


# ── Accounts ─────────────────────────────────────────────────────────────────

@router.get("/accounts", summary="账号列表")
async def list_accounts(_: dict = Depends(get_current_user)):
    return {"accounts": await db.get_accounts()}


@router.post("/accounts", summary="添加账号")
async def add_account(req: AddAccountRequest, _: dict = Depends(get_current_user)):
    aid = await db.add_account(
        name=req.name,
        cookie=req.cookie,
        proxy_url=req.proxy_url or "",
        user_agent=req.user_agent or "",
        viewport=req.viewport or "",
        timezone=req.timezone or "Asia/Shanghai",
        locale=req.locale or "zh-CN",
        fp_browser_type=req.fp_browser_type or "builtin",
        fp_profile_id=req.fp_profile_id or "",
        fp_api_url=req.fp_api_url or "",
    )
    return {"ok": True, "id": aid}


@router.patch("/accounts/{account_id}", summary="更新账号")
async def update_account(
    account_id: int,
    req: UpdateAccountRequest,
    _: dict = Depends(get_current_user),
):
    changed = await db.update_account(account_id, **req.model_dump(exclude_none=True))
    if not changed:
        raise HTTPException(status_code=400, detail="no fields to update")
    return {"ok": True}


@router.delete("/accounts/{account_id}", summary="删除账号")
async def delete_account(account_id: int, _: dict = Depends(get_current_user)):
    await db.delete_account(account_id)
    return {"ok": True}


@router.post("/accounts/{account_id}/check-cookie", summary="检查账号 Cookie 状态")
async def check_account_cookie(account_id: int, _: dict = Depends(get_current_user)):
    acc = await db.get_account(account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="账号不存在")
    status = await cookie_health.check_cookie(acc)
    await db.update_cookie_status(account_id, status)
    return {"ok": True, "status": status}


@router.post("/accounts/check-cookies", summary="检查全部账号 Cookie")
async def check_all_cookies(
    background_tasks: BackgroundTasks,
    _: dict = Depends(get_current_user),
):
    background_tasks.add_task(sched.run_cookie_health_check)
    return {"ok": True, "message": "已触发全量检查，结果稍后会更新"}


# ── QR Login ────────────────────────────────────────────────────────────────

@router.post("/accounts/qr-login/start", summary="启动扫码登录")
async def qr_login_start(
    req: QRLoginStartRequest,
    _: dict = Depends(get_current_user),
):
    try:
        data = await qr_login.start_session(req.model_dump())
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return data


@router.get("/accounts/qr-login/{session_id}", summary="查询扫码登录状态")
async def qr_login_status(session_id: str, _: dict = Depends(get_current_user)):
    info = qr_login.get_status(session_id)
    if not info:
        raise HTTPException(status_code=404, detail="session not found or expired")
    return info


@router.post("/accounts/qr-login/{session_id}/cancel", summary="取消扫码登录")
async def qr_login_cancel(session_id: str, _: dict = Depends(get_current_user)):
    ok = await qr_login.cancel_session(session_id)
    return {"ok": ok}


# ── Settings ─────────────────────────────────────────────────────────────────

@router.get("/settings", summary="获取设置")
async def get_settings(_: dict = Depends(get_current_user)):
    return await db.get_all_settings()


@router.put("/settings", summary="更新设置")
async def update_settings(
    req: UpdateSettingsRequest, _: dict = Depends(get_current_user)
):
    bool_val = lambda v: "1" if v else "0"

    simple_fields = [
        "webhook_url", "feishu_webhook_url", "daily_report_time",
        "ai_base_url", "ai_api_key", "ai_model", "ai_rewrite_prompt",
        "feishu_app_id", "feishu_app_secret",
        "feishu_bitable_app_token", "feishu_bitable_table_id",
        "trending_keywords", "trending_account_ids",

    ]
    for key in simple_fields:
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, val)

    bool_fields = [
        "daily_report_enabled", "likes_alert_enabled", "collects_alert_enabled",
        "comments_alert_enabled", "ai_rewrite_enabled", "trending_enabled",
        "comments_fetch_enabled",
        "observe_use_cookie_fallback",
    ]
    for key in bool_fields:
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, bool_val(val))

    int_fields = [
        "likes_threshold", "collects_threshold", "comments_threshold", "trending_min_likes",
    ]
    for key in int_fields:
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, str(val))

    if req.check_interval_minutes is not None:
        await db.set_setting("check_interval_minutes", str(req.check_interval_minutes))
        settings = await db.get_all_settings()
        sched.reschedule(req.check_interval_minutes, settings.get("daily_report_time", "09:00"))

    return {"ok": True}


# ── Trending ──────────────────────────────────────────────────────────────────

@router.get("/trending", summary="热门内容列表")
async def list_trending(limit: int = 50, _: dict = Depends(get_current_user)):
    return {"posts": await db.get_trending_posts(limit)}


@router.post("/trending/check", summary="立即触发热门抓取")
async def manual_trending_check(
    background_tasks: BackgroundTasks,
    _: dict = Depends(get_current_user),
):
    background_tasks.add_task(sched.run_trending_monitor)
    return {"ok": True, "message": "热门抓取任务已触发"}


# ── Rewrite Prompts (manage saved prompt templates) ──────────────────────────

@router.get("/prompts", summary="改写 prompt 列表")
async def list_prompts(_: dict = Depends(get_current_user)):
    return {"prompts": await db.list_prompts()}


@router.post("/prompts", summary="新建 prompt")
async def create_prompt(req: CreatePromptRequest, _: dict = Depends(get_current_user)):
    if not req.name.strip() or not req.content.strip():
        raise HTTPException(status_code=400, detail="name and content are required")
    pid = await db.create_prompt(req.name.strip(), req.content)
    return {"ok": True, "id": pid}


@router.patch("/prompts/{prompt_id}", summary="更新 prompt")
async def update_prompt_route(prompt_id: int, req: UpdatePromptRequest, _: dict = Depends(get_current_user)):
    await db.update_prompt(prompt_id, name=req.name, content=req.content)
    return {"ok": True}


@router.delete("/prompts/{prompt_id}", summary="删除 prompt")
async def delete_prompt_route(prompt_id: int, _: dict = Depends(get_current_user)):
    await db.delete_prompt(prompt_id)
    return {"ok": True}


@router.post("/prompts/{prompt_id}/set-default", summary="设为默认 prompt")
async def set_default_prompt_route(prompt_id: int, _: dict = Depends(get_current_user)):
    await db.set_default_prompt(prompt_id)
    return {"ok": True}


# ── Manual rewrite + Bitable sync ────────────────────────────────────────────

@router.post("/trending/posts/{note_id}/rewrite", summary="改写指定热门帖子")
async def rewrite_trending_post(
    note_id: str,
    req: RewriteTrendingRequest,
    _: dict = Depends(get_current_user),
):
    post = await db.get_trending_post(note_id)
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在")

    text = (post.get("desc_text") or post.get("title") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="该帖子没有文本可改写（标题和正文都为空）")

    # Resolve prompt: explicit text > saved prompt id > default
    prompt_template = None
    if req.prompt_text and req.prompt_text.strip():
        prompt_template = req.prompt_text
    elif req.prompt_id is not None:
        p = await db.get_prompt(req.prompt_id)
        if not p:
            raise HTTPException(status_code=404, detail="prompt 不存在")
        prompt_template = p["content"]
    else:
        p = await db.get_default_prompt()
        if not p:
            raise HTTPException(status_code=400, detail="没有任何可用 prompt，请先在「Prompt 管理」创建一个")
        prompt_template = p["content"]

    settings = await db.get_all_settings()
    ai_base_url = settings.get("ai_base_url", "")
    ai_api_key  = settings.get("ai_api_key", "")
    ai_model    = settings.get("ai_model", "gpt-4o-mini")
    if not ai_api_key:
        raise HTTPException(status_code=400, detail="未配置 AI API Key")

    try:
        rewritten = await ai_rewriter.rewrite_content(
            ai_base_url, ai_api_key, ai_model, prompt_template, text
        )
    except Exception as e:
        await db.update_trending_rewrite(note_id, "", "failed")
        raise HTTPException(status_code=500, detail=f"AI 改写失败: {e}")

    await db.update_trending_rewrite(note_id, rewritten, "done")
    return {"ok": True, "rewritten": rewritten}


@router.post("/trending/sync-bitable", summary="把选中的热门帖子同步到飞书多维表格")
async def sync_trending_to_bitable(
    req: SyncBitableRequest,
    _: dict = Depends(get_current_user),
):
    if not req.note_ids:
        raise HTTPException(status_code=400, detail="未选中任何帖子")

    settings = await db.get_all_settings()
    bitable_app_id     = settings.get("feishu_app_id", "")
    bitable_app_secret = settings.get("feishu_app_secret", "")
    bitable_app_token  = settings.get("feishu_bitable_app_token", "")
    bitable_table_id   = settings.get("feishu_bitable_table_id", "")
    if not all([bitable_app_id, bitable_app_secret, bitable_app_token, bitable_table_id]):
        raise HTTPException(status_code=400, detail="飞书多维表格未配置完整")

    # First make sure all required columns exist in the target Bitable. Any
    # missing field is created automatically with the right type.
    try:
        await feishu_bitable.ensure_fields(
            bitable_app_id, bitable_app_secret, bitable_app_token, bitable_table_id,
            fields={
                "关键词": "text",  "标题": "text",  "原文": "text",  "改写文案": "text",
                "点赞数": "number", "收藏数": "number",
                "帖子链接": "url",  "作者": "text",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"准备表格字段失败: {e}")

    results = []
    for nid in req.note_ids:
        p = await db.get_trending_post(nid)
        if not p:
            results.append({"note_id": nid, "ok": False, "reason": "帖子不存在"})
            continue
        text = (p.get("desc_text") or p.get("title") or "").strip()
        rewritten = (p.get("rewritten_text") or "").strip()
        # Skip posts whose title is empty — older rows captured before the field
        # path was fixed end up with title='' and would write a blank row.
        if not (p.get("title") or "").strip():
            results.append({"note_id": nid, "ok": False, "reason": "标题为空（旧数据），已跳过"})
            continue
        try:
            note_url = p.get("note_url", "")
            await feishu_bitable.add_record(
                bitable_app_id, bitable_app_secret,
                bitable_app_token, bitable_table_id,
                fields={
                    "关键词": p.get("keyword", ""),
                    "标题": p.get("title", ""),
                    "原文": text,
                    "改写文案": rewritten,
                    "点赞数": p.get("liked_count", 0),
                    "收藏数": p.get("collected_count", 0),
                    # Feishu URL field expects {"link": "...", "text": "..."}
                    "帖子链接": {"link": note_url, "text": note_url} if note_url else "",
                    "作者": p.get("author", ""),
                },
            )
            await db.mark_trending_synced(nid)
            results.append({"note_id": nid, "ok": True})
        except Exception as e:
            results.append({"note_id": nid, "ok": False, "reason": str(e)})
    return {"results": results}


