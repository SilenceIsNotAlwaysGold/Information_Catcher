import asyncio
import logging
import random
from typing import Optional
import aiosqlite
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from . import monitor_db as db
from . import monitor_fetcher as fetcher
from . import notifier
from . import trending_fetcher
from . import comment_fetcher
from . import cookie_health
from . import platforms as platform_registry
from . import image_upload_worker
from . import remix_worker
from . import media_archiver

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")


async def _check_post(post: dict, settings: dict, wecom_url: str, feishu_url: str,
                      feishu_chat_id: str = ""):
    note_id = post["note_id"]
    # Use pre-loaded account when available (set by run_monitor); fall back to DB fetch.
    # Check key existence — None means "account deleted", missing key means "not pre-loaded".
    if "_account" in post:
        account = post["_account"]
    elif post.get("account_id"):
        account = await db.get_account(post["account_id"])
    else:
        account = None

    # Never send an expired cookie — that's the fast path to risk control.
    if account and account.get("cookie_status") == "expired":
        logger.warning(
            f"[monitor] {note_id}: account '{account.get('name')}' cookie expired, "
            f"skipping cookie use to avoid risk control"
        )
        account = None

    # 按 platform 路由到对应实现（默认 xhs）
    plat = platform_registry.get_platform(post.get("platform") or "xhs")
    if not plat:
        logger.warning(f"[monitor] {note_id}: 未知平台 {post.get('platform')}")
        await db.update_post_fetch_status(note_id, "error")
        return
    detail_post = {
        "note_id": note_id,
        "post_id": note_id,
        "url": post.get("note_url"),
        "xsec_token": post.get("xsec_token", ""),
        "xsec_source": post.get("xsec_source", "app_share"),
        "account_cookie": post.get("account_cookie"),
    }
    # 公众号 fetch 用 user.mp_auth_* 作为 account（不是 monitor_accounts 表）
    if (post.get("platform") or "xhs") == "mp":
        from . import auth_service
        u = auth_service.get_user_by_id(post.get("user_id")) if post.get("user_id") else None
        if u and u.get("mp_auth_uin"):
            account = {
                "mp_auth_uin":         u.get("mp_auth_uin"),
                "mp_auth_key":         u.get("mp_auth_key"),
                "mp_auth_pass_ticket": u.get("mp_auth_pass_ticket"),
                "mp_auth_appmsg_token": u.get("mp_auth_appmsg_token"),
            }
    import time as _t
    _t0 = _t.perf_counter()
    metrics, fetch_status = await plat.fetch_detail(detail_post, account=account)
    _latency_ms = int((_t.perf_counter() - _t0) * 1000)
    await db.update_post_fetch_status(note_id, fetch_status)
    # 健康度埋点
    await db.log_fetch(
        platform=plat.name, task_type="monitor",
        status=fetch_status, latency_ms=_latency_ms,
        account_id=(account.get("id") if account else None),
        note_id=note_id,
    )
    if not metrics:
        logger.warning(f"[monitor] failed to fetch {note_id} ({fetch_status})")
        return

    # 标题 + 平台特定的元数据（公众号 copyright_stat / source_url / author）
    update_fields: dict = {}
    if not post.get("title") and metrics.get("title"):
        update_fields["title"] = metrics["title"]
    if "copyright_stat" in metrics:
        update_fields["copyright_stat"] = metrics.get("copyright_stat") or ""
    if "source_url" in metrics:
        update_fields["source_url"] = metrics.get("source_url") or ""
    if metrics.get("author") and not post.get("author"):
        update_fields["author"] = metrics.get("author") or ""
    # 话题：每次抓都更新（话题可能后续被作者编辑）
    if isinstance(metrics.get("tags"), list):
        import json as _json
        update_fields["tags"] = _json.dumps(metrics["tags"], ensure_ascii=False)
    if update_fields:
        set_clause = ", ".join(f"{k}=?" for k in update_fields)
        values = list(update_fields.values()) + [note_id]
        async with aiosqlite.connect(db.DB_PATH) as conn:
            await conn.execute(
                f"UPDATE monitor_posts SET {set_clause} WHERE note_id=?", values,
            )
            await conn.commit()

    prev = await db.get_latest_snapshot(note_id)
    await db.save_snapshot(
        note_id,
        metrics["liked_count"],
        metrics["collected_count"],
        metrics["comment_count"],
        metrics["share_count"],
    )

    if not prev:
        return

    liked_delta     = metrics["liked_count"]     - prev["liked_count"]
    collected_delta = metrics["collected_count"] - prev["collected_count"]
    comment_delta   = metrics["comment_count"]   - prev["comment_count"]
    title = post.get("title") or metrics.get("title") or note_id

    # Resolve group config — fall back to global settings when fields are NULL.
    group = None
    gid = post.get("group_id")
    if gid:
        group = await db.get_group(gid)

    # 阈值优先级：group(NULL→fallback) > {platform}.{key} > {key}（全局）> default
    platform_key = (post.get("platform") or "xhs")

    def _bool_setting(group_val, setting_key: str, default: str = "1", platform: str | None = None) -> bool:
        if group is not None and group_val is not None:
            return bool(group_val)
        if platform:
            scoped = settings.get(f"{platform}.{setting_key}")
            if scoped not in (None, ""):
                return scoped == "1"
        return settings.get(setting_key, default) == "1"

    def _int_setting(group_val, setting_key: str, default: str, platform: str | None = None) -> int:
        if group is not None and group_val is not None:
            return int(group_val)
        if platform:
            scoped = settings.get(f"{platform}.{setting_key}")
            if scoped not in (None, ""):
                try:
                    return int(scoped)
                except ValueError:
                    pass
        return int(settings.get(setting_key, default) or default)

    likes_on    = _bool_setting(group and group.get("likes_alert_enabled"),    "likes_alert_enabled",    platform=platform_key)
    collects_on = _bool_setting(group and group.get("collects_alert_enabled"), "collects_alert_enabled", platform=platform_key)
    comments_on = _bool_setting(group and group.get("comments_alert_enabled"), "comments_alert_enabled", platform=platform_key)
    likes_thr    = _int_setting(group and group.get("likes_threshold"),    "likes_threshold",    "50", platform=platform_key)
    collects_thr = _int_setting(group and group.get("collects_threshold"), "collects_threshold", "50", platform=platform_key)
    comments_thr = _int_setting(group and group.get("comments_threshold"), "comments_threshold", "1",  platform=platform_key)

    # 推送目标解析（2026-05 改为 per-group 飞书绑定优先）：
    #   group.feishu_chat_id   有 → 内部群应用机器人（最优先）
    #   group.feishu_webhook_url 有 → 外部群自定义机器人 webhook
    #   都没 → fallback 用户级 chat_id（个人专属群）
    group_chat = (group.get("feishu_chat_id") if group else "") or ""
    group_webhook = (group.get("feishu_webhook_url") if group else "") or ""
    if group_chat:
        g_feishu_chat = group_chat
        g_feishu = ""  # group 已显式绑 chat，不再走 webhook
    elif group_webhook:
        g_feishu_chat = ""
        g_feishu = group_webhook
    else:
        g_feishu_chat = feishu_chat_id  # fallback 用户专属群
        g_feishu = ""  # 用户级 webhook 已废弃
    g_wecom = (group.get("wecom_webhook_url") if group else "") or wecom_url

    if not g_wecom and not g_feishu and not g_feishu_chat:
        return

    prefix = (group.get("message_prefix") if group else "") or ""

    # Build template context once — templates can use any of these fields.
    ctx = {
        "title": title,
        "note_id": note_id,
        "note_url": post.get("note_url", ""),
        "liked_count":     metrics["liked_count"],
        "liked_delta":     liked_delta,
        "collected_count": metrics["collected_count"],
        "collected_delta": collected_delta,
        "comment_count":   metrics["comment_count"],
        "comment_delta":   comment_delta,
    }

    def _fmt(template: str, default: str) -> str:
        tpl = template or default
        try:
            return tpl.format(**ctx)
        except Exception as e:
            logger.warning(f"[monitor] template render error: {e}; falling back to default")
            return default.format(**ctx)

    post_user_id = post.get("user_id")

    # 升级版：先解析 group.alert_rules（JSON）。如果配了 rules 就用 rules，
    # 否则保持原有 likes/collects/comments 三大件兼容逻辑。
    rules = []
    if group and (group.get("alert_rules") or "").strip():
        try:
            rules = __import__("json").loads(group["alert_rules"])
            if not isinstance(rules, list):
                rules = []
        except Exception as e:
            logger.warning(f"[monitor] group {group.get('id')} alert_rules JSON 解析失败: {e}")

    metric_value = {
        "liked": metrics["liked_count"],
        "collected": metrics["collected_count"],
        "comment": metrics["comment_count"],
    }
    metric_delta = {
        "liked": liked_delta,
        "collected": collected_delta,
        "comment": comment_delta,
    }
    metric_label = {"liked": "点赞", "collected": "收藏", "comment": "评论"}

    async def _maybe_alert(alert_type: str, message: str, body_default: str, template: str | None,
                           dedup_hours: int = 4) -> None:
        # 4 小时去抖动：同 (note_id, alert_type) 内不重复通知
        if dedup_hours > 0 and await db.has_recent_alert(note_id, alert_type, dedup_hours):
            return
        await db.save_alert(note_id, title, alert_type, message, user_id=post_user_id)
        await notifier.notify_metric(
            g_wecom, g_feishu, title, note_id, post["xsec_token"],
            f"{prefix}{metric_label.get(alert_type.split('_')[0], '指标')}告警".strip(),
            _fmt(template, body_default),
            feishu_chat_id=g_feishu_chat,
        )

    if rules:
        for r in rules:
            try:
                rtype = r.get("type")
                metric = r.get("metric")  # liked / collected / comment
                if metric not in metric_value:
                    continue
                cur_val = metric_value[metric]
                delta_val = metric_delta[metric]

                if rtype == "delta":
                    thr = int(r.get("threshold", 50))
                    if delta_val >= thr:
                        await _maybe_alert(
                            f"{metric}_delta",
                            f"{metric_label[metric]} +{delta_val}",
                            f"「{{title}}」{metric_label[metric]} **+{delta_val}**（当前 {cur_val}）",
                            r.get("template"),
                        )
                elif rtype == "cumulative":
                    # 累计首次触达：当前值 >= threshold 且历史从未告警过这个 type
                    thr = int(r.get("threshold", 10000))
                    alert_type = f"{metric}_cum_{thr}"
                    if cur_val >= thr and not await db.has_ever_alerted(note_id, alert_type):
                        await _maybe_alert(
                            alert_type,
                            f"{metric_label[metric]} 首次达到 {thr}",
                            f"🎉「{{title}}」{metric_label[metric]} **累计达到 {thr}**（当前 {cur_val}）",
                            r.get("template"),
                            dedup_hours=0,  # 一次性通知，不需要去抖
                        )
                elif rtype == "percent":
                    # 24 小时涨幅 ≥ N%
                    pct = float(r.get("threshold_pct", 30))
                    hours_window = int(r.get("window_hours", 24))
                    base = await db.get_snapshot_at_or_before(note_id, hours_window)
                    if base and base.get(f"{metric}_count"):
                        old = base[f"{metric}_count"]
                        if old > 0:
                            growth = (cur_val - old) * 100.0 / old
                            if growth >= pct:
                                await _maybe_alert(
                                    f"{metric}_pct",
                                    f"{metric_label[metric]} {hours_window}h 涨幅 {growth:.0f}%",
                                    f"📈「{{title}}」{metric_label[metric]} **{hours_window}h 涨幅 {growth:.0f}%**（当前 {cur_val}，{hours_window}h 前 {old}）",
                                    r.get("template"),
                                )
            except Exception as e:
                logger.warning(f"[monitor] rule eval error: {e}")
    else:
        # 旧规则（向后兼容）：likes/collects/comments delta + 4h 去抖
        if likes_on and liked_delta >= likes_thr:
            if not await db.has_recent_alert(note_id, "likes", 4):
                await db.save_alert(note_id, title, "likes", f"点赞 +{liked_delta}", user_id=post_user_id)
                body = _fmt(group and group.get("template_likes"),
                            "「{title}」点赞 **+{liked_delta}**（当前 {liked_count}）")
                await notifier.notify_metric(
                    g_wecom, g_feishu, title, note_id, post["xsec_token"],
                    f"{prefix}点赞飙升".strip(), body,
                    feishu_chat_id=g_feishu_chat,
                )

        if collects_on and collected_delta >= collects_thr:
            if not await db.has_recent_alert(note_id, "collects", 4):
                await db.save_alert(note_id, title, "collects", f"收藏 +{collected_delta}", user_id=post_user_id)
                body = _fmt(group and group.get("template_collects"),
                            "「{title}」收藏 **+{collected_delta}**（当前 {collected_count}）")
                await notifier.notify_metric(
                    g_wecom, g_feishu, title, note_id, post["xsec_token"],
                    f"{prefix}收藏飙升".strip(), body,
                    feishu_chat_id=g_feishu_chat,
                )

    # Fetch actual comment content when threshold triggered
    if comments_on and comment_delta >= comments_thr:
        await db.save_alert(note_id, title, "comment", f"新增评论 {comment_delta} 条", user_id=post_user_id)

        # Try to fetch actual new comment content via Playwright
        comments_fetch_enabled = settings.get("comments_fetch_enabled", "0") == "1"
        if comments_fetch_enabled and account:
            try:
                raw_comments = await comment_fetcher.fetch_note_comments(
                    note_id, post["xsec_token"], account, max_count=20
                )
                new_comments = await db.add_note_comments(note_id, raw_comments)
                if new_comments:
                    await notifier.notify_new_comments(
                        g_wecom, g_feishu, f"{prefix}{title}".strip(),
                        note_id, post["xsec_token"], new_comments,
                        feishu_chat_id=g_feishu_chat,
                    )
                    return
            except Exception as e:
                logger.error(f"[monitor] comment fetch error for {note_id}: {e}")

        # Fallback: just push count
        body = _fmt(group and group.get("template_comments"),
                    "「{title}」新增评论 **{comment_delta}** 条（当前 {comment_count}）")
        await notifier.notify_metric(
            g_wecom, g_feishu, title, note_id, post["xsec_token"],
            f"{prefix}新评论".strip(), body,
            feishu_chat_id=g_feishu_chat,
        )


