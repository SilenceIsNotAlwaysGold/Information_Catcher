import logging
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

    if not prev or (not wecom_url and not feishu_url):
        return

    liked_delta     = metrics["liked_count"]     - prev["liked_count"]
    collected_delta = metrics["collected_count"] - prev["collected_count"]
    comment_delta   = metrics["comment_count"]   - prev["comment_count"]
    title = post.get("title") or metrics.get("title") or note_id

    likes_on    = settings.get("likes_alert_enabled",    "1") == "1"
    collects_on = settings.get("collects_alert_enabled", "1") == "1"
    comments_on = settings.get("comments_alert_enabled", "1") == "1"
    likes_thr    = int(settings.get("likes_threshold",    "50") or "50")
    collects_thr = int(settings.get("collects_threshold", "50") or "50")
    comments_thr = int(settings.get("comments_threshold", "1")  or "1")

    if likes_on and liked_delta >= likes_thr:
        await db.save_alert(note_id, title, "likes", f"点赞 +{liked_delta}")
        await notifier.notify_metric(
            wecom_url, feishu_url, title, note_id, post["xsec_token"],
            "点赞飙升", f"点赞 **+{liked_delta}**",
        )

    if collects_on and collected_delta >= collects_thr:
        await db.save_alert(note_id, title, "collects", f"收藏 +{collected_delta}")
        await notifier.notify_metric(
            wecom_url, feishu_url, title, note_id, post["xsec_token"],
            "收藏飙升", f"收藏 **+{collected_delta}**",
        )

    # Fetch actual comment content when threshold triggered
    if comments_on and comment_delta >= comments_thr:
        await db.save_alert(note_id, title, "comment", f"新增评论 {comment_delta} 条")

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
                        wecom_url, feishu_url, title, note_id, post["xsec_token"], new_comments
                    )
                    return
            except Exception as e:
                logger.error(f"[monitor] comment fetch error for {note_id}: {e}")

        # Fallback: just push count
        await notifier.notify_metric(
            wecom_url, feishu_url, title, note_id, post["xsec_token"],
            "新评论", f"新增评论 **{comment_delta}** 条",
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

    # XHS gates the note-detail page behind login for most content now, so an
    # un-bound (observe) post often cannot be fetched anonymously. The user can
    # opt-in to "borrow" any active account's cookie for observe posts, at the
    # cost of routing those requests through their own account (potential risk
    # control implications). Off by default — keep observation traffic anonymous.
    use_fallback = settings.get("observe_use_cookie_fallback", "0") == "1"
    fallback_account = None
    if use_fallback:
        for acc in await db.get_accounts(include_secrets=True):
            if acc.get("is_active") and acc.get("cookie") and acc.get("cookie_status") != "expired":
                fallback_account = acc
                break

    for post in posts:
        try:
            aid = post.get("account_id")
            account = account_cache.get(aid) if aid else None
            if account is None and use_fallback:
                account = fallback_account
            post["_account"] = account
            await _check_post(post, settings, wecom_url, feishu_url)
        except Exception as e:
            logger.error(f"[monitor] error on {post['note_id']}: {e}")


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
    """Daily report job."""
    settings = await db.get_all_settings()
    if settings.get("daily_report_enabled", "1") != "1":
        return
    wecom_url  = settings.get("webhook_url", "")
    feishu_url = settings.get("feishu_webhook_url", "")
    if not wecom_url and not feishu_url:
        return
    posts = await db.get_posts()
    await notifier.notify_daily_report(wecom_url, feishu_url, posts)


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
    """Return full account records to use for trending searches.

    Picks those listed in `trending_account_ids`; falls back to all active accounts.
    Expired-cookie accounts are excluded — using them only triggers risk control.
    """
    ids_csv = settings.get("trending_account_ids", "")
    ids = db.parse_ids_csv(ids_csv)
    accounts: list = []
    if ids:
        for aid in ids:
            acc = await db.get_account(aid)
            if _is_usable(acc):
                accounts.append(acc)
    else:
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

    for idx, keyword in enumerate(keywords):
        account = accounts[idx % len(accounts)]
        try:
            posts = await trending_fetcher.search_trending_notes(keyword, account, min_likes)
            new_posts = []
            for p in posts:
                is_new = await db.add_or_update_trending_post(
                    note_id=p["note_id"], title=p["title"], desc_text=p["desc_text"],
                    note_url=p["note_url"], xsec_token=p["xsec_token"],
                    liked_count=p["liked_count"], collected_count=p["collected_count"],
                    comment_count=p["comment_count"], keyword=keyword, author=p["author"],
                )
                if is_new:
                    new_posts.append(p)

            if new_posts and (wecom_url or feishu_url):
                await notifier.notify_trending(wecom_url, feishu_url, keyword, new_posts)
        except Exception as e:
            logger.error(f"[trending] error for keyword '{keyword}': {e}")


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
