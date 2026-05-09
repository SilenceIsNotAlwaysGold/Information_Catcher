import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from ..schemas.monitor import (
    AddPostsRequest,
    UpdatePostRequest,
    AddAccountRequest,
    CookieSyncRequest,
    UpdateAccountRequest,
    UpdateSettingsRequest,
    QRLoginStartRequest,
    CreatePromptRequest,
    UpdatePromptRequest,
    RewriteTrendingRequest,
    RewriteCrossPlatformRequest,
    LockVariantRequest,
    SyncBitableRequest,
    BatchDeletePostsRequest,
    CreateGroupRequest,
    UpdateGroupRequest,
    AddCreatorRequest,
    AddLiveRequest,
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
    # 强制选分组：避免帖子落入「未分组」无法在普通用户视图分组 tab 中显示
    if req.group_id is None:
        raise HTTPException(status_code=400, detail="必须选择一个分组")

    # 配额检查：按 plan 派生（admin 自动豁免）
    from ..services import quota_service
    n_links = len([l for l in req.links if l.strip()])
    if n_links > 0:
        await quota_service.check_or_raise(current_user, "monitor_posts", delta=n_links)

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
    # admin 看全平台所有用户的帖子；普通用户只看自己的
    is_admin = (current_user.get("role") or "user") == "admin"
    uid = None if is_admin else _scope_uid(current_user)
    posts = await db.get_posts(user_id=uid, platform=platform)
    if is_admin and posts:
        from ..services import auth_service
        user_map = {u["id"]: u.get("username") or u.get("email") or str(u["id"])
                    for u in auth_service.list_users()}
        for p in posts:
            p["owner_username"] = user_map.get(p.get("user_id"), "?")
    return {"posts": posts}


@router.delete("/posts/{note_id}", summary="删除监控帖子")
async def delete_post(
    note_id: str,
    owner_user_id: Optional[int] = None,  # admin 删别人帖子时显式传
    current_user: dict = Depends(get_current_user),
):
    is_admin = (current_user.get("role") or "user") == "admin"
    # 普通用户：只能删自己的（user_id 强制为自己）
    # admin：可删任意人的；如果传了 owner_user_id 则精准命中，未传则按 note_id 删（所有 user_id 下）
    uid = owner_user_id if is_admin else _scope_uid(current_user)
    await db.delete_post(note_id, user_id=uid)
    return {"ok": True}


@router.post("/posts/batch-delete", summary="批量删除监控帖子")
async def batch_delete_posts(
    req: BatchDeletePostsRequest,
    current_user: dict = Depends(get_current_user),
):
    """note_ids 数组按 _scope_uid 规则删除（普通用户只能删自己的，admin 全权）。"""
    if not req.note_ids:
        return {"ok": True, "deleted": 0}
    is_admin = (current_user.get("role") or "user") == "admin"
    uid = None if is_admin else _scope_uid(current_user)
    deleted = 0
    for nid in req.note_ids:
        try:
            await db.delete_post(nid, user_id=uid)
            deleted += 1
        except Exception:
            pass
    return {"ok": True, "deleted": deleted}


@router.get("/posts/{note_id}/video", summary="获取帖子视频直链（抖音支持去水印）")
async def post_video_url(
    note_id: str,
    clean: bool = True,
    current_user: dict = Depends(get_current_user),
):
    """实时 fetch 拿当前视频流 URL。
    - 抖音：clean=true 返回无水印版（playwm → play 替换）
    - 其他平台：返回 video_url 原值
    返回 302 重定向到真实 mp4，前端 <a href> 打开即可下载。
    """
    from fastapi.responses import RedirectResponse
    post = await db.get_post_by_note_id(note_id, user_id=_scope_uid(current_user))
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在")
    plat = platform_registry.get_platform(post.get("platform") or "xhs")
    if not plat:
        raise HTTPException(status_code=400, detail="未知平台")
    metrics, status = await plat.fetch_detail({
        "post_id": note_id, "note_id": note_id, "url": post.get("note_url"),
        "xsec_token": post.get("xsec_token", ""),
        "xsec_source": post.get("xsec_source", "app_share"),
    }, account=None)
    if not metrics:
        raise HTTPException(status_code=502, detail=f"无法抓取：{status}")
    url = (metrics.get("video_url_clean") if clean else "") or metrics.get("video_url") or ""
    if not url:
        raise HTTPException(status_code=404, detail="该帖子无视频流（可能是图集/文章）")
    return RedirectResponse(url=url, status_code=302)


@router.get("/posts/search", summary="全文搜索帖子（标题 + 摘要）")
async def search_posts_endpoint(
    q: str,
    platform: Optional[str] = None,
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
):
    rows = await db.search_posts(
        q=q, user_id=_scope_uid(current_user),
        platform=platform, limit=min(max(limit, 1), 200),
    )
    return {"q": q, "count": len(rows), "results": rows}


@router.post("/posts/cleanup-dead", summary="批量清理失效帖子")
async def cleanup_dead_posts(current_user: dict = Depends(get_current_user)):
    """连续抓取失败 ≥ 阈值次数的帖子，批量设为非激活状态。"""
    n = await db.cleanup_dead_posts(user_id=_scope_uid(current_user))
    return {"ok": True, "cleaned": n}


_DEFAULT_SUMMARY_PROMPT = (
    "你是一位精通中文阅读的助手。请用 200-300 字总结下面这篇文章的核心观点、关键论据和结论，"
    "保留可执行建议或干货金句，去掉客套和软广。直接输出摘要正文，不要分段标题。\n\n"
    "原文：\n{content}"
)

# 跨平台改写：源平台 → 目标平台。key = target，value = prompt 模板
# 内置 fallback：当请求没传 prompt_text / prompt_id 时使用；同时作为 seed 写入 rewrite_prompts。
_CROSS_PLATFORM_PROMPTS = {
    "xhs": (
        "你是一位精通小红书爆款文案的创作者。请把下面这段公众号文章/抖音文案改写为"
        "**一条小红书笔记**，要求：\n"
        "1. 标题 18 字内，带数字 / 钩子句 / 反问，吸引点击\n"
        "2. 正文 200-400 字，分 3-5 段，每段开头加 emoji，关键短语加粗（用 **）\n"
        "3. 结尾给 3-5 个话题标签 #xxx#，与正文相关\n"
        "4. 保留原文核心观点和事实，**去掉营销话术、广告、跳转链接**\n"
        "5. 不要加任何 \"以下是改写\" 之类元语言\n\n"
        "原文：\n{content}"
    ),
    "douyin": (
        "你是一位精通抖音爆款短视频文案的创作者。请把下面这段文章改写为"
        "**一条 30 秒抖音视频的口播脚本**，要求：\n"
        "1. 开头 3 秒抓眼球（数字 / 反差 / 提问）\n"
        "2. 正文按口播节奏分行，每行 15-25 字\n"
        "3. 结尾留钩子（点关注 / 问问题）\n"
        "4. 保留原文核心观点，**去掉书面语**\n\n"
        "原文：\n{content}"
    ),
    "mp": (
        "你是一位精通微信公众号长文写作的编辑。请把下面这段内容改写为"
        "**一篇公众号文章**，要求：\n"
        "1. 标题 20 字内，端庄但有信息量，避免标题党\n"
        "2. 正文 600-1000 字，分 3-5 个小节，每节加二级小标题（用 ## 开头）\n"
        "3. 段落清晰，逻辑层层递进，可适度引用数据 / 案例\n"
        "4. 结尾一段总结升华或行动建议\n"
        "5. 风格沉稳、信息密度高，去掉口水话，不堆砌 emoji\n\n"
        "原文：\n{content}"
    ),
}

# 内置跨平台 prompt 的稳定显示名（seed 进 DB 时用，便于前端识别 / 幂等去重）
_CROSS_PLATFORM_PROMPT_NAMES = {
    "xhs": "[内置] 跨平台改写 · 小红书风",
    "douyin": "[内置] 跨平台改写 · 抖音口播",
    "mp": "[内置] 跨平台改写 · 公众号长文",
}

_cross_platform_seed_done = False


async def _ensure_cross_platform_prompts_seeded() -> None:
    """把 _CROSS_PLATFORM_PROMPTS 三条按 name 幂等 seed 进 rewrite_prompts。

    - user_id=NULL（全局可见，所有租户都能选）
    - 不动 is_default（避免抢占现有用户/系统默认）
    - 进程内只跑一次（_cross_platform_seed_done 缓存）
    """
    global _cross_platform_seed_done
    if _cross_platform_seed_done:
        return
    try:
        existing = await db.list_prompts(user_id=None)
        have_names = {(p.get("name") or "") for p in existing}
        for target, content in _CROSS_PLATFORM_PROMPTS.items():
            name = _CROSS_PLATFORM_PROMPT_NAMES[target]
            if name in have_names:
                continue
            try:
                await db.create_prompt(name, content, user_id=None)
            except Exception:
                pass
    finally:
        _cross_platform_seed_done = True


@router.post(
    "/posts/{note_id}/rewrite-cross-platform",
    summary="跨平台改写（按用户自定义 prompt 或内置 target 模板）",
)
async def cross_platform_rewrite(
    note_id: str,
    req: Optional[RewriteCrossPlatformRequest] = None,
    target: Optional[str] = None,
    variants: Optional[int] = None,
    prompt_id: Optional[int] = None,
    prompt_text: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """把当前帖子的正文改写为另一个平台的风格。

    优先级（从高到低）：
      1. 请求 body / query 里的 `prompt_text`（ad-hoc 文本，必含 {content}）
      2. 请求 body / query 里的 `prompt_id`（用户在 rewrite_prompts 里保存的 prompt）
      3. `target` 对应的内置 _CROSS_PLATFORM_PROMPTS 模板（向后兼容旧调用）

    body 优先于 query；body 缺省时回落 query；query 也没有就用默认。
    流程：实时 fetch_detail 拿正文 → 选 prompt → rewrite_variants 并行生成。
    不持久化结果，返回数组让前端展示供运营选择。
    """
    # 第一次调用时把内置 prompt 模板 seed 进 rewrite_prompts（幂等）
    await _ensure_cross_platform_prompts_seeded()

    # 把 body / query 合并成最终参数（body 优先）
    body_prompt_id = req.prompt_id if req else None
    body_prompt_text = req.prompt_text if req else None
    body_target = req.target if req else None
    body_variants = req.variants if req else None

    final_prompt_text = (body_prompt_text or prompt_text or "").strip() or None
    final_prompt_id = body_prompt_id if body_prompt_id is not None else prompt_id
    final_target = (body_target or target or "xhs").strip().lower() or "xhs"
    final_variants = body_variants if body_variants is not None else variants
    if final_variants is None:
        final_variants = 3

    # 选 prompt 模板
    prompt_template: str
    chosen_label: str  # 用于响应里告诉前端选了哪个
    if final_prompt_text:
        prompt_template = final_prompt_text
        chosen_label = "ad-hoc"
    elif final_prompt_id is not None:
        p = await db.get_prompt(int(final_prompt_id))
        if not p:
            raise HTTPException(status_code=404, detail="prompt 不存在")
        prompt_template = p["content"]
        chosen_label = f"prompt:{p.get('name') or final_prompt_id}"
    else:
        if final_target not in _CROSS_PLATFORM_PROMPTS:
            raise HTTPException(
                status_code=400,
                detail=f"target 必须是 {list(_CROSS_PLATFORM_PROMPTS.keys())} 之一，"
                       f"或改用 prompt_id / prompt_text",
            )
        prompt_template = _CROSS_PLATFORM_PROMPTS[final_target]
        chosen_label = f"builtin:{final_target}"

    # 简单校验 prompt 模板里有 {content} 占位（rewrite_content 内部会 .format）
    if "{content}" not in prompt_template:
        raise HTTPException(
            status_code=400,
            detail="prompt 模板必须包含 {content} 占位符",
        )

    post = await db.get_post_by_note_id(note_id, user_id=_scope_uid(current_user))
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在")

    plat = platform_registry.get_platform(post.get("platform") or "xhs")
    if not plat:
        raise HTTPException(status_code=400, detail="未知平台")

    metrics, status = await plat.fetch_detail({
        "post_id": note_id, "note_id": note_id, "url": post.get("note_url"),
        "xsec_token": post.get("xsec_token", ""),
        "xsec_source": post.get("xsec_source", "app_share"),
    }, account=None)
    if not metrics:
        raise HTTPException(status_code=502, detail=f"无法抓取正文：{status}")

    body = (metrics.get("desc") or "").strip()
    if len(body) < 50:
        raise HTTPException(status_code=400, detail="正文太短，无需改写")

    settings = await db.get_all_settings()
    if not settings.get("ai_api_key"):
        raise HTTPException(status_code=400, detail="平台未配置 AI Key")

    n = max(1, min(int(final_variants or 3), 5))
    try:
        result = await ai_rewriter.rewrite_variants(
            base_url=settings.get("ai_base_url", ""),
            api_key=settings["ai_api_key"],
            model=settings.get("ai_model", "gpt-4o-mini"),
            prompt_template=prompt_template,
            content=body,
            n=n,
        )
        if not result:
            raise RuntimeError("所有变体失败")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 调用失败：{e}")

    return {
        "ok": True,
        "source_platform": post.get("platform"),
        "target_platform": final_target,
        "prompt_used": chosen_label,
        "variants": result,
    }


@router.post("/posts/{note_id}/summarize", summary="为帖子生成 AI 摘要")
async def summarize_post(note_id: str, current_user: dict = Depends(get_current_user)):
    """给一条 active post 生成 AI 摘要。

    流程：
      1. 按 (note_id, user_id) 取 post
      2. 走对应平台的 fetch_detail 拿 desc/正文
      3. 调用全局 AI 配置生成摘要
      4. 写入 monitor_posts.summary
    """
    post = await db.get_post_by_note_id(note_id, user_id=_scope_uid(current_user))
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在或已删除")

    plat = platform_registry.get_platform(post.get("platform") or "xhs")
    if not plat:
        raise HTTPException(status_code=400, detail=f"未知平台：{post.get('platform')}")

    # 实时拉详情拿正文（avoid 加 body 列）
    detail_post = {
        "post_id": note_id, "note_id": note_id,
        "url": post.get("note_url"),
        "xsec_token": post.get("xsec_token", ""),
        "xsec_source": post.get("xsec_source", "app_share"),
    }
    metrics, status = await plat.fetch_detail(detail_post, account=None)
    if not metrics:
        raise HTTPException(status_code=502, detail=f"无法抓取正文：{status}")

    body = (metrics.get("desc") or "").strip()
    if len(body) < 50:
        raise HTTPException(status_code=400, detail="正文太短，无需摘要")

    settings = await db.get_all_settings()
    base_url = settings.get("ai_base_url", "")
    api_key = settings.get("ai_api_key", "")
    model = settings.get("ai_model", "gpt-4o-mini")
    if not api_key:
        raise HTTPException(status_code=400, detail="平台未配置 AI Key（需要 admin 在后台设置）")

    try:
        summary = await ai_rewriter.rewrite_content(
            base_url=base_url, api_key=api_key, model=model,
            prompt_template=_DEFAULT_SUMMARY_PROMPT, content=body,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI 调用失败：{e}")

    await db.save_post_summary(note_id, summary, user_id=_scope_uid(current_user))
    return {"ok": True, "summary": summary, "fetch_status": status}


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



@router.post("/own-comments/check", summary="立即触发评论拉取（admin only，调试用）")
async def manual_own_comments(
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    background_tasks.add_task(sched.run_own_comments_check)
    return {"ok": True, "message": "评论拉取任务已触发"}


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


# ── Creators / 博主订阅追新 ─────────────────────────────────────────────────

@router.get("/creators", summary="订阅博主列表")
async def list_creators(current_user: dict = Depends(get_current_user)):
    return {"creators": await db.list_creators(user_id=_scope_uid(current_user))}


@router.post("/creators", summary="添加订阅博主")
async def add_creator(
    req: AddCreatorRequest,
    current_user: dict = Depends(get_current_user),
):
    plat = platform_registry.detect_platform(req.creator_url)
    if not plat and req.platform:
        plat = platform_registry.get_platform(req.platform)
    if not plat:
        raise HTTPException(
            status_code=400,
            detail="无法识别平台。请提供博主主页 URL（小红书/抖音）或公众号名称（公众号请明确指定 platform=mp）",
        )

    # 规范化 URL：
    #   1. 标准博主主页 URL（含 /user/profile/{uid}）→ **原样保留**，包括 xsec_token
    #      query 参数。扩展打开 tab 时 SPA 需要 xsec_token 才会发 user_posted。
    #   2. 短链（xhslink.com）→ follow redirect 提取 user_id（短链落地页通常带 token）
    creator_url = req.creator_url.strip()
    if plat.name == "xhs":
        import re
        if "/user/profile/" in creator_url:
            # 标准 URL，直接保留原始（含 xsec_token）
            if not re.search(r"/user/profile/[a-zA-Z0-9]{20,}", creator_url):
                raise HTTPException(
                    status_code=400,
                    detail="博主 URL 格式不正确，应包含 /user/profile/<24位 user_id>",
                )
        else:
            # 短链：尝试 resolve
            from ..services.monitor_fetcher import resolve_xhs_creator_url
            resolved = await resolve_xhs_creator_url(creator_url)
            if not resolved:
                raise HTTPException(
                    status_code=400,
                    detail="无法解析小红书博主 URL。请直接从浏览器地址栏复制博主主页 "
                           "URL（含 /user/profile/ 和 xsec_token），或粘贴 https://xhslink.com/o/... 短链。",
                )
            creator_url = resolved

    cid = await db.add_creator(
        user_id=current_user["id"],
        platform=plat.name,
        creator_url=creator_url,
        creator_name=req.creator_name or "",
    )
    return {"ok": True, "id": cid, "platform": plat.name, "creator_url": creator_url}


@router.delete("/creators/{creator_id}", summary="取消订阅")
async def delete_creator(
    creator_id: int,
    current_user: dict = Depends(get_current_user),
):
    await db.delete_creator(creator_id, user_id=_scope_uid(current_user))
    return {"ok": True}


class CreatorSettingsRequest(BaseModel):
    push_enabled: Optional[bool] = None
    fetch_interval_minutes: Optional[int] = None


@router.put("/creators/{creator_id}/settings", summary="更新博主追新设置（推送开关 / 抓取频率）")
async def update_creator_settings_route(
    creator_id: int,
    body: CreatorSettingsRequest,
    current_user: dict = Depends(get_current_user),
):
    if body.fetch_interval_minutes is not None and body.fetch_interval_minutes < 5:
        raise HTTPException(status_code=400, detail="抓取频率最低 5 分钟")
    ok = await db.update_creator_settings(
        creator_id, user_id=int(current_user["id"]),
        push_enabled=body.push_enabled,
        fetch_interval_minutes=body.fetch_interval_minutes,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="博主不存在或无权操作")
    return {"ok": True}


@router.post("/creators/{creator_id}/check", summary="立刻抓取博主新发帖（手动触发，走扩展通道）")
async def check_creator(
    creator_id: int,
    current_user: dict = Depends(get_current_user),
):
    """通过浏览器扩展立刻抓取该博主主页，新帖入「我的关注」分组。

    前提：用户已安装并连接 TrendPulse Helper 扩展，且浏览器已登录对应平台。
    """
    from ..services import extension_dispatcher

    user_id = int(current_user["id"])
    creators = await db.list_creators(user_id=_scope_uid(current_user))
    creator = next((c for c in creators if c["id"] == creator_id), None)
    if not creator:
        raise HTTPException(status_code=404, detail="博主不存在")

    platform_name = creator["platform"] or "xhs"
    if platform_name not in ("xhs", "douyin"):
        raise HTTPException(
            status_code=400,
            detail=f"暂不支持 {platform_name} 平台的博主追新",
        )

    if not extension_dispatcher.has_online_extension(user_id):
        raise HTTPException(
            status_code=503,
            detail="未检测到在线浏览器扩展。请先安装 TrendPulse Helper 扩展，并在浏览器登录目标平台。",
        )

    # 通过扩展派发任务
    if platform_name == "xhs":
        res = await extension_dispatcher.dispatch_xhs_creator_posts(
            user_id=user_id, url=creator["creator_url"],
            timeout_ms=25000, overall_timeout=60.0,
        )
    else:
        res = await extension_dispatcher.dispatch_douyin_creator_posts(
            user_id=user_id, url=creator["creator_url"],
            timeout_ms=25000, overall_timeout=60.0,
        )

    if not res.get("ok"):
        # error 是稳定 code（captcha_required / login_required / ...），
        # detail 是已翻译的中文提示。落库存原始 code 方便筛查，前端用 detail。
        raw = (res.get("error") or "")[:200]
        msg = res.get("detail") or raw or "扩展返回空结果"
        # 风控类错误归类为 cookie_invalid，正常 error 归 error
        status = "cookie_invalid" if raw in ("captcha_required", "login_required") else "error"
        await db.mark_creator_status(creator_id, status, raw or "扩展返回失败")
        raise HTTPException(status_code=502, detail=msg)

    posts = res.get("posts") or []
    last_post_id = creator.get("last_post_id") or ""

    # 抓 0 帖 + 已经追过：可能用户没在该浏览器登录该平台
    if not posts and last_post_id:
        await db.mark_creator_status(
            creator_id, "ext_login_required",
            "扩展已连接但抓取返回 0 帖，请确认浏览器已登录该平台",
        )
        return {
            "ok": True, "fetched": 0, "added": 0,
            "warning": f"本次未拿到帖子。请确认浏览器已登录{('小红书' if platform_name == 'xhs' else '抖音')}。",
        }

    # 入库 + 计 unread
    new_count = 0
    newest = last_post_id
    for p in posts:
        pid = p.get("post_id")
        if not pid:
            continue
        if pid == last_post_id:
            break
        await db.add_post(
            note_id=pid, title=p.get("title") or "",
            short_url=p.get("url") or "", note_url=p.get("url") or "",
            xsec_token=p.get("xsec_token", ""), xsec_source="app_share",
            account_id=None, post_type="own",
            user_id=user_id,
            platform=platform_name,
        )
        new_count += 1
        if not newest:
            newest = pid

    await db.update_creator_check(
        creator_id, last_post_id=newest,
        creator_name=(posts[0].get("creator_name", "") if posts else ""),
    )
    await db.mark_creator_status(creator_id, "ok")
    if new_count:
        await db.add_creator_unread(creator_id, new_count)
    return {"ok": True, "fetched": len(posts), "added": new_count}


class _SeenReq(BaseModel):
    creator_ids: Optional[list[int]] = None  # 不给 = 全部已读


@router.post("/creators/seen", summary="标记博主已读（清未读计数）")
async def mark_creators_seen(
    req: _SeenReq,
    current_user: dict = Depends(get_current_user),
):
    """前端进入博主追新页面时调用，把展示的博主未读清零。"""
    affected = await db.mark_creators_seen(
        user_id=current_user["id"], creator_ids=req.creator_ids,
    )
    return {"ok": True, "affected": affected}


# ── Lives / 直播间监控 v1 ───────────────────────────────────────────────────

@router.get("/lives", summary="直播订阅列表")
async def list_lives(current_user: dict = Depends(get_current_user)):
    return {"lives": await db.list_lives(user_id=_scope_uid(current_user))}


@router.post("/lives", summary="添加直播订阅")
async def add_live(
    req: AddLiveRequest,
    current_user: dict = Depends(get_current_user),
):
    if "live.douyin.com" not in (req.room_url or ""):
        raise HTTPException(status_code=400, detail="目前只支持抖音直播 URL（live.douyin.com/{room_id}）")
    lid = await db.add_live(
        user_id=current_user["id"],
        platform=req.platform or "douyin",
        room_url=req.room_url.strip(),
        streamer_name=req.streamer_name or "",
        online_alert_threshold=req.online_alert_threshold or 0,
    )
    return {"ok": True, "id": lid}


@router.delete("/lives/{live_id}", summary="取消直播订阅")
async def delete_live(
    live_id: int,
    current_user: dict = Depends(get_current_user),
):
    await db.delete_live(live_id, user_id=_scope_uid(current_user))
    return {"ok": True}


@router.post("/lives/{live_id}/check", summary="立刻拉取直播间状态")
async def check_live(
    live_id: int,
    current_user: dict = Depends(get_current_user),
):
    from ..services import extension_dispatcher
    user_id = int(current_user["id"])
    lives = await db.list_lives(user_id=_scope_uid(current_user))
    live = next((l for l in lives if l["id"] == live_id), None)
    if not live:
        raise HTTPException(status_code=404, detail="直播订阅不存在")
    if not extension_dispatcher.has_online_extension(user_id):
        raise HTTPException(
            status_code=503,
            detail="未检测到在线浏览器扩展。请先安装 TrendPulse Helper 扩展，并在浏览器登录抖音。",
        )
    res = await extension_dispatcher.dispatch_douyin_live_status(
        user_id=user_id, live_url=live["room_url"],
    )
    if not res.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"未抓到直播间状态：{res.get('error', '')[:200] or '可能未开播'}",
        )
    state = {
        "online": res.get("online_count", 0),
        "title": res.get("title", ""),
        "streamer_name": "",
        "room_id": "",
        "gifts": [],
    }
    import json as _json
    await db.update_live_check(
        live_id,
        online=int(state.get("online") or 0),
        gifts_json=_json.dumps(state.get("gifts") or [], ensure_ascii=False),
        streamer_name=state.get("streamer_name") or "",
        room_id=state.get("room_id") or "",
    )
    return {"ok": True, "state": state}


# ── Admin 全平台视图 ────────────────────────────────────────────────────────

def _require_admin(current_user: dict):
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")


@router.get("/admin/overview", summary="平台总览（admin only）")
async def admin_overview(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    from ..services import auth_service
    users = auth_service.list_users()
    user_count = len(users)
    active_users = sum(1 for u in users if u.get("is_active"))

    # 监控统计
    posts = await db.get_posts()
    total_posts = len(posts)
    by_platform: dict = {}
    by_user: dict = {}
    for p in posts:
        plat = p.get("platform") or "xhs"
        by_platform[plat] = by_platform.get(plat, 0) + 1
        uid = p.get("user_id") or 0
        by_user[uid] = by_user.get(uid, 0) + 1

    accounts = await db.get_accounts(include_secrets=False)
    creators = await db.list_creators()
    lives = await db.list_lives()
    return {
        "user_count": user_count,
        "active_user_count": active_users,
        "total_posts": total_posts,
        "total_accounts": len(accounts),
        "total_creators": len(creators),
        "total_lives": len(lives),
        "posts_by_platform": by_platform,
        "posts_by_user_count": len([uid for uid, n in by_user.items() if n > 0]),
        "users_recent": users[:5],
    }


@router.get("/admin/users", summary="所有用户 + 业务数据统计（admin only）")
async def admin_list_users(current_user: dict = Depends(get_current_user)):
    _require_admin(current_user)
    from ..services import auth_service
    users = auth_service.list_users()

    # 一次性聚合统计：posts / accounts / alerts / creators / lives 按 user_id 分组
    posts = await db.get_posts()
    accounts = await db.get_accounts(include_secrets=False)
    creators = await db.list_creators()
    lives = await db.list_lives()

    posts_by_uid: dict = {}
    plat_by_uid: dict = {}
    last_post_at_by_uid: dict = {}
    for p in posts:
        uid = p.get("user_id") or 0
        posts_by_uid[uid] = posts_by_uid.get(uid, 0) + 1
        plat = p.get("platform") or "xhs"
        plat_by_uid.setdefault(uid, {})
        plat_by_uid[uid][plat] = plat_by_uid[uid].get(plat, 0) + 1
        ca = p.get("created_at") or ""
        if ca > (last_post_at_by_uid.get(uid) or ""):
            last_post_at_by_uid[uid] = ca

    accounts_by_uid: dict = {}
    for a in accounts:
        uid = a.get("user_id") or 0
        accounts_by_uid[uid] = accounts_by_uid.get(uid, 0) + 1

    creators_by_uid: dict = {}
    for c in creators:
        uid = c.get("user_id") or 0
        creators_by_uid[uid] = creators_by_uid.get(uid, 0) + 1

    lives_by_uid: dict = {}
    for l in lives:
        uid = l.get("user_id") or 0
        lives_by_uid[uid] = lives_by_uid.get(uid, 0) + 1

    out = []
    for u in users:
        uid = u["id"]
        out.append({
            **u,
            "post_count": posts_by_uid.get(uid, 0),
            "account_count": accounts_by_uid.get(uid, 0),
            "creator_count": creators_by_uid.get(uid, 0),
            "live_count": lives_by_uid.get(uid, 0),
            "posts_by_platform": plat_by_uid.get(uid, {}),
            "last_post_at": last_post_at_by_uid.get(uid, ""),
        })
    return {"users": out}


@router.get("/admin/users/{user_id}/posts", summary="某个用户的监控帖子（admin only）")
async def admin_user_posts(
    user_id: int,
    platform: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    posts = await db.get_posts(user_id=user_id, platform=platform)
    return {"posts": posts}


@router.get("/admin/users/{user_id}/accounts", summary="某个用户的账号（admin only）")
async def admin_user_accounts(
    user_id: int,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    # only_owned=True：只返回 user 自己的，不包括平台共享池
    accs = await db.get_accounts(
        include_secrets=False, user_id=user_id, only_owned=True,
    )
    return {"accounts": accs}


@router.get("/health", summary="抓取健康度大盘（admin only）")
async def health_dashboard(
    days: int = 7,
    current_user: dict = Depends(get_current_user),
):
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return await db.health_summary(days=min(max(days, 1), 30))


# ── Alerts ───────────────────────────────────────────────────────────────────

@router.get("/alerts", summary="告警记录")
async def list_alerts(limit: int = 50, current_user: dict = Depends(get_current_user)):
    is_admin = (current_user.get("role") or "user") == "admin"
    uid = None if is_admin else _scope_uid(current_user)
    return {"alerts": await db.get_alerts(limit, user_id=uid)}


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
    platform: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """普通用户：自己 + 共享池。admin + ?all=true：全平台所有账号。
    可选 ?platform=xhs|douyin|mp 过滤。"""
    is_admin = (current_user.get("role") or "user") == "admin"
    user_id = None if (is_admin and all) else current_user["id"]
    return {"accounts": await db.get_accounts(user_id=user_id, platform=platform)}


@router.post("/accounts", summary="添加账号")
async def add_account(req: AddAccountRequest, current_user: dict = Depends(get_current_user)):
    is_admin = (current_user.get("role") or "user") == "admin"
    # 只有 admin 才能把账号标记为共享池资源
    is_shared = bool(req.is_shared) and is_admin

    # 代理校验：拒绝实际不会生效的 SOCKS5 鉴权代理等
    err = validate_proxy_url(req.proxy_url or "")
    if err:
        raise HTTPException(status_code=400, detail=err)

    # 配额检查：账号池上限（admin 不限）。共享池账号不计入个人配额。
    if not is_shared:
        from ..services import quota_service
        await quota_service.check_or_raise(current_user, "accounts", delta=1)

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
        platform=(req.platform or "xhs"),
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


@router.post("/accounts/cookie/sync", summary="CookieBridge 扩展推送 cookie")
async def cookie_bridge_sync(
    req: CookieSyncRequest,
    current_user: dict = Depends(get_current_user),
):
    """浏览器扩展同步 cookie 到 Pulse。

    设计取舍：
      - 通过 (account_name, platform, user_id) 定位现有账号；不自动创建账号，
        避免任何登录浏览器的扩展往后端灌一堆未受控的账号。
      - 校验 cookie 必须带 a1（小红书签名核心字段），其它字段交给 cookie_health
        job 异步复测，立刻把状态打回 'valid' 让监控立刻能用。
    """
    cookie = (req.cookie or "").strip()
    if not cookie:
        raise HTTPException(status_code=400, detail="cookie 不能为空")
    platform = (req.platform or "xhs").lower()
    # 至少要带 a1（XHS 签名核心字段）；其它平台只校验非空
    if platform == "xhs" and "a1=" not in cookie:
        raise HTTPException(status_code=400, detail="XHS cookie 必须包含 a1 字段")

    account_id = await db.find_account_id_by_name_and_user(
        name=req.account_name, user_id=current_user["id"], platform=platform,
    )
    if not account_id:
        raise HTTPException(
            status_code=404,
            detail=f"未找到账号 '{req.account_name}'（平台 {platform}）。"
                   f"请先在 Pulse 添加同名账号占位。",
        )
    await db.update_cookie_via_bridge(
        account_id=account_id, cookie=cookie, source=(req.source or "extension"),
    )
    return {"ok": True, "account_id": account_id}


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
    current_user: dict = Depends(get_current_user),
):
    platform = (req.platform or "xhs").lower()
    if platform != "xhs":
        # v1：抖音/公众号扫码登录待实现（依赖 douyin/wechat-mp 各自的 cookie 流）
        raise HTTPException(
            status_code=501,
            detail=f"{platform} 扫码登录开发中，请用「手动录入 Cookie」入口",
        )
    payload = req.model_dump()
    # 把当前用户塞进 template，登录成功保存账号时 user_id 才有值（多租户隔离）
    payload["user_id"] = current_user["id"]
    try:
        data = await qr_login.start_session(payload)
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
    "feishu_oauth_redirect_uri", "feishu_bitable_root_folder_token",
    "feishu_admin_open_id", "feishu_invite_url", "feishu_invite_code",
    "feishu_bitable_image_table_id",
    "qiniu_access_key", "qiniu_secret_key", "qiniu_bucket", "qiniu_domain",
    "public_url_prefix",
    "check_interval_minutes", "daily_report_time", "daily_report_enabled",
    "trending_account_ids",
    # 第三方数据源
    "newrank_api_key", "newrank_api_base",
}


@router.get("/settings", summary="获取设置")
async def get_settings(current_user: dict = Depends(get_current_user)):
    """settings 接口现在混合返回：
       - 全局 monitor_settings（admin only 字段对普通用户屏蔽）
       - 当前用户自己的 webhook（feishu_webhook_url / webhook_url），覆盖全局值
    """
    all_settings = await db.get_all_settings()
    is_admin = (current_user.get("role") or "user") == "admin"
    base = all_settings if is_admin else {
        k: v for k, v in all_settings.items() if k not in _ADMIN_ONLY_SETTING_KEYS
    }
    # 用户自己的 webhook 覆盖（多租户隔离）
    from ..services import auth_service
    me = auth_service.get_user_by_id(current_user["id"]) or {}
    base["feishu_webhook_url"] = me.get("feishu_webhook_url", "") or ""
    base["webhook_url"] = me.get("wecom_webhook_url", "") or ""
    # trending 三件套：从 users 表读，覆盖全局值（每用户独立的关键词 / 开关 / 阈值）
    base["trending_keywords"] = me.get("trending_keywords", "") or ""
    base["trending_enabled"] = "1" if me.get("trending_enabled") else "0"
    base["trending_min_likes"] = str(me.get("trending_min_likes") or 1000)
    base["trending_max_per_keyword"] = str(me.get("trending_max_per_keyword") or 30)
    # 用户级抓取频率（0 = 跟随全局 check_interval_minutes）
    base["monitor_interval_minutes"] = str(me.get("monitor_interval_minutes") or 0)
    base["trending_interval_minutes"] = str(me.get("trending_interval_minutes") or 0)
    # per-feature 飞书推送开关 + 已建群标识（前端用来 toggle 开关 / 显示「群已存在」）
    base["trending_push_enabled"] = "1" if me.get("trending_push_enabled") else "0"
    base["creator_push_enabled"]  = "1" if me.get("creator_push_enabled")  else "0"
    base["bitable_push_enabled"]  = "1" if me.get("bitable_push_enabled")  else "0"
    base["trending_chat_id"] = me.get("trending_chat_id", "") or ""
    base["creator_chat_id"]  = me.get("creator_chat_id",  "") or ""
    base["bitable_chat_id"]  = me.get("bitable_chat_id",  "") or ""
    return base


@router.put("/settings", summary="更新设置")
async def update_settings(
    req: UpdateSettingsRequest,
    current_user: dict = Depends(get_current_user),
):
    is_admin = (current_user.get("role") or "user") == "admin"
    bool_val = lambda v: "1" if v else "0"

    # webhook_url / feishu_webhook_url 现在写到 users 表（多租户独立）
    from ..services import auth_service
    if req.feishu_webhook_url is not None or req.webhook_url is not None:
        auth_service.update_user_webhooks(
            current_user["id"],
            feishu_webhook_url=req.feishu_webhook_url,
            wecom_webhook_url=req.webhook_url,
        )

    # 2026-05 多租户：trending 配置（keywords / enabled / min_likes）改为 per-user，
    # 不再写到全局 monitor_settings；trending_account_ids 仍然全局（admin 配共享池）。
    if (req.trending_keywords is not None or req.trending_enabled is not None
            or req.trending_min_likes is not None
            or req.trending_max_per_keyword is not None
            or req.monitor_interval_minutes is not None
            or req.trending_interval_minutes is not None):
        auth_service.update_user_trending(
            current_user["id"],
            keywords=req.trending_keywords,
            enabled=req.trending_enabled,
            min_likes=req.trending_min_likes,
            max_per_keyword=req.trending_max_per_keyword,
            monitor_interval_minutes=req.monitor_interval_minutes,
            trending_interval_minutes=req.trending_interval_minutes,
        )

    # per-feature 飞书推送开关：直接通过 update_user_feishu 写入（_FEISHU_FIELDS 已含）
    push_updates = {}
    for key in ("trending_push_enabled", "creator_push_enabled", "bitable_push_enabled"):
        v = getattr(req, key, None)
        if v is not None:
            push_updates[key] = 1 if v else 0
    if push_updates:
        auth_service.update_user_feishu(current_user["id"], **push_updates)

    simple_fields = [
        "daily_report_time",
        "ai_base_url", "ai_api_key", "ai_model", "ai_rewrite_prompt",
        "feishu_app_id", "feishu_app_secret",
        "feishu_oauth_redirect_uri", "feishu_bitable_root_folder_token",
        "feishu_admin_open_id", "feishu_invite_url", "feishu_invite_code",
        "feishu_bitable_app_token", "feishu_bitable_table_id",
        "feishu_bitable_image_table_id",
        "qiniu_access_key", "qiniu_secret_key", "qiniu_bucket", "qiniu_domain",
        "public_url_prefix",
        "trending_account_ids",  # 仅这个还在全局 settings（admin 配的共享池账号）
        "newrank_api_key", "newrank_api_base",
    ]
    for key in simple_fields:
        if key in _ADMIN_ONLY_SETTING_KEYS and not is_admin:
            continue
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, val)

    bool_fields = [
        "daily_report_enabled", "likes_alert_enabled", "collects_alert_enabled",
        "comments_alert_enabled", "ai_rewrite_enabled",
        "comments_fetch_enabled",
        # trending_enabled 已经在上面 update_user_trending 里写了，不再走全局 settings
    ]
    for key in bool_fields:
        if key in _ADMIN_ONLY_SETTING_KEYS and not is_admin:
            continue
        val = getattr(req, key, None)
        if val is not None:
            await db.set_setting(key, bool_val(val))

    int_fields = [
        "likes_threshold", "collects_threshold", "comments_threshold",
        # trending_min_likes 已经在上面 update_user_trending 里写了
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

    # 平台覆盖键（命名空间，不改 schema）：xhs / douyin / mp 各自独立的阈值
    # 仅以下白名单 key 可被覆盖：likes/collects/comments 的 threshold + alert_enabled
    _ALLOWED_PLATFORM_PREFIXES = ("xhs", "douyin", "mp")
    _PLATFORM_BOOL_SUFFIXES = {"likes_alert_enabled", "collects_alert_enabled", "comments_alert_enabled"}
    _PLATFORM_INT_SUFFIXES = {"likes_threshold", "collects_threshold", "comments_threshold"}
    extra = getattr(req, "__pydantic_extra__", None) or {}
    for raw_key, raw_val in extra.items():
        if "." not in raw_key:
            continue
        prefix, suffix = raw_key.split(".", 1)
        if prefix not in _ALLOWED_PLATFORM_PREFIXES:
            continue
        if suffix in _PLATFORM_BOOL_SUFFIXES:
            # None 或空串 → 删除覆盖（沿用全局）
            if raw_val is None or raw_val == "":
                await db.delete_setting(raw_key)
            else:
                await db.set_setting(raw_key, bool_val(bool(raw_val)))
        elif suffix in _PLATFORM_INT_SUFFIXES:
            if raw_val is None or raw_val == "":
                await db.delete_setting(raw_key)
            else:
                try:
                    iv = int(raw_val)
                except (TypeError, ValueError):
                    continue
                if iv < 1:
                    continue
                await db.set_setting(raw_key, str(iv))

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

    mode = (req.mode or "chat").strip()
    feishu_chat_id = ""
    feishu_webhook_url = (req.feishu_webhook_url or "").strip()

    # ── 模式 A：内部群（自动建群 + 应用机器人）─────────────────────────────
    if mode == "chat":
        if not (current_user.get("feishu_open_id") or "").strip():
            raise HTTPException(
                status_code=400,
                detail="内部群模式需要先在「个人设置」绑定飞书。如果通知到的是外部群，请改选「外部群（webhook）」模式。",
            )
        # 拉成员：当前用户 + admin（如果不是当前用户自己）
        from ..services.feishu import chat as chat_api
        from ..services.feishu.client import FeishuApiError

        members = [current_user["feishu_open_id"]]
        admin_open = (await db.get_setting("feishu_admin_open_id", "")).strip()
        if admin_open and admin_open != current_user["feishu_open_id"]:
            members.append(admin_open)

        chat_name = f"TrendPulse 监控帖子 - {name}"
        chat_desc = f"用户 {current_user.get('username') or current_user['id']} 创建的「{name}」监控告警群"
        try:
            result = await chat_api.create_chat(
                name=chat_name,
                description=chat_desc,
                user_open_ids=members,
            )
            feishu_chat_id = (result.get("chat_id") or "").strip()
            if not feishu_chat_id:
                raise FeishuApiError(-1, f"建群响应缺少 chat_id：{result}")
            # 欢迎消息
            try:
                await chat_api.send_text(
                    feishu_chat_id,
                    f"🎉 「{name}」监控告警群已创建。这个分组下的帖子告警会推送到这里。",
                )
            except FeishuApiError:
                pass  # 欢迎消息失败不阻塞
        except FeishuApiError as e:
            # 把常见错误转成可执行的中文修复指引
            msg = (e.msg or "").lower()
            if "bot ability" in msg or e.code == 232025:
                hint = (
                    "建群失败：飞书应用还没启用「机器人能力」。"
                    "请管理员去飞书开放平台 → 你的应用 → 应用功能 → 添加「机器人」能力 "
                    "→ 应用发布 → 创建版本提交（自建应用秒批）。"
                    "完成后再来「分组管理」点新建即可。"
                )
            elif "no permission" in msg or "permission denied" in msg:
                hint = (
                    f"建群失败：飞书 API 权限不足（{e.msg}）。"
                    "需要在开放平台申请并发布权限：im:chat / im:message:send_as_bot。"
                )
            elif "user_id_list" in msg or "open_id" in msg:
                hint = (
                    f"建群失败：拉人时出错（{e.msg}）。"
                    "可能是 admin 还没绑定飞书，或被拉用户不在企业里。"
                    "建议改用「外部群（webhook）」模式，先在飞书里手动建群，添加自定义机器人后粘 webhook URL。"
                )
            else:
                hint = (
                    f"建群失败：{e.msg}。"
                    "如果反复失败可改用「外部群（webhook）」模式：在飞书里手动建群、加自定义机器人、粘 webhook URL。"
                )
            raise HTTPException(status_code=502, detail=hint)

    # ── 模式 B：外部群（手填 webhook）─────────────────────────────────────
    elif mode == "webhook":
        if not feishu_webhook_url:
            raise HTTPException(status_code=400, detail="外部群模式必须填 Webhook URL")
        if not feishu_webhook_url.startswith("https://open.feishu.cn/"):
            raise HTTPException(
                status_code=400,
                detail="不像是飞书自定义机器人 webhook（应以 https://open.feishu.cn/ 开头）",
            )

    # ── 模式 C：none 仅本地分组 ──────────────────────────────────────────
    elif mode == "none":
        pass
    else:
        raise HTTPException(status_code=400, detail=f"未知模式：{mode}")

    try:
        gid = await db.create_group(
            name, user_id=current_user["id"],
            feishu_chat_id=feishu_chat_id,
            feishu_webhook_url=feishu_webhook_url,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"创建失败：{e}")
    return {
        "ok": True,
        "id": gid,
        "mode": mode,
        "feishu_chat_id": feishu_chat_id,
        "feishu_webhook_url": feishu_webhook_url,
    }


@router.patch("/groups/{group_id}", summary="更新分组")
async def update_group(
    group_id: int, req: UpdateGroupRequest,
    current_user: dict = Depends(get_current_user),
):
    payload = req.model_dump(exclude_none=True)
    # 把 bool 转成 0/1 存数据库
    for k in ("likes_alert_enabled", "collects_alert_enabled", "comments_alert_enabled"):
        if k in payload and isinstance(payload[k], bool):
            payload[k] = 1 if payload[k] else 0
    ok = await db.update_group(group_id, user_id=_scope_uid(current_user), **payload)
    if not ok:
        raise HTTPException(status_code=403, detail="无权修改该分组（不是你创建的，且不是内置分组）")
    return {"ok": True}


@router.delete("/groups/{group_id}", summary="删除分组")
async def delete_group(
    group_id: int,
    fallback: Optional[int] = None,
    current_user: dict = Depends(get_current_user),
):
    try:
        await db.delete_group(
            group_id, fallback_group_id=fallback, user_id=_scope_uid(current_user)
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@router.patch("/posts/{note_id}/group", summary="修改帖子的分组")
async def update_post_group(
    note_id: str, req: UpdatePostRequest, current_user: dict = Depends(get_current_user)
):
    await db.update_post_group(note_id, req.group_id, user_id=_scope_uid(current_user))
    return {"ok": True}


# ── Trending ──────────────────────────────────────────────────────────────────

@router.get("/trending", summary="热门内容列表")
async def list_trending(
    limit: int = 50,
    platform: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    return {"posts": await db.get_trending_posts(
        limit, platform=platform, user_id=_scope_uid(current_user),
    )}


@router.delete("/trending", summary="清空热门内容")
async def clear_trending(
    platform: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """清空热门内容。
    - 普通用户：仅清自己范围（user_id 过滤）
    - admin：传 platform 过滤；不传 platform 清所有用户的所有平台数据
    可选 platform=xhs|douyin|mp 收窄范围。
    """
    scope_uid = _scope_uid(current_user)
    deleted = await db.clear_trending_posts(user_id=scope_uid, platform=platform)
    return {"ok": True, "deleted": deleted, "platform": platform or "all"}


@router.post("/trending/check", summary="立即触发热门抓取（仅触发当前用户的关键词）")
async def manual_trending_check(
    background_tasks: BackgroundTasks,
    platform: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    # 普通用户：只跑自己的；admin：传 user_id=None 触发所有用户
    target_uid = _scope_uid(current_user)
    background_tasks.add_task(
        sched.run_trending_monitor, platform=platform, user_id=target_uid,
    )
    return {
        "ok": True,
        "message": "热门抓取任务已触发",
        "platform": platform or "all",
        "scope": "self" if target_uid is not None else "all_users",
    }


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
async def update_prompt_route(
    prompt_id: int, req: UpdatePromptRequest,
    current_user: dict = Depends(get_current_user),
):
    ok = await db.update_prompt(
        prompt_id, name=req.name, content=req.content,
        user_id=_scope_uid(current_user),
    )
    if not ok:
        raise HTTPException(status_code=403, detail="无权修改该 prompt（不是你创建的）")
    return {"ok": True}


@router.delete("/prompts/{prompt_id}", summary="删除 prompt")
async def delete_prompt_route(
    prompt_id: int, current_user: dict = Depends(get_current_user),
):
    ok = await db.delete_prompt(prompt_id, user_id=_scope_uid(current_user))
    if not ok:
        raise HTTPException(status_code=403, detail="无权删除该 prompt（不是你创建的）")
    return {"ok": True}


@router.post("/prompts/{prompt_id}/set-default", summary="设为默认 prompt")
async def set_default_prompt_route(
    prompt_id: int, current_user: dict = Depends(get_current_user),
):
    ok = await db.set_default_prompt(prompt_id, user_id=_scope_uid(current_user))
    if not ok:
        raise HTTPException(status_code=403, detail="无权将该 prompt 设为默认")
    return {"ok": True}


# ── Manual rewrite + Bitable sync ────────────────────────────────────────────

@router.post("/trending/backfill-media", summary="批量补全热门帖子的封面/图集/视频")
async def backfill_trending_media(
    background_tasks: BackgroundTasks,
    only_missing: bool = True,
    current_user: dict = Depends(get_current_user),
):
    """对当前用户范围的 trending_posts 批量补封面/视频。admin 处理全部，普通用户仅自己的。

    会消耗大量账号请求（每条一次详情页抓取），限速 3 并发 + 抖动。
    """
    scope_uid = _scope_uid(current_user)

    async def _job():
        import json as _json
        import asyncio
        account = None
        for acc in await db.get_accounts(include_secrets=True):
            if acc.get("is_active") and acc.get("cookie") and acc.get("cookie_status") != "expired":
                account = acc
                break
        all_posts = await db.get_trending_posts(limit=500, user_id=scope_uid)
        if only_missing:
            targets = [p for p in all_posts if not (p.get("cover_url") or p.get("images"))]
        else:
            targets = all_posts
        sem = __import__("asyncio").Semaphore(3)
        ok_count = 0
        fail_count = 0

        from ..services import extension_dispatcher
        async def _one(p):
            nonlocal ok_count, fail_count
            async with sem:
                try:
                    plat = (p.get("platform") or "xhs").lower()
                    metrics = None
                    status = "skip"
                    # 抖音帖子走扩展通道（无匿名兜底）；小红书优先扩展失败回退匿名
                    if plat == "douyin":
                        if extension_dispatcher.has_online_extension(scope_uid):
                            res = await extension_dispatcher.dispatch_douyin_note_detail(
                                user_id=scope_uid, aweme_id=p["note_id"],
                            )
                            if res.get("ok"):
                                metrics = res
                                status = "ok"
                    else:  # xhs 默认
                        if extension_dispatcher.has_online_extension(scope_uid):
                            try:
                                res = await extension_dispatcher.dispatch_xhs_note_detail(
                                    user_id=scope_uid, note_id=p["note_id"],
                                    xsec_token=p.get("xsec_token", ""),
                                )
                                if res.get("ok"):
                                    metrics = res
                                    status = "ok"
                            except Exception:
                                pass
                        if not metrics:
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
                            user_id=p.get("user_id"),
                        )
                        if metrics.get("desc") and not p.get("desc_text"):
                            await db.update_trending_desc(
                                p["note_id"], metrics["desc"], user_id=p.get("user_id"),
                            )
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
    current_user: dict = Depends(get_current_user),
):
    """补全单条热门帖子的正文 / 图集 / 视频。

    通道优先级:
      1. 在线扩展（用户浏览器抓 detail，零封号风险，且能拿到登录态独占字段）
      2. 匿名 monitor_fetcher（兜底，能拿公开内容但拿不到私密）
    """
    from ..services import extension_dispatcher

    scope_uid = _scope_uid(current_user)
    post = await db.get_trending_post(note_id, user_id=scope_uid)
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在或无权访问")

    title = post.get("title") or ""
    desc = ""
    images: list = []
    video_url = ""
    cover_url = ""
    note_type = "normal"
    via = ""

    plat_name = (post.get("platform") or "xhs").lower()

    # 路径 1: 扩展通道（按平台路由）
    if extension_dispatcher.has_online_extension(scope_uid):
        try:
            if plat_name == "xhs":
                res = await extension_dispatcher.dispatch_xhs_note_detail(
                    user_id=scope_uid, note_id=note_id,
                    xsec_token=post.get("xsec_token", ""),
                )
            elif plat_name == "douyin":
                res = await extension_dispatcher.dispatch_douyin_note_detail(
                    user_id=scope_uid, aweme_id=note_id,
                )
            else:
                res = {"ok": False}
            if res.get("ok"):
                title = res.get("title") or title
                desc = res.get("desc") or ""
                images = res.get("images") or []
                video_url = res.get("video_url") or ""
                cover_url = res.get("cover_url") or ""
                note_type = res.get("note_type") or "normal"
                via = "extension"
        except Exception as e:
            logger.warning(f"[fetch-content] extension path failed for {note_id}: {e}")

    # 路径 2: 匿名兜底（仅小红书有匿名 fetch_note_metrics 实现）
    if not desc and plat_name == "xhs":
        metrics, status = await fetcher.fetch_note_metrics(
            note_id, post.get("xsec_token", ""), "pc_search", account=None,
        )
        if metrics:
            desc = metrics.get("desc") or desc
            title = metrics.get("title") or title
            images = metrics.get("images") or images
            video_url = metrics.get("video_url") or video_url
            cover_url = metrics.get("cover_url") or cover_url
            note_type = metrics.get("note_type") or note_type
            via = via or "anonymous"
        elif via != "extension":
            if status == "login_required":
                raise HTTPException(
                    status_code=400,
                    detail="该帖子需要登录态。请先安装并连接 TrendPulse Helper 浏览器扩展，浏览器登录小红书后重试。",
                )
            raise HTTPException(status_code=400, detail=f"抓取失败：{status}")
    elif not desc and via != "extension":
        # 抖音/公众号 没有匿名兜底，缺扩展直接报错
        raise HTTPException(
            status_code=400,
            detail=f"抓取失败。请先安装 TrendPulse Helper 浏览器扩展并在浏览器登录{plat_name}。",
        )

    if desc:
        await db.update_trending_desc(note_id, desc, user_id=scope_uid)
    # Persist media too — they may not have come from search.
    import json as _json
    await db.update_trending_media(
        note_id,
        cover_url=cover_url,
        images_json=_json.dumps(images, ensure_ascii=False) if images else "",
        video_url=video_url,
        note_type=note_type,
        user_id=scope_uid,
    )
    return {
        "ok": True,
        "via": via,
        "title": title,
        "desc_text": desc,
        "desc_length": len(desc),
        "cover_url": cover_url,
        "images": images,
        "video_url": video_url,
        "note_type": note_type,
    }


@router.post("/trending/posts/{note_id}/rewrite", summary="改写指定热门帖子（支持多变体）")
async def rewrite_trending_post(
    note_id: str,
    req: RewriteTrendingRequest,
    variants: int = 1,
    current_user: dict = Depends(get_current_user),
):
    scope_uid = _scope_uid(current_user)
    post = await db.get_trending_post(note_id, user_id=scope_uid)
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在或无权访问")

    text = (post.get("desc_text") or post.get("title") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="该帖子没有文本可改写（标题和正文都为空）")

    prompt_template = None
    if req.prompt_text and req.prompt_text.strip():
        prompt_template = req.prompt_text
    elif req.prompt_id is not None:
        p = await db.get_prompt(req.prompt_id, user_id=scope_uid)
        if not p:
            raise HTTPException(status_code=404, detail="prompt 不存在或无权访问")
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

    n = max(1, min(int(variants or 1), 5))
    try:
        if n == 1:
            rewritten = await ai_rewriter.rewrite_content(
                ai_base_url, ai_api_key, ai_model, prompt_template, text
            )
            variants_list = [rewritten]
        else:
            variants_list = await ai_rewriter.rewrite_variants(
                ai_base_url, ai_api_key, ai_model, prompt_template, text, n=n,
            )
            if not variants_list:
                raise RuntimeError("所有变体都失败")
            rewritten = variants_list[0]
    except Exception as e:
        await db.update_trending_rewrite(note_id, "", "failed", user_id=scope_uid)
        raise HTTPException(status_code=500, detail=f"AI 改写失败: {e}")

    await db.update_trending_rewrite(note_id, rewritten, "done", user_id=scope_uid)
    return {"ok": True, "rewritten": rewritten, "variants": variants_list}


@router.post("/trending/posts/{note_id}/rewrite/lock", summary="锁定一个变体为最终版本")
async def lock_rewrite_variant(
    note_id: str,
    req: LockVariantRequest,
    current_user: dict = Depends(get_current_user),
):
    """运营从多变体里挑一个，把它替换 trending_posts.rewritten_text。"""
    if not req.variant or not req.variant.strip():
        raise HTTPException(status_code=400, detail="variant 不能为空")
    scope_uid = _scope_uid(current_user)
    post = await db.get_trending_post(note_id, user_id=scope_uid)
    if not post:
        raise HTTPException(status_code=404, detail="帖子不存在或无权访问")
    await db.update_trending_rewrite(note_id, req.variant.strip(), "done", user_id=scope_uid)
    return {"ok": True}


@router.post("/trending/sync-bitable", summary="把选中的热门帖子同步到飞书多维表格")
async def sync_trending_to_bitable(
    req: SyncBitableRequest,
    current_user: dict = Depends(get_current_user),
):
    if not req.note_ids:
        raise HTTPException(status_code=400, detail="未选中任何帖子")

    # 优先写用户专属表（OAuth 绑定后自动建），缺失时 fallback 到全局表
    from ..services.feishu import bitable as feishu_bitable_v2
    target = await feishu_bitable_v2.resolve_target(current_user, kind="trending")
    if target["source"] == "none":
        raise HTTPException(
            status_code=400,
            detail="未找到飞书热门表。请先「绑定飞书」让系统自动建表，"
                   "或让管理员配置 feishu_bitable_app_token + feishu_bitable_table_id 作为兜底。",
        )
    bitable_app_token = target["app_token"]
    bitable_table_id = target["table_id"]

    # 全局表第一次同步时自动建字段；用户专属表 provisioning 时已建好。
    if target["source"] == "global":
        settings = await db.get_all_settings()
        bitable_app_id     = settings.get("feishu_app_id", "")
        bitable_app_secret = settings.get("feishu_app_secret", "")
        if not (bitable_app_id and bitable_app_secret):
            raise HTTPException(status_code=400, detail="飞书 app_id / app_secret 未配置")
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

    scope_uid = _scope_uid(current_user)
    results = []
    for nid in req.note_ids:
        p = await db.get_trending_post(nid, user_id=scope_uid)
        if not p:
            results.append({"note_id": nid, "ok": False, "reason": "帖子不存在或无权访问"})
            continue
        text = (p.get("desc_text") or p.get("title") or "").strip()
        rewritten = (p.get("rewritten_text") or "").strip()
        if not (p.get("title") or "").strip():
            results.append({"note_id": nid, "ok": False, "reason": "标题为空（旧数据），已跳过"})
            continue
        try:
            note_url = p.get("note_url", "")
            await feishu_bitable_v2.add_record(
                bitable_app_token, bitable_table_id,
                fields={
                    "关键词": p.get("keyword", ""),
                    "标题": p.get("title", ""),
                    "原文": text,
                    "改写文案": rewritten,
                    "点赞数": p.get("liked_count", 0),
                    "收藏数": p.get("collected_count", 0),
                    "帖子链接": {"link": note_url, "text": note_url} if note_url else "",
                    "作者": p.get("author", ""),
                },
            )
            await db.mark_trending_synced(nid, user_id=scope_uid)
            results.append({"note_id": nid, "ok": True})
        except Exception as e:
            results.append({"note_id": nid, "ok": False, "reason": str(e)})
    return {"results": results, "target": target["source"]}