async def run_monitor():
    """Periodic job: check all active monitored posts."""
    settings = await db.get_all_settings()

    posts = await db.get_active_posts()
    logger.info(f"[monitor] checking {len(posts)} posts")

    # Pre-load distinct accounts to avoid one DB query per post (N+1).
    account_cache: dict = {}
    for post in posts:
        aid = post.get("account_id")
        if aid and aid not in account_cache:
            acc = await db.get_account(aid)
            account_cache[aid] = acc  # may be None if deleted

    # 多租户推送：按 post.user_id 查用户自己的 webhook + 飞书群 chat_id
    # chat_id 是 OAuth 自动建群后落库的；优先级在 webhook 之上，由 notifier 决定
    from . import auth_service
    webhook_cache: dict = {}
    def _user_webhooks(uid):
        if uid is None:
            return ("", "", "")
        if uid in webhook_cache:
            return webhook_cache[uid]
        u = auth_service.get_user_by_id(uid) or {}
        wh = (
            u.get("wecom_webhook_url", "") or "",
            u.get("feishu_webhook_url", "") or "",
            u.get("feishu_chat_id", "") or "",
        )
        webhook_cache[uid] = wh
        return wh

    # 帖子抓取的账号策略（基于调研结论简化）：
    #   - 帖子绑定了具体 account_id（"我的帖子"组）→ 用那个账号
    #   - 其他情况一律匿名抓（xsec_source 在 add_post 时强制写为 app_share，
    #     公开可达，不消耗任何账号）
    # 调研：search 来的 token 配 app_share + 无 cookie，详情、图片、视频都能拿到。
    # 风控规避：限制并发到 2，避免同一时间发出过多请求
    sem = asyncio.Semaphore(2)
    skipped = 0

    async def _process(post):
        nonlocal skipped
        if (post.get("fail_count") or 0) >= db.DEAD_POST_FAIL_THRESHOLD:
            skipped += 1
            return
        async with sem:
            try:
                aid = post.get("account_id")
                account = account_cache.get(aid) if aid else None
                post["_account"] = account
                wecom_url, feishu_url, feishu_chat_id = _user_webhooks(post.get("user_id"))
                await _check_post(post, settings, wecom_url, feishu_url, feishu_chat_id)
                # 抓取间留 0.5-1.5s 抖动（fetcher 内部的 1-2.5s 是请求级，这里是任务级）
                await asyncio.sleep(random.uniform(0.5, 1.5))
            except Exception as e:
                logger.error(f"[monitor] error on {post['note_id']}: {e}")

    await asyncio.gather(*[_process(p) for p in posts])
    if skipped:
        logger.info(f"[monitor] skipped {skipped} posts marked as dead (fail_count >= {db.DEAD_POST_FAIL_THRESHOLD})")


