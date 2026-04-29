from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks

from ..schemas.monitor import (
    AddPostsRequest,
    UpdatePostRequest,
    AddAccountRequest,
    UpdateAccountRequest,
    UpdateSettingsRequest,
    QRLoginStartRequest,
    CreatePromptRequest,
    UpdatePromptRequest,
    RewriteTrendingRequest,
    SyncBitableRequest,
    CreateGroupRequest,
    UpdateGroupRequest,
)
from ..services import monitor_db as db
from ..services import monitor_fetcher as fetcher
from ..services import scheduler as sched
from ..services import qr_login
from ..services import cookie_health
from ..services import ai_rewriter
from ..services import feishu_bitable
from ..services import proxy_forwarder
from ..services import platforms as platform_registry
from ..services.account_browser import validate_proxy_url
from .auth import get_current_user

router = APIRouter(prefix="/monitor", tags=["监控"])


def _scope_uid(current_user: dict) -> Optional[int]:
    """所有用户（含 admin）在业务页面只看自己的数据。

    admin 想看全平台数据要去 /dashboard/admin，那里有专门的 admin 接口
    （/auth/admin/users、/monitor/proxy-forwarders 等），不走 _scope_uid。
    这样 admin 就是平台超管，但他/她在监控/告警等业务页面只是普通租户。
    """
    return current_user["id"]


# ── Posts ────────────────────────────────────────────────────────────────────

