import asyncio
import logging
import random
import aiosqlite
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from . import monitor_db as db
from . import monitor_fetcher as fetcher
from . import notifier
from . import trending_fetcher
from . import comment_fetcher
from . import cookie_health

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")


async def _check_post(post: dict, settings: dict, wecom_url: str, feishu_url: str):
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

    metrics, fetch_status = await fetcher.fetch_note_metrics(
        note_id,
        post["xsec_token"],
        post.get("xsec_source", "app_share"),
        cookie=post.get("account_cookie"),
        account=account,
    )
    await db.update_post_fetch_status(note_id, fetch_status)
    if not metrics:
        logger.warning(f"[monitor] failed to fetch {note_id} ({fetch_status})")
        return

    if not post.get("title") and metrics.get("title"):
        async with aiosqlite.connect(db.DB_PATH) as conn:
            await conn.execute(
                "UPDATE monitor_posts SET title=? WHERE note_id=?",
                (metrics["title"], note_id),
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

    def _bool_setting(group_val, setting_key: str, default: str = "1") -> bool:
        if group is not None and group_val is not None:
            return bool(group_val)
        return settings.get(setting_key, default) == "1"

    def _int_setting(group_val, setting_key: str, default: str) -> int:
        if group is not None and group_val is not None:
            return int(group_val)
        return int(settings.get(setting_key, default) or default)

    likes_on    = _bool_setting(group and group.get("likes_alert_enabled"),    "likes_alert_enabled")
    collects_on = _bool_setting(group and group.get("collects_alert_enabled"), "collects_alert_enabled")
    comments_on = _bool_setting(group and group.get("comments_alert_enabled"), "comments_alert_enabled")
    likes_thr    = _int_setting(group and group.get("likes_threshold"),    "likes_threshold",    "50")
    collects_thr = _int_setting(group and group.get("collects_threshold"), "collects_threshold", "50")
    comments_thr = _int_setting(group and group.get("comments_threshold"), "comments_threshold", "1")

    # Group-specific webhooks (fall back to global)
    g_wecom  = (group.get("wecom_webhook_url")  if group else "") or wecom_url
    g_feishu = (group.get("feishu_webhook_url") if group else "") or feishu_url

    if not g_wecom and not g_feishu:
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
    if likes_on and liked_delta >= likes_thr:
        await db.save_alert(note_id, title, "likes", f"点赞 +{liked_delta}", user_id=post_user_id)
        body = _fmt(group and group.get("template_likes"),
                    "「{title}」点赞 **+{liked_delta}**（当前 {liked_count}）")
        await notifier.notify_metric(
            g_wecom, g_feishu, title, note_id, post["xsec_token"],
            f"{prefix}点赞飙升".strip(), body,
        )

    if collects_on and collected_delta >= collects_thr:
        await db.save_alert(note_id, title, "collects", f"收藏 +{collected_delta}", user_id=post_user_id)
        body = _fmt(group and group.get("template_collects"),
                    "「{title}」收藏 **+{collected_delta}**（当前 {collected_count}）")
        await notifier.notify_metric(
            g_wecom, g_feishu, title, note_id, post["xsec_token"],
            f"{prefix}收藏飙升".strip(), body,
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
        )


async def run_monitor():
    """Periodic job: check all active monitored posts."""
    settings = await db.get_all_settings()
    wecom_url  = settings.get("webhook_url", "")
    feishu_url = settings.get("feishu_webhook_url", "")

    posts = await db.get_active_posts()
    logger.info(f"[monitor] checking {len(posts)} posts")

    # Pre-load distinct accounts to avoid one DB query per post (N+1).
    account_cache: dict = {}
    for post in posts:
        aid = post.get("account_id")
        if aid and aid not in account_cache:
            acc = await db.get_account(aid)
            account_cache[aid] = acc  # may be None if deleted

    # 帖子抓取的账号策略（基于调研结论简化）：
    #   - 帖子绑定了具体 account_id（"我的帖子"组）→ 用那个账号
    #   - 其他情况一律匿名抓（xsec_source 在 add_post 时强制写为 app_share，
    #     公开可达，不消耗任何账号）
    # 调研：search 来的 token 配 app_share + 无 cookie，详情、图片、视频都能拿到。
    skipped = 0
    for post in posts:
        # 已经连续失败 N 次的帖子直接跳过，避免持续打无效请求
        if (post.get("fail_count") or 0) >= db.DEAD_POST_FAIL_THRESHOLD:
            skipped += 1
            continue
        try:
            aid = post.get("account_id")
            account = account_cache.get(aid) if aid else None
            post["_account"] = account
            await _check_post(post, settings, wecom_url, feishu_url)
        except Exception as e:
            logger.error(f"[monitor] error on {post['note_id']}: {e}")
    if skipped:
        logger.info(f"[monitor] skipped {skipped} posts marked as dead (fail_count >= {db.DEAD_POST_FAIL_THRESHOLD})")


async def run_cookie_health_check():
    """Daily job: probe each active account's cookie. Notify on transition to expired."""
    settings = await db.get_all_settings()
    wecom_url  = settings.get("webhook_url", "")
    feishu_url = settings.get("feishu_webhook_url", "")

    accounts = await db.get_accounts(include_secrets=True)
    newly_expired: list = []
    for acc in accounts:
        if not acc.get("is_active"):
            continue
        prev = acc.get("cookie_status") or "unknown"
        new_status = await cookie_health.check_cookie(acc)
        await db.update_cookie_status(acc["id"], new_status)
        logger.info(f"[cookie_check] {acc.get('name')}: {prev} -> {new_status}")
        if new_status == "expired" and prev != "expired":
            newly_expired.append(acc.get("name") or f"#{acc['id']}")

    if newly_expired and (wecom_url or feishu_url):
        await notifier.notify_cookie_expired(wecom_url, feishu_url, newly_expired)


async def run_daily_report():
    """Daily report job：按 group 拆分推送。

    每个 monitor_group 的 posts 单独形成一份日报，发到该 group 的 webhook；
    group 没配 webhook 时回退到全局 settings.feishu_webhook_url / webhook_url。
    """
    settings = await db.get_all_settings()
    if settings.get("daily_report_enabled", "1") != "1":
        return

    global_wecom  = settings.get("webhook_url", "")
    global_feishu = settings.get("feishu_webhook_url", "")

    # admin 视角拿所有 posts（含 group_id 与 group_name），不传 user_id 不过滤租户
    all_posts = await db.get_posts()
    if not all_posts:
        return

    # 按 group_id 分桶；group_id 缺失（极少）的归到 "未分组"
    by_group: dict = {}
    for p in all_posts:
        gid = p.get("group_id")
        by_group.setdefault(gid, []).append(p)

    # 拿所有 group 的配置
    groups = await db.list_groups()
    group_map = {g["id"]: g for g in groups}

    sent = 0
    for gid, posts in by_group.items():
        group = group_map.get(gid) if gid else None
        # 选择 webhook：group 自己有 → 用 group 的；否则用全局
        wecom = (group.get("wecom_webhook_url") if group else "") or global_wecom
        feishu = (group.get("feishu_webhook_url") if group else "") or global_feishu
        if not wecom and not feishu:
            logger.info(f"[daily_report] 跳过 group={gid}（{len(posts)} posts，无 webhook）")
            continue

        prefix = (group.get("message_prefix") if group else "") or ""
        group_name = (group.get("name") if group else "未分组")

        await notifier.notify_daily_report(
            wecom_url=wecom,
            feishu_url=feishu,
            rows=posts,
            group_name=group_name,
            prefix=prefix,
        )
        sent += 1

    logger.info(f"[daily_report] 共发送 {sent} 份日报（按 group 拆分）")


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


async def run_trending_monitor():
    """Periodic job: only fetch trending posts by keyword and store them.

    AI rewrite + Bitable sync are now exposed as manual user actions via the API
    and the trending UI — they do not run as part of this scheduled job.
    """
    settings = await db.get_all_settings()
    if settings.get("trending_enabled", "0") != "1":
        return

    keywords_raw = settings.get("trending_keywords", "")
    if not keywords_raw.strip():
        return

    keywords = [k.strip() for k in keywords_raw.replace("，", ",").split(",") if k.strip()]
    min_likes = int(settings.get("trending_min_likes", "1000") or "1000")
    wecom_url  = settings.get("webhook_url", "")
    feishu_url = settings.get("feishu_webhook_url", "")

    accounts = await _resolve_trending_accounts(settings)
    if not accounts:
        logger.warning("[trending] no active accounts configured, skipping")
        return

    # Auto-fetch the body text after search? Search API only returns titles, so
    # we hit each note's detail page to get desc_text. Costs N extra requests
    # per keyword — controlled with a setting so it can be turned off if the
    # account starts hitting risk control.
    enrich = settings.get("trending_enrich_desc", "1") == "1"
    enrich_concurrency = int(settings.get("trending_enrich_concurrency", "3") or "3")

    for idx, keyword in enumerate(keywords):
        account = accounts[idx % len(accounts)]
        try:
            posts = await trending_fetcher.search_trending_notes(keyword, account, min_likes)
            if account.get("is_shared"):
                await db.mark_account_used(account["id"])

            # Step 1: backfill desc by hitting each note page (concurrent + capped).
            # 走匿名通道（app_share + 无 cookie），不消耗账号。
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
                )
                if is_new:
                    new_posts.append(p)

            if new_posts and (wecom_url or feishu_url):
                await notifier.notify_trending(wecom_url, feishu_url, keyword, new_posts)
        except Exception as e:
            logger.error(f"[trending] error for keyword '{keyword}': {e}")


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
    # Cookie health probe — paused during the "新号静置实验" so the new account
    # is not touched by our system at all. Re-enable when we know whether the
    # warning was caused by our access pattern or by external multi-device login.
    # scheduler.add_job(run_cookie_health_check,
    #                   CronTrigger(hour=9, minute=0, timezone="Asia/Shanghai"),
    #                   id="cookie_health", replace_existing=True)
    scheduler.start()
    logger.info(f"[scheduler] started — interval={interval}min, report={report_time}")


def reschedule(interval_minutes: int, report_time: str):
    hour, minute = _parse_time(report_time)
    scheduler.reschedule_job("monitor_posts", trigger="interval", minutes=interval_minutes)
    scheduler.reschedule_job("trending_monitor", trigger="interval", minutes=interval_minutes)
    scheduler.reschedule_job("daily_report",
                             trigger=CronTrigger(hour=hour, minute=minute, timezone="Asia/Shanghai"))