async def run_own_comments_check():
    """轮询「我的帖子」评论 — 走浏览器扩展通道。

    扩展用用户已登录的浏览器抓评论，零封号风险。
    没在线扩展的用户：跳过该轮，等用户连上再跑。
    """
    from . import extension_dispatcher

    settings = await db.get_all_settings()
    if settings.get("own_comments_enabled", "1") != "1":
        return
    if settings.get("comments_fetch_enabled", "0") != "1":
        return

    posts = await db.get_active_posts()
    own_posts = [
        p for p in posts
        if p.get("account_id") and (p.get("platform") or "xhs") in ("xhs", "douyin")
    ]
    if not own_posts:
        return
    logger.info(f"[own_comments] checking {len(own_posts)} 我的帖子 via extension")

    from . import auth_service
    online_cache: dict = {}
    new_total = 0

    def _has_ext(uid):
        if uid not in online_cache:
            online_cache[uid] = extension_dispatcher.has_online_extension(uid)
        return online_cache[uid]

    for post in own_posts:
        uid = post.get("user_id")
        if not _has_ext(uid):
            continue  # 该用户没装扩展，跳过本轮
        platform_name = post.get("platform") or "xhs"
        try:
            if platform_name == "xhs":
                res = await extension_dispatcher.dispatch_xhs_fetch_comments(
                    user_id=uid, note_id=post["note_id"],
                    xsec_token=post.get("xsec_token", ""),
                )
            else:  # douyin
                res = await extension_dispatcher.dispatch_douyin_fetch_comments(
                    user_id=uid, aweme_id=post["note_id"],
                )
            if not res.get("ok"):
                await db.log_fetch(
                    platform=platform_name, task_type="comment", status="error",
                    account_id=None, note_id=post["note_id"],
                    note=res.get("error", "")[:200],
                )
                continue

            # 入库 + 取新增列表
            raw = res.get("comments") or []
            new_comments = await db.add_note_comments(post["note_id"], raw)
            if not new_comments:
                continue
            new_total += len(new_comments)

            u = auth_service.get_user_by_id(uid) if uid else {}
            wecom = (u or {}).get("wecom_webhook_url", "")
            feishu = (u or {}).get("feishu_webhook_url", "")
            chat = (u or {}).get("feishu_chat_id", "")
            if wecom or feishu or chat:
                title = post.get("title") or post["note_id"]
                await notifier.notify_new_comments(
                    wecom, feishu, title, post["note_id"],
                    post.get("xsec_token", ""), new_comments,
                    feishu_chat_id=chat,
                )
            await db.log_fetch(
                platform=platform_name, task_type="comment", status="ok",
                account_id=None, note_id=post["note_id"],
                note=f"new={len(new_comments)} via=extension",
            )
        except Exception as e:
            logger.error(f"[own_comments] error on {post['note_id']}: {e}")
            await db.log_fetch(
                platform=platform_name, task_type="comment", status="error",
                account_id=None, note_id=post["note_id"],
                note=str(e)[:200],
            )
    if new_total:
        logger.info(f"[own_comments] 新增 {new_total} 条评论 via extension")