@router.post("/posts", summary="添加监控帖子")
async def add_posts(
    req: AddPostsRequest,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    results = []
    for raw_link in req.links:
        link = raw_link.strip()
        if not link:
            continue

        # 自动识别平台
        plat = platform_registry.detect_platform(link)
        if not plat:
            results.append({
                "link": link, "ok": False,
                "reason": "无法识别平台（目前支持小红书；抖音/公众号开发中）",
            })
            continue

        info = await plat.resolve_url(link)
        if not info or not info.get("post_id"):
            results.append({"link": link, "ok": False, "reason": "无法解析链接"})
            continue

        await db.add_post(
            note_id=info["post_id"],
            title="",
            short_url=link,
            note_url=info["url"],
            xsec_token=info.get("xsec_token", ""),
            xsec_source=info.get("xsec_source", "app_share"),
            account_id=req.account_id,
            post_type=req.post_type,
            group_id=req.group_id,
            user_id=current_user["id"],
            platform=plat.name,
        )
        results.append({
            "link": link, "ok": True,
            "note_id": info["post_id"], "platform": plat.name,
        })

    # Immediately do a first snapshot in the background
    background_tasks.add_task(sched.run_monitor)
    return {"results": results}


@router.get("/posts", summary="获取监控列表")
async def list_posts(
    platform: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    return {"posts": await db.get_posts(
        user_id=_scope_uid(current_user), platform=platform,
    )}


@router.delete("/posts/{note_id}", summary="删除监控帖子")
async def delete_post(note_id: str, current_user: dict = Depends(get_current_user)):
    await db.delete_post(note_id, user_id=_scope_uid(current_user))
    return {"ok": True}


@router.post("/posts/cleanup-dead", summary="批量清理失效帖子")
async def cleanup_dead_posts(current_user: dict = Depends(get_current_user)):
    """连续抓取失败 ≥ 阈值次数的帖子，批量设为非激活状态。"""
    n = await db.cleanup_dead_posts(user_id=_scope_uid(current_user))
    return {"ok": True, "cleaned": n}


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


@router.post("/trending/check", summary="立即触发热门搜索（admin only，调试用）")
async def manual_trending(
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    background_tasks.add_task(sched.run_trending_monitor)
    return {"ok": True, "message": "trending 任务已触发"}


@router.post("/daily-report/check", summary="立即触发日报推送（admin only，调试用）")
async def manual_daily_report(
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    background_tasks.add_task(sched.run_daily_report)
    return {"ok": True, "message": "日报任务已触发"}


@router.get("/proxy-forwarders", summary="查看本地代理转发状态（admin only）")
async def proxy_forwarder_status(current_user: dict = Depends(get_current_user)):
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return proxy_forwarder.status_dump()


# ── Alerts ───────────────────────────────────────────────────────────────────

@router.get("/alerts", summary="告警记录")
async def list_alerts(limit: int = 50, current_user: dict = Depends(get_current_user)):
    return {"alerts": await db.get_alerts(limit, user_id=_scope_uid(current_user))}


@router.delete("/alerts", summary="清空告警记录")
async def clear_all_alerts(current_user: dict = Depends(get_current_user)):
    deleted = await db.clear_alerts(user_id=_scope_uid(current_user))
    return {"ok": True, "deleted": deleted}


@router.delete("/alerts/{alert_id}", summary="删除单条告警")
async def remove_alert(alert_id: int, current_user: dict = Depends(get_current_user)):
    await db.delete_alert(alert_id, user_id=_scope_uid(current_user))
    return {"ok": True}


# ── Accounts ─────────────────────────────────────────────────────────────────

@router.get("/accounts", summary="账号列表")
async def list_accounts(
    all: bool = False,
    current_user: dict = Depends(get_current_user),
):
    """普通用户：自己 + 共享池。admin + ?all=true：全平台所有账号（用于 /dashboard/admin）。"""
    is_admin = (current_user.get("role") or "user") == "admin"
    user_id = None if (is_admin and all) else current_user["id"]
    return {"accounts": await db.get_accounts(user_id=user_id)}


@router.post("/accounts", summary="添加账号")
async def add_account(req: AddAccountRequest, current_user: dict = Depends(get_current_user)):
    is_admin = (current_user.get("role") or "user") == "admin"
    # 只有 admin 才能把账号标记为共享池资源
    is_shared = bool(req.is_shared) and is_admin

    # 代理校验：拒绝实际不会生效的 SOCKS5 鉴权代理等
    err = validate_proxy_url(req.proxy_url or "")
    if err:
        raise HTTPException(status_code=400, detail=err)
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
        user_id=current_user["id"],
        is_shared=is_shared,
    )
    # 如果代理是 socks5+鉴权，启动本地转发
    if proxy_forwarder.needs_forwarder(req.proxy_url or ""):
        acc = await db.get_account(aid)
        if acc:
            await proxy_forwarder.ensure_forwarder(acc)
    return {"ok": True, "id": aid}


@router.patch("/accounts/{account_id}", summary="更新账号")
async def update_account(
    account_id: int,
    req: UpdateAccountRequest,
    current_user: dict = Depends(get_current_user),
):
    fields = req.model_dump(exclude_none=True)
    # is_shared 仅 admin 可改，普通用户的请求会静默丢弃这个字段
    if (current_user.get("role") or "user") != "admin":
        fields.pop("is_shared", None)
    # 代理校验
    if "proxy_url" in fields:
        err = validate_proxy_url(fields["proxy_url"] or "")
        if err:
            raise HTTPException(status_code=400, detail=err)
    changed = await db.update_account(account_id, **fields)
    if not changed:
        raise HTTPException(status_code=400, detail="no fields to update")
    # 代理变化时同步本地转发
    if "proxy_url" in fields:
        new_proxy = fields.get("proxy_url") or ""
        if proxy_forwarder.needs_forwarder(new_proxy):
            acc = await db.get_account(account_id)
            if acc:
                await proxy_forwarder.ensure_forwarder(acc)
        else:
            await proxy_forwarder.drop_forwarder(account_id)
    return {"ok": True}


@router.delete("/accounts/{account_id}", summary="删除账号")
async def delete_account(account_id: int, current_user: dict = Depends(get_current_user)):
    await db.delete_account(account_id, user_id=_scope_uid(current_user))
    await proxy_forwarder.drop_forwarder(account_id)
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

# 仅 admin 可见或可改的全局配置：AI 模型/Key、飞书应用密钥、共享池调度时间等。
# 普通用户拿到的 settings 会把这些字段抹掉，前端也不会显示。
_ADMIN_ONLY_SETTING_KEYS = {
    "ai_base_url", "ai_api_key", "ai_model", "ai_rewrite_prompt",
    "feishu_app_id", "feishu_app_secret",
    "check_interval_minutes", "daily_report_time", "daily_report_enabled",
    "trending_account_ids",
}


@router.get("/settings", summary="获取设置")
async def get_settings(current_user: dict = Depends(get_current_user)):
    all_settings = await db.get_all_settings()
    if (current_user.get("role") or "user") == "admin":
        return all_settings
    # 普通用户：屏蔽全局配置字段，但保留 ai_rewrite_enabled（用户自己的开关）
    return {k: v for k, v in all_settings.items() if k not in _ADMIN_ONLY_SETTING_KEYS}


@router.put("/settings", summary="更新设置")
async def update_settings(
    req: UpdateSettingsRequest,
    current_user: dict = Depends(get_current_user),
):
    is_admin = (current_user.get("role") or "user") == "admin"
    bool_val = lambda v: "1" if v else "0"

    simple_fields = [
        "webhook_url", "feishu_webhook_url", "daily_report_time",
        "ai_base_url", "ai_api_key", "ai_model", "ai_rewrite_prompt",
        "feishu_app_id", "feishu_app_secret",
        "feishu_bitable_app_token", "feishu_bitable_table_id",
        "trending_keywords", "trending_account_ids",
    ]
    for key in simple_fields:
        if key in _ADMIN_ONLY_SETTING_KEYS and not is_admin:
            continue
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, val)

    bool_fields = [
        "daily_report_enabled", "likes_alert_enabled", "collects_alert_enabled",
        "comments_alert_enabled", "ai_rewrite_enabled", "trending_enabled",
        "comments_fetch_enabled",
    ]
    for key in bool_fields:
        if key in _ADMIN_ONLY_SETTING_KEYS and not is_admin:
            continue
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, bool_val(val))

    int_fields = [
        "likes_threshold", "collects_threshold", "comments_threshold", "trending_min_likes",
    ]
    for key in int_fields:
        if key in _ADMIN_ONLY_SETTING_KEYS and not is_admin:
            continue
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, str(val))

    if req.check_interval_minutes is not None and is_admin:
        await db.set_setting("check_interval_minutes", str(req.check_interval_minutes))
        settings = await db.get_all_settings()
        sched.reschedule(req.check_interval_minutes, settings.get("daily_report_time", "09:00"))

    return {"ok": True}