async def run_creator_check():
    """博主订阅追新：通过浏览器扩展拉博主主页，新帖入监控列表。

    完全走扩展通道（用户在自己浏览器里登录 → 扩展拦截 user_posted/aweme/post API）。
    没有在线扩展时跳过该用户的所有 creator，标记 'no_extension' 状态等待用户安装。
    """
    from . import extension_dispatcher

    creators = await db.list_creators()
    if not creators:
        return
    creator_by_key = {f"creator:{c['id']}": c for c in creators}
    sorted_keys = await db.cursor_sort_by_last_run(
        "creator", list(creator_by_key.keys()),
    )
    logger.info(
        f"[creator_check] checking {len(creators)} creators via extension (cursor-ordered)"
    )

    user_channels: dict = {}
    online_cache: dict = {}  # user_id → bool 缓存当轮的在线扩展状态
    from . import auth_service as _auth

    def _channels(uid):
        if uid in user_channels:
            return user_channels[uid]
        u = _auth.get_user_by_id(uid) if uid else {}
        ch = (
            (u or {}).get("wecom_webhook_url", "") or "",
            (u or {}).get("feishu_webhook_url", "") or "",
            (u or {}).get("feishu_chat_id", "") or "",
        )
        user_channels[uid] = ch
        return ch

    def _has_ext(uid):
        if uid not in online_cache:
            online_cache[uid] = extension_dispatcher.has_online_extension(uid)
        return online_cache[uid]

    for ck in sorted_keys:
        creator = creator_by_key[ck]
        platform_name = creator.get("platform") or "xhs"
        uid = creator.get("user_id")

        if not _has_ext(uid):
            await db.mark_creator_status(
                creator["id"], "no_extension",
                "需要安装并连接 Pulse Helper 浏览器扩展，登录平台账号即可",
            )
            continue

        await db.cursor_mark_running("creator", ck)
        try:
            if platform_name == "xhs":
                res = await extension_dispatcher.dispatch_xhs_creator_posts(
                    user_id=uid, url=creator["creator_url"],
                    timeout_ms=25000, overall_timeout=60.0,
                )
            elif platform_name == "douyin":
                res = await extension_dispatcher.dispatch_douyin_creator_posts(
                    user_id=uid, url=creator["creator_url"],
                    timeout_ms=25000, overall_timeout=60.0,
                )
            else:
                await db.cursor_mark_failed("creator", ck, f"unknown platform {platform_name}")
                await db.mark_creator_status(creator["id"], "error", f"暂不支持的平台 {platform_name}")
                continue
        except Exception as e:
            logger.error(f"[creator_check] {creator['creator_url']} dispatch error: {e}")
            await db.cursor_mark_failed("creator", ck, str(e))
            await db.mark_creator_status(creator["id"], "error", str(e))
            continue

        if not res.get("ok"):
            raw = (res.get("error") or "")[:200]
            msg = (res.get("detail") or raw or "扩展返回失败")[:200]
            await db.cursor_mark_failed("creator", ck, raw or "fail")
            # 风控类错误归类为 cookie_invalid 让前端显示对应的提示
            status = "cookie_invalid" if raw in ("captcha_required", "login_required") else "error"
            await db.mark_creator_status(creator["id"], status, msg)
            continue

        posts = res.get("posts") or []
        last_post_id = creator.get("last_post_id") or ""

        # 抓回 0 帖：如果之前已经抓到过，可能是用户没在该浏览器登录该平台
        if not posts and last_post_id:
            await db.mark_creator_status(
                creator["id"], "ext_login_required",
                "扩展已连接但抓取返回 0 帖，请确认浏览器已登录该平台",
            )
            await db.cursor_mark_done("creator", ck)
            continue

        newest = last_post_id
        added = 0
        new_posts: list = []
        for p in posts:
            pid = p.get("post_id")
            if not pid:
                continue
            if pid == last_post_id:
                break
            try:
                await db.add_post(
                    note_id=pid, title=p.get("title") or "",
                    short_url=p.get("url") or "", note_url=p.get("url") or "",
                    xsec_token=p.get("xsec_token", ""), xsec_source="app_share",
                    account_id=None, post_type="own",
                    user_id=uid,
                    platform=platform_name,
                )
                added += 1
                new_posts.append(p)
                if not newest:
                    newest = pid
            except Exception as e:
                logger.debug(f"[creator_check] add_post {pid} skipped: {e}")

        await db.update_creator_check(
            creator["id"], last_post_id=newest,
            creator_name=(posts[0].get("creator_name", "") if posts else ""),
        )
        await db.cursor_mark_done("creator", ck, cursor=newest or "")
        await db.mark_creator_status(creator["id"], "ok")
        if added:
            await db.add_creator_unread(creator["id"], added)
            logger.info(
                f"[creator_check] {creator.get('creator_name') or creator['creator_url']} +{added} 新帖"
            )
            # 用户级飞书/企微推送：博主新发就告警
            wecom_url, feishu_url, chat_id = _channels(uid)
            if wecom_url or feishu_url or chat_id:
                try:
                    await notifier.notify_creator_new_posts(
                        wecom_url, feishu_url,
                        creator_name=(
                            creator.get("creator_name")
                            or (new_posts[0].get("creator_name") if new_posts else "")
                            or creator.get("creator_url", "")
                        ),
                        platform=platform_name,
                        posts=new_posts,
                        feishu_chat_id=chat_id,
                    )
                except Exception as e:
                    logger.warning(f"[creator_check] notify failed: {e}")


async def run_live_check():
    """直播间监控：通过浏览器扩展拉直播间状态（在线人数 / 主播信息）。

    扩展跑在用户自己浏览器里，零封号风险。
    """
    from . import extension_dispatcher

    lives = await db.list_lives()
    if not lives:
        return
    logger.info(f"[live_check] checking {len(lives)} live rooms via extension")

    from . import auth_service
    import json as _json

    online_cache: dict = {}

    def _has_ext(uid):
        if uid not in online_cache:
            online_cache[uid] = extension_dispatcher.has_online_extension(uid)
        return online_cache[uid]

    for live in lives:
        uid = live.get("user_id")
        if not _has_ext(uid):
            continue

        try:
            res = await extension_dispatcher.dispatch_douyin_live_status(
                user_id=uid, live_url=live["room_url"],
            )
        except Exception as e:
            logger.error(f"[live_check] {live['room_url']} dispatch error: {e}")
            continue
        if not res or not res.get("ok"):
            continue
        state = {
            "online": res.get("online_count", 0),
            "gifts": [],
            "streamer_name": "",
            "room_id": "",
        }

        prev_online = int(live.get("last_online") or 0)
        new_online = int(state.get("online") or 0)
        delta = new_online - prev_online
        thr = int(live.get("online_alert_threshold") or 0)

        await db.update_live_check(
            live["id"], online=new_online,
            gifts_json=_json.dumps(state.get("gifts") or [], ensure_ascii=False),
            streamer_name=state.get("streamer_name") or "",
            room_id=state.get("room_id") or "",
        )

        # 涨幅触发告警（推用户自己的 webhook / chat_id）
        if thr > 0 and delta >= thr:
            u = auth_service.get_user_by_id(uid) or {}
            wecom = u.get("wecom_webhook_url", "")
            feishu = u.get("feishu_webhook_url", "")
            chat = u.get("feishu_chat_id", "")
            if wecom or feishu or chat:
                title = f"{state.get('streamer_name') or '直播间'} 在线人数 {prev_online}→{new_online}（+{delta}）"
                try:
                    await notifier.notify_metric(
                        wecom, feishu, title, "", "",
                        "[直播] 涨幅告警",
                        f"房间：{live['room_url']}\n当前在线：{new_online}\n涨幅：+{delta}",
                        feishu_chat_id=chat,
                    )
                except Exception as e:
                    logger.warning(f"[live_check] notify error: {e}")


async def run_cookie_health_check():
    """Deprecated: Pulse 已切扩展通道，cookie 不再驱动抓取流程。"""
    return


async def run_ext_task_retry():
    """扩展任务重试 + 超时清理 worker。

    每次跑：
      1. 把 running 超过 5 分钟还没 ack 的任务回退到 pending
      2. 取 pending 任务，按 user_id 分组，对在线扩展派发
      3. 派完写回 done / failed
      4. 顺便清理 7 天前的 done/failed 任务
    """
    from . import extension_dispatcher
    from ..routers.extension import registry

    # 1. 超时回退
    timed_out = await db.ext_task_running_timeout(timeout_sec=300)
    if timed_out:
        logger.info(f"[ext-retry] reset {timed_out} stuck running tasks → pending")

    # 2. 取 pending 任务，最多 100 条
    pending = await db.ext_task_get_pending(limit=100)
    if pending:
        for task in pending:
            uid = task["user_id"]
            if registry.online_count(uid) == 0:
                continue  # 用户没在线扩展，下轮再说
            await db.ext_task_mark_running(task["id"])
            try:
                ws_task = {"id": str(task["id"]), "type": task["type"], "payload": task["payload"]}
                result = await registry.dispatch(uid, ws_task, timeout=90.0)
                await db.ext_task_mark_done(task["id"], result)
            except Exception as e:
                await db.ext_task_mark_failed(task["id"], str(e))
                logger.warning(f"[ext-retry] task#{task['id']} ({task['type']}) failed: {e}")

    # 3. 清理老任务（每次跑都清，反正是 cheap operation）
    cleaned = await db.ext_task_cleanup_done(older_than_days=7)
    if cleaned:
        logger.info(f"[ext-retry] cleaned {cleaned} old done/failed tasks")