# ── Monitor Groups ───────────────────────────────────────────────────────────

@router.get("/groups", summary="监控分组列表")
async def list_groups(current_user: dict = Depends(get_current_user)):
    return {"groups": await db.list_groups(user_id=_scope_uid(current_user))}


@router.post("/groups", summary="新建分组")
async def create_group(req: CreateGroupRequest, current_user: dict = Depends(get_current_user)):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="分组名不能为空")
    try:
        gid = await db.create_group(name, user_id=current_user["id"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"创建失败：{e}")
    return {"ok": True, "id": gid}


@router.patch("/groups/{group_id}", summary="更新分组")
async def update_group(
    group_id: int, req: UpdateGroupRequest, _: dict = Depends(get_current_user)
):
    payload = req.model_dump(exclude_none=True)
    # 把 bool 转成 0/1 存数据库
    for k in ("likes_alert_enabled", "collects_alert_enabled", "comments_alert_enabled"):
        if k in payload and isinstance(payload[k], bool):
            payload[k] = 1 if payload[k] else 0
    await db.update_group(group_id, **payload)
    return {"ok": True}


@router.delete("/groups/{group_id}", summary="删除分组")
async def delete_group(
    group_id: int,
    fallback: Optional[int] = None,
    _: dict = Depends(get_current_user),
):
    try:
        await db.delete_group(group_id, fallback_group_id=fallback)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@router.patch("/posts/{note_id}/group", summary="修改帖子的分组")
async def update_post_group(
    note_id: str, req: UpdatePostRequest, current_user: dict = Depends(get_current_user)
):
    await db.update_post_group(note_id, req.group_id, user_id=_scope_uid(current_user))
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
async def list_prompts(current_user: dict = Depends(get_current_user)):
    return {"prompts": await db.list_prompts(user_id=_scope_uid(current_user))}


@router.post("/prompts", summary="新建 prompt")
async def create_prompt(req: CreatePromptRequest, current_user: dict = Depends(get_current_user)):
    if not req.name.strip() or not req.content.strip():
        raise HTTPException(status_code=400, detail="name and content are required")
    pid = await db.create_prompt(req.name.strip(), req.content, user_id=current_user["id"])
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

@router.post("/trending/backfill-media", summary="批量补全所有热门帖子的封面/图集/视频")
async def backfill_trending_media(
    background_tasks: BackgroundTasks,
    only_missing: bool = True,
    _: dict = Depends(get_current_user),
):
    """对所有 trending_posts 批量调用 detail page 抓图。后台跑。"""
    async def _job():
        import json as _json
        import asyncio
        # Pick the first usable account once.
        account = None
        for acc in await db.get_accounts(include_secrets=True):
            if acc.get("is_active") and acc.get("cookie") and acc.get("cookie_status") != "expired":
                account = acc
                break
        all_posts = await db.get_trending_posts(limit=500)
        if only_missing:
            targets = [p for p in all_posts if not (p.get("cover_url") or p.get("images"))]
        else:
            targets = all_posts
        sem = __import__("asyncio").Semaphore(3)
        ok_count = 0
        fail_count = 0

        async def _one(p):
            nonlocal ok_count, fail_count
            async with sem:
                try:
                    metrics, status = await fetcher.fetch_note_metrics(
                        p["note_id"], p.get("xsec_token", ""), "pc_search", account=account,
                    )
                    if metrics:
                        await db.update_trending_media(
                            p["note_id"],
                            cover_url=metrics.get("cover_url") or "",
                            images_json=_json.dumps(metrics.get("images") or [], ensure_ascii=False) if metrics.get("images") else "",
                            video_url=metrics.get("video_url") or "",
                            note_type=metrics.get("note_type") or "",
                        )
                        if metrics.get("desc") and not p.get("desc_text"):
                            await db.update_trending_desc(p["note_id"], metrics["desc"])
                        ok_count += 1
                    else:
                        fail_count += 1
                except Exception:
                    fail_count += 1
                await asyncio.sleep(0.6)

        await asyncio.gather(*[_one(p) for p in targets])

    background_tasks.add_task(_job)
    return {"ok": True, "message": "批量补全任务已触发，请稍后刷新页面查看结果"}


@router.post("/trending/posts/{note_id}/fetch-content", summary="抓取热门帖子的正文")
async def fetch_trending_content(
    note_id: str,
    _: dict = Depends(get_current_user),
):
    """The XHS search API only returns titles. Hit the note detail page to grab
    the real body text and backfill `desc_text`. Costs one extra request per call,
    so it's exposed as an explicit user action (not run on every trending fetch)."""
    post = await db.get_trending_post(note_id)
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在")

    # Try with the first usable account's cookie (note pages are now mostly
    # login-walled). Fall back to anonymous if no usable account.
    account = None
    for acc in await db.get_accounts(include_secrets=True):
        if acc.get("is_active") and acc.get("cookie") and acc.get("cookie_status") != "expired":
            account = acc
            break

    metrics, status = await fetcher.fetch_note_metrics(
        note_id,
        post.get("xsec_token", ""),
        "pc_search",
        account=account,
    )
    if not metrics:
        if status == "login_required":
            raise HTTPException(
                status_code=400,
                detail="该帖子需要登录才能查看正文，请先添加一个有效账号"
                       if not account else "登录态无效，请检查账号 Cookie 是否过期",
            )
        raise HTTPException(status_code=400, detail=f"抓取失败：{status}")

    desc = metrics.get("desc") or ""
    title = metrics.get("title") or post.get("title") or ""
    images = metrics.get("images") or []
    video_url = metrics.get("video_url") or ""
    cover_url = metrics.get("cover_url") or ""
    note_type = metrics.get("note_type") or "normal"

    if desc:
        await db.update_trending_desc(note_id, desc)
    # Persist media too — they may not have come from search.
    import json as _json
    await db.update_trending_media(
        note_id,
        cover_url=cover_url,
        images_json=_json.dumps(images, ensure_ascii=False) if images else "",
        video_url=video_url,
        note_type=note_type,
    )
    return {
        "ok": True,
        "title": title,
        "desc_text": desc,
        "desc_length": len(desc),
        "cover_url": cover_url,
        "images": images,
        "video_url": video_url,
        "note_type": note_type,
    }


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