async def run_daily_report():
    """Daily report job：按 user × group 拆分推送（多租户隔离）。

    每个 (user, group) 单独一份日报：
      - webhook 优先级：group 自己配的 > 该用户在 users 表的 webhook
      - 都没配就跳过
    """
    settings = await db.get_all_settings()
    if settings.get("daily_report_enabled", "1") != "1":
        return

    all_posts = await db.get_posts()
    if not all_posts:
        return

    # 按 (user_id, group_id) 分桶
    by_uid_gid: dict = {}
    for p in all_posts:
        key = (p.get("user_id"), p.get("group_id"))
        by_uid_gid.setdefault(key, []).append(p)

    groups = await db.list_groups()
    group_map = {g["id"]: g for g in groups}
    from . import auth_service
    user_cache: dict = {}

    sent = 0
    skipped = 0
    for (uid, gid), posts in by_uid_gid.items():
        group = group_map.get(gid) if gid else None
        # 用户自己的 webhook
        if uid is not None and uid not in user_cache:
            user_cache[uid] = auth_service.get_user_by_id(uid) or {}
        u = user_cache.get(uid) or {}
        wecom = (group.get("wecom_webhook_url") if group else "") or u.get("wecom_webhook_url", "")
        feishu = (group.get("feishu_webhook_url") if group else "") or u.get("feishu_webhook_url", "")
        # group 显式配 webhook 时跳过 chat_id（admin 意图覆盖）
        chat = "" if (group and group.get("feishu_webhook_url")) else (u.get("feishu_chat_id", "") or "")
        if not wecom and not feishu and not chat:
            skipped += 1
            continue

        prefix = (group.get("message_prefix") if group else "") or ""
        group_name = (group.get("name") if group else "未分组")

        await notifier.notify_daily_report(
            wecom_url=wecom,
            feishu_url=feishu,
            rows=posts,
            group_name=group_name,
            prefix=prefix,
            feishu_chat_id=chat,
        )
        sent += 1

    logger.info(f"[daily_report] 共发送 {sent} 份日报（按 user × group 拆分），跳过 {skipped} 桶（无 webhook）")


def _is_usable(acc: dict) -> bool:
    """Active + has cookie + cookie not known-expired. Expired-cookie accounts
    must NOT be used by any fetcher: continuing to send a stale cookie is the
    single fastest way to trip XHS risk control."""
    return bool(
        acc
        and acc.get("is_active")
        and (acc.get("cookie") or (acc.get("fp_browser_type") or "builtin") != "builtin")
        and acc.get("cookie_status") != "expired"
    )


async def _resolve_trending_accounts(settings: dict) -> list:
    """挑选用于热门搜索的账号列表。

    SaaS 模式优先级：
      1) 管理员显式配置 trending_account_ids → 用指定账号
      2) 否则使用平台共享池（is_shared=1）的全部健康账号，按 LRU 排序
      3) 共享池为空时退回到所有 active 账号（兼容老部署）
    """
    ids_csv = settings.get("trending_account_ids", "")
    ids = db.parse_ids_csv(ids_csv)
    accounts: list = []
    if ids:
        for aid in ids:
            acc = await db.get_account(aid)
            if _is_usable(acc):
                accounts.append(acc)
        return accounts

    # 共享池优先，按 last_used_at 升序（LRU）
    shared = await db.get_accounts(include_secrets=True, only_shared=True)
    shared.sort(key=lambda a: (a.get("last_used_at") or "", a.get("id") or 0))
    accounts = [a for a in shared if _is_usable(a)]
    if accounts:
        return accounts

    # 老部署兜底：所有 active 账号都试
    for acc in await db.get_accounts(include_secrets=True):
        if _is_usable(acc):
            accounts.append(acc)
    return accounts


async def run_trending_monitor(platform: Optional[str] = None, user_id: Optional[int] = None):
    """Periodic job: only fetch trending posts by keyword and store them.

    AI rewrite + Bitable sync are now exposed as manual user actions via the API
    and the trending UI — they do not run as part of this scheduled job.

    platform: 可选过滤，传入则只跑指定平台账号（用于前端按平台手动触发）。
    """
    settings = await db.get_all_settings()

    # 多租户：遍历所有 trending_enabled=1 的用户，分别用各自的 keywords / min_likes
    # 抓取（共享账号池 + 共享 admin 配置的 trending_account_ids）。
    from . import auth_service
    if user_id is not None:
        u = auth_service.get_user_by_id(user_id) or {}
        if not u or not u.get("trending_enabled"):
            return
        targets = [u]
    else:
        targets = auth_service.list_users_with_trending()
    if not targets:
        return

    accounts = await _resolve_trending_accounts(settings)
    if platform:
        platform = platform.lower()
        accounts = [a for a in accounts if (a.get("platform") or "xhs").lower() == platform]

    # 扩展通道开关：'1' 强制走扩展、'0' 强制走 cookie、'auto' 优先扩展回退 cookie
    via_ext_mode = (settings.get("trending_via_extension") or "auto").lower()
    from . import extension_dispatcher

    if not accounts and via_ext_mode == "0":
        logger.warning(
            f"[trending] no active accounts configured (platform={platform or 'all'}), skipping"
        )
        return

    enrich = settings.get("trending_enrich_desc", "1") == "1"
    enrich_concurrency = int(settings.get("trending_enrich_concurrency", "3") or "3")

    for tu in targets:
        uid = tu["id"]
        keywords_raw = (tu.get("trending_keywords") or "").strip()
        if not keywords_raw:
            continue
        keywords = [k.strip() for k in keywords_raw.replace("，", ",").split(",") if k.strip()]
        min_likes = int(tu.get("trending_min_likes") or 1000)

        # 该用户的推送渠道（chat_id 优先，webhook 兜底）
        full_user = auth_service.get_user_by_id(uid) or {}
        wecom_url  = full_user.get("wecom_webhook_url", "") or ""
        feishu_url = full_user.get("feishu_webhook_url", "") or ""
        chat_id    = full_user.get("feishu_chat_id", "") or ""

        # 断点续爬：把 keywords 按"上次跑得最早"排前，崩溃恢复后从断点续上
        keys = [f"trending:{uid}:{kw}" for kw in keywords]
        sorted_keys = await db.cursor_sort_by_last_run("trending", keys)
        # 恢复 key → keyword 映射，保持 idx-based 账号轮转
        prefix = f"trending:{uid}:"
        keyword_order = [k[len(prefix):] for k in sorted_keys]

        for idx, keyword in enumerate(keyword_order):
            cursor_key = f"trending:{uid}:{keyword}"

            # 优先尝试扩展通道（'1' 强制 / 'auto' 当用户有在线扩展时）
            use_ext = False
            if via_ext_mode == "1":
                use_ext = True
            elif via_ext_mode == "auto" and extension_dispatcher.has_online_extension(uid):
                use_ext = True

            if use_ext:
                ext_platform = "xhs"  # 当前扩展只实现了 xhs.search；douyin 在 P4 落地后扩展这里
                if platform and platform != ext_platform:
                    # 用户手动指定了非 xhs 平台 → 扩展暂不支持，跳过
                    continue
                await db.cursor_mark_running("trending", cursor_key)
                import time as _t
                _t0 = _t.perf_counter()
                try:
                    res = await extension_dispatcher.dispatch_xhs_search(
                        user_id=uid, keyword=keyword, min_likes=min_likes,
                        timeout_ms=30000, pages=2, overall_timeout=90.0,
                    )
                    _ms = int((_t.perf_counter() - _t0) * 1000)
                    await db.log_fetch(
                        platform=ext_platform, task_type="trending",
                        status="ok" if res.get("ok") else "error",
                        latency_ms=_ms,
                        account_id=None,
                        note=f"user={uid} kw={keyword} via=extension captured={res.get('captured', 0)} new={res.get('inserted', 0)} err={res.get('error','')[:120]}",
                    )
                    await db.cursor_mark_done("trending", cursor_key)
                except Exception as e:
                    logger.error(f"[trending-ext] user={uid} keyword='{keyword}' error: {e}")
                    await db.cursor_mark_failed("trending", cursor_key, str(e))
                continue  # 扩展通道处理完进入下一个 keyword

            # 走原 cookie 账号通道
            if not accounts:
                logger.debug(f"[trending] user={uid} kw={keyword} no online extension, no cookie account; skip")
                continue
            account = accounts[idx % len(accounts)]
            acc_platform = (account.get("platform") or "xhs").lower()
            plat = platform_registry.get_platform(acc_platform)
            if not plat:
                logger.warning(f"[trending] unknown platform '{acc_platform}' for account {account.get('id')}, skipping")
                continue
            await db.cursor_mark_running("trending", cursor_key)
            import time as _t
            _t0 = _t.perf_counter()
            try:
                posts = await plat.search_trending(keyword, account, min_likes)
                _ms = int((_t.perf_counter() - _t0) * 1000)
                await db.log_fetch(
                    platform=acc_platform, task_type="trending",
                    status="ok" if posts else "error",
                    latency_ms=_ms,
                    account_id=account.get("id") if account else None,
                    note=f"user={uid} keyword={keyword} found={len(posts) if posts else 0}",
                )
                if account.get("is_shared"):
                    await db.mark_account_used(account["id"])

                if enrich and posts:
                    await _enrich_trending_descriptions(posts, enrich_concurrency)

                new_posts = []
                for p in posts:
                    import json as _json
                    images_json = _json.dumps(p.get("images") or [], ensure_ascii=False)
                    is_new = await db.add_or_update_trending_post(
                        note_id=p["note_id"], title=p["title"], desc_text=p["desc_text"],
                        note_url=p["note_url"], xsec_token=p["xsec_token"],
                        liked_count=p["liked_count"], collected_count=p["collected_count"],
                        comment_count=p["comment_count"], keyword=keyword, author=p["author"],
                        cover_url=p.get("cover_url", "") or "",
                        images=images_json,
                        video_url=p.get("video_url", "") or "",
                        note_type=p.get("note_type", "normal") or "normal",
                        platform=acc_platform,
                        user_id=uid,
                    )
                    if is_new:
                        new_posts.append(p)
                        # 媒体归档登记（开关 + 阈值在 media_archiver 内部判定）
                        try:
                            await media_archiver.archive_post(
                                user_id=uid, platform=acc_platform,
                                note_id=p["note_id"], note_url=p["note_url"],
                                note_title=p.get("title", ""),
                                author=p.get("author", ""),
                                cover_url=p.get("cover_url", ""),
                                images=p.get("images") or [],
                                video_url=p.get("video_url", ""),
                                liked_count=int(p.get("liked_count", 0) or 0),
                            )
                        except Exception as e:
                            logger.warning(f"[archive] enqueue failed: {e}")

                if new_posts and (wecom_url or feishu_url or chat_id):
                    await notifier.notify_trending(
                        wecom_url, feishu_url, keyword, new_posts,
                        feishu_chat_id=chat_id,
                    )
                await db.cursor_mark_done("trending", cursor_key)
            except Exception as e:
                logger.error(f"[trending] user={uid} keyword='{keyword}' error: {e}")
                await db.cursor_mark_failed("trending", cursor_key, str(e))


async def _enrich_trending_descriptions(posts: list, concurrency: int = 3):
    """Hit each note's detail page to fill in `desc_text` / images / video.

    走匿名通道：xsec_source=app_share + 无 cookie。实测 search 来的 token
    配 app_share 都能拿到完整数据，不消耗任何账号。
    """
    sem = asyncio.Semaphore(max(1, concurrency))
    enriched = 0
    failed = 0

    async def _one(p):
        nonlocal enriched, failed
        async with sem:
            try:
                metrics, status = await fetcher.fetch_note_metrics(
                    p["note_id"],
                    p.get("xsec_token", ""),
                    "app_share",
                    account=None,
                )
                if metrics and metrics.get("desc"):
                    p["desc_text"] = metrics["desc"][:5000]
                    real_title = metrics.get("title") or ""
                    if real_title and len(real_title) > len(p.get("title", "")):
                        p["title"] = real_title
                    # Detail page often has higher-res images + the actual video URL.
                    detail_images = metrics.get("images") or []
                    if detail_images and not p.get("images"):
                        p["images"] = detail_images
                    if metrics.get("cover_url") and not p.get("cover_url"):
                        p["cover_url"] = metrics["cover_url"]
                    if metrics.get("video_url"):
                        p["video_url"] = metrics["video_url"]
                    if metrics.get("note_type") and metrics["note_type"] != "normal":
                        p["note_type"] = metrics["note_type"]
                    enriched += 1
                else:
                    failed += 1
            except Exception as e:
                failed += 1
                logger.warning(f"[trending] enrich {p['note_id']} error: {e}")
            await asyncio.sleep(random.uniform(0.5, 1.2))

    await asyncio.gather(*[_one(p) for p in posts])
    logger.info(f"[trending] enriched desc: {enriched} ok, {failed} skipped (of {len(posts)})")


def _parse_time(t: str):
    try:
        h, m = t.split(":")
        return int(h), int(m)
    except Exception:
        return 9, 0


async def run_creator_dashboard(account_id: Optional[int] = None):
    """每日抓取创作者中心运营数据快照。

    - account_id 给定时只跑该账号；不给跑全平台所有"开启了创作者数据采集"的账号。
    - 默认开关 creator_dashboard_enabled=0；admin 在 settings 里启用后才跑。
    """
    enabled = (await db.get_setting("creator_dashboard_enabled", "0")) == "1"
    if not enabled and account_id is None:
        return
    if account_id:
        accounts = []
        acc = await db.get_account(account_id)
        if acc and acc.get("cookie") and (acc.get("platform") or "xhs") == "xhs":
            accounts = [acc]
    else:
        all_accounts = await db.get_accounts(include_secrets=True)
        accounts = [
            a for a in all_accounts
            if (a.get("platform") or "xhs") == "xhs" and a.get("cookie")
        ]
    if not accounts:
        logger.info("[creator-dash] no eligible accounts")
        return

    from .platforms.xhs.creator_dashboard_fetcher import fetch_creator_dashboard

    for acc in accounts:
        try:
            metrics = await fetch_creator_dashboard(acc)
        except Exception as e:
            logger.warning(f"[creator-dash] account {acc.get('name')} fetch error: {e}")
            continue
        if not metrics:
            continue
        try:
            await db.creator_stats_upsert(
                user_id=acc.get("user_id"),
                account_id=int(acc["id"]),
                platform="xhs",
                snapshot_date=metrics.pop("snapshot_date"),
                raw_json=metrics.pop("raw_json", ""),
                **metrics,
            )
        except Exception as e:
            logger.warning(f"[creator-dash] upsert failed: {e}")


async def run_trial_expiration():
    """把所有过期的 trial 用户降级到 free。每天 00:30 跑一次。"""
    try:
        from . import auth_service, audit_service
        affected = auth_service.downgrade_expired_trials()
        if affected > 0:
            logger.info(f"[trial_expiration] downgraded {affected} trial users to free")
            await audit_service.log(
                action="plan.trial_expired",
                metadata={"affected": affected},
            )
        else:
            logger.debug("[trial_expiration] no expired trial users")
    except Exception as e:
        logger.exception(f"[trial_expiration] failed: {e}")


async def start_scheduler():
    settings = await db.get_all_settings()
    interval = int(settings.get("check_interval_minutes", "30") or "30")
    report_time = settings.get("daily_report_time", "09:00")
    hour, minute = _parse_time(report_time)

    scheduler.add_job(run_monitor, "interval", minutes=interval, id="monitor_posts",
                      replace_existing=True)
    scheduler.add_job(run_daily_report, CronTrigger(hour=hour, minute=minute,
                      timezone="Asia/Shanghai"), id="daily_report", replace_existing=True)
    scheduler.add_job(run_trending_monitor, "interval", minutes=interval,
                      id="trending_monitor", replace_existing=True)
    # 我的帖子的评论独立轮询（跟监控间隔一致；带 cookie 才有效，没绑账号会自动跳过）
    scheduler.add_job(run_own_comments_check, "interval", minutes=interval,
                      id="own_comments_check", replace_existing=True)
    # 博主订阅追新（每 6 小时一次）
    scheduler.add_job(run_creator_check, "interval", hours=6,
                      id="creator_check", replace_existing=True)
    # 直播间状态轮询（每 5 分钟）
    scheduler.add_job(run_live_check, "interval", minutes=5,
                      id="live_check", replace_existing=True)
    # Cookie 健康度探针：已废弃（Pulse 已全面切扩展通道）。
    try:
        scheduler.remove_job("cookie_health")
    except Exception:
        pass

    # 扩展任务重试 + 超时清理：每分钟跑一次
    # 主要场景：扩展离线时排队的任务，扩展上线后被这个 worker 派发
    scheduler.add_job(
        run_ext_task_retry, "interval", minutes=1,
        id="ext_task_retry", replace_existing=True, max_instances=1,
    )
    # 商品图异步上传到七牛：每 1 分钟跑一次，每次最多 3 张
    # 监控任务跟它在一台机器上抢出向带宽（这台 ECS ~5Mbps），所以频率/批量都设保守
    scheduler.add_job(
        image_upload_worker.run_batch, "interval", minutes=1,
        id="image_upload_worker", replace_existing=True,
    )
    # 仿写任务 worker：每 10 秒扫一次，一次取一条 pending 任务跑完。
    # max_instances=1 防止两次心跳之间任务还没跑完就被重复触发。
    scheduler.add_job(
        remix_worker.run_once, "interval", seconds=10,
        id="remix_worker", replace_existing=True, max_instances=1,
    )
    # 试用期到期处理：每天 00:30 跑一次，把过期 trial 用户降级到 free
    scheduler.add_job(
        run_trial_expiration, CronTrigger(hour=0, minute=30, timezone="Asia/Shanghai"),
        id="trial_expiration", replace_existing=True,
    )
    # 媒体归档 worker：每分钟扫一批 pending 行下载 + 上传到对象存储
    scheduler.add_job(
        media_archiver.run_archive_worker, "interval", minutes=1,
        id="media_archiver", replace_existing=True, max_instances=1,
    )
    # 创作者中心运营数据：每天 09:00 抓一次（避开整点小红书更新数据的高峰）
    scheduler.add_job(
        run_creator_dashboard,
        CronTrigger(hour=9, minute=0, timezone="Asia/Shanghai"),
        id="creator_dashboard", replace_existing=True, max_instances=1,
    )
    scheduler.start()
    logger.info(f"[scheduler] started — interval={interval}min, report={report_time}")


def reschedule(interval_minutes: int, report_time: str):
    """check_interval_minutes 改了之后所有 interval 任务都跟着调。"""
    hour, minute = _parse_time(report_time)
    scheduler.reschedule_job("monitor_posts", trigger="interval", minutes=interval_minutes)
    scheduler.reschedule_job("trending_monitor", trigger="interval", minutes=interval_minutes)
    try:
        scheduler.reschedule_job("own_comments_check", trigger="interval", minutes=interval_minutes)
    except Exception:
        pass
    scheduler.reschedule_job("daily_report",
                             trigger=CronTrigger(hour=hour, minute=minute, timezone="Asia/Shanghai"))
