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

    # Group-specific webhooks (fall back to global)
    g_wecom  = (group.get("wecom_webhook_url")  if group else "") or wecom_url
    g_feishu = (group.get("feishu_webhook_url") if group else "") or feishu_url
    # 飞书群 chat_id：仅当 group 没显式配置 webhook 时才走 chat_id（避免 admin 显式
    # 路由到特定群的意图被忽略）。group 有 webhook = 显式覆盖，跳过 chat_id。
    g_feishu_chat = "" if (group and group.get("feishu_webhook_url")) else feishu_chat_id

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
    """独立轮询绑定了 account_id 的「我的帖子」组的评论。

    跟 _check_post 内的 alert-driven 拉评论不同，这个任务定期主动拉，
    第一时间发现新评论（时效性比靠涨幅触发好得多）。
    """
    settings = await db.get_all_settings()
    if settings.get("own_comments_enabled", "1") != "1":
        return
    if settings.get("comments_fetch_enabled", "0") != "1":
        return

    posts = await db.get_active_posts()
    own_posts = [p for p in posts if p.get("account_id") and (p.get("platform") or "xhs") in ("xhs", "douyin")]
    if not own_posts:
        return
    logger.info(f"[own_comments] checking {len(own_posts)} 我的帖子")

    from . import auth_service
    new_total = 0
    for post in own_posts:
        try:
            account = await db.get_account(post["account_id"])
            if not account or account.get("cookie_status") == "expired":
                continue
            raw_comments = await comment_fetcher.fetch_note_comments(
                post["note_id"], post.get("xsec_token", ""), account, max_count=20,
            )
            new_comments = await db.add_note_comments(post["note_id"], raw_comments)
            if not new_comments:
                continue
            new_total += len(new_comments)
            # 推送给该用户
            uid = post.get("user_id")
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
                platform=post.get("platform") or "xhs",
                task_type="comment", status="ok",
                account_id=post["account_id"], note_id=post["note_id"],
                note=f"new={len(new_comments)}",
            )
        except Exception as e:
            logger.error(f"[own_comments] error on {post['note_id']}: {e}")
            await db.log_fetch(
                platform="xhs", task_type="comment", status="error",
                account_id=post.get("account_id"), note_id=post["note_id"],
                note=str(e)[:200],
            )
    if new_total:
        logger.info(f"[own_comments] 新增 {new_total} 条评论")


async def run_creator_check():
    """博主订阅追新：定时遍历 monitor_creators，把新发的帖子拉进监控列表。"""
    creators = await db.list_creators()
    if not creators:
        return
    logger.info(f"[creator_check] checking {len(creators)} creators")

    # 每个用户的抖音/XHS 账号缓存（追新需要登录账号）
    douyin_accounts_by_uid: dict = {}
    xhs_accounts_by_uid: dict = {}

    for creator in creators:
        plat = platform_registry.get_platform(creator.get("platform") or "xhs")
        if not plat:
            continue
        uid = creator.get("user_id")

        account = None
        if creator.get("platform") == "douyin":
            if uid not in douyin_accounts_by_uid:
                accs = await db.get_accounts(
                    include_secrets=True, user_id=uid, platform="douyin",
                )
                douyin_accounts_by_uid[uid] = next(
                    (a for a in accs if a.get("cookie")), None,
                )
            account = douyin_accounts_by_uid.get(uid)
            if not account:
                continue  # 没账号直接跳过
        elif creator.get("platform") == "xhs":
            if uid not in xhs_accounts_by_uid:
                accs = await db.get_accounts(
                    include_secrets=True, user_id=uid, platform="xhs",
                )
                xhs_accounts_by_uid[uid] = next(
                    (a for a in accs if a.get("cookie")), None,
                )
            account = xhs_accounts_by_uid.get(uid)
            if not account:
                continue  # 没账号直接跳过

        try:
            posts = await plat.fetch_creator_posts(creator["creator_url"], account=account)
        except NotImplementedError:
            continue
        except Exception as e:
            logger.error(f"[creator_check] {creator['creator_url']} error: {e}")
            continue

        last_post_id = creator.get("last_post_id") or ""
        newest = last_post_id
        added = 0
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
                    platform=plat.name,
                )
                added += 1
                if not newest:
                    newest = pid
            except Exception as e:
                logger.debug(f"[creator_check] add_post {pid} skipped: {e}")

        await db.update_creator_check(
            creator["id"], last_post_id=newest,
            creator_name=(posts[0].get("creator_name", "") if posts else ""),
        )
        if added:
            logger.info(f"[creator_check] {creator.get('creator_name') or creator['creator_url']} +{added} 新帖")


async def run_live_check():
    """直播间监控 v1：每个 live 拉一次 enter API；在线人数涨幅超阈值告警。"""
    lives = await db.list_lives()
    if not lives:
        return
    logger.info(f"[live_check] checking {len(lives)} live rooms")

    from .platforms.douyin import live_fetcher
    from . import auth_service
    import json as _json

    douyin_accs_by_uid: dict = {}

    for live in lives:
        uid = live.get("user_id")
        if uid not in douyin_accs_by_uid:
            accs = await db.get_accounts(
                include_secrets=True, user_id=uid, platform="douyin",
            )
            douyin_accs_by_uid[uid] = next(
                (a for a in accs if a.get("cookie")), None,
            )
        account = douyin_accs_by_uid.get(uid)
        if not account:
            continue

        try:
            state = await live_fetcher.fetch_live_state(live["room_url"], account)
        except Exception as e:
            logger.error(f"[live_check] {live['room_url']} error: {e}")
            continue
        if not state:
            continue

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
    """Cookie 健康度探针（按租户分发推送）。

    流程：
      1) 遍历所有 active 账号 → 调 cookie_health.check_cookie 拿到 valid/expired/unknown
      2) 写回 cookie_status + cookie_last_check
      3) 把「这次新转 expired」的账号按 user_id 分桶
         - 普通用户桶：用该用户在 users 表里配置的 wecom/feishu webhook
         - 共享池桶（is_shared=1，user_id 缺失/为 0）：fallback 到 settings 的全局 webhook
      4) 每桶单独发一次 notify_cookie_expired，避免把 A 用户的过期账号推给 B 用户
    """
    from . import auth_service

    settings = await db.get_all_settings()
    global_wecom  = settings.get("webhook_url", "")
    global_feishu = settings.get("feishu_webhook_url", "")

    accounts = await db.get_accounts(include_secrets=True)
    # newly_expired_by_uid：键 None 留给共享池/无主账号 → 走全局 webhook
    newly_expired_by_uid: dict = {}

    for acc in accounts:
        if not acc.get("is_active"):
            continue
        prev = acc.get("cookie_status") or "unknown"
        new_status = await cookie_health.check_cookie(acc)
        await db.update_cookie_status(acc["id"], new_status)
        logger.info(f"[cookie_check] {acc.get('name')}: {prev} -> {new_status}")

        if new_status == "expired" and prev != "expired":
            display = acc.get("name") or f"#{acc['id']}"
            uid = acc.get("user_id")
            # 共享池 / 老数据（user_id=0 或 NULL）统一归到 None 桶
            if acc.get("is_shared") or not uid:
                bucket_key = None
            else:
                bucket_key = int(uid)
            newly_expired_by_uid.setdefault(bucket_key, []).append(display)

    if not newly_expired_by_uid:
        return

    user_cache: dict = {}
    for uid, names in newly_expired_by_uid.items():
        if uid is None:
            wecom = global_wecom
            feishu = global_feishu
            chat = ""
        else:
            if uid not in user_cache:
                user_cache[uid] = auth_service.get_user_by_id(uid) or {}
            u = user_cache[uid]
            wecom = u.get("wecom_webhook_url", "") or ""
            feishu = u.get("feishu_webhook_url", "") or ""
            chat = u.get("feishu_chat_id", "") or ""

        wecom_sent = 0
        feishu_sent = 0
        if wecom or feishu or chat:
            try:
                await notifier.notify_cookie_expired(wecom, feishu, names, feishu_chat_id=chat)
                wecom_sent = 1 if wecom else 0
                feishu_sent = 1 if (feishu or chat) else 0
            except Exception as e:
                logger.warning(f"[cookie_check] notify error tenant={uid}: {e}")
        logger.info(
            f"[cookie_check] tenant={uid} expired={names} "
            f"→ wecom_sent={wecom_sent} feishu_sent={feishu_sent}"
        )


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


async def run_trending_monitor(platform: Optional[str] = None):
    """Periodic job: only fetch trending posts by keyword and store them.

    AI rewrite + Bitable sync are now exposed as manual user actions via the API
    and the trending UI — they do not run as part of this scheduled job.

    platform: 可选过滤，传入则只跑指定平台账号（用于前端按平台手动触发）。
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
    if platform:
        platform = platform.lower()
        accounts = [a for a in accounts if (a.get("platform") or "xhs").lower() == platform]
    if not accounts:
        logger.warning(
            f"[trending] no active accounts configured (platform={platform or 'all'}), skipping"
        )
        return

    # Auto-fetch the body text after search? Search API only returns titles, so
    # we hit each note's detail page to get desc_text. Costs N extra requests
    # per keyword — controlled with a setting so it can be turned off if the
    # account starts hitting risk control.
    enrich = settings.get("trending_enrich_desc", "1") == "1"
    enrich_concurrency = int(settings.get("trending_enrich_concurrency", "3") or "3")

    # 按账号 platform 路由（xhs 用 XHS 搜索，douyin 用抖音搜索）
    for idx, keyword in enumerate(keywords):
        account = accounts[idx % len(accounts)]
        acc_platform = (account.get("platform") or "xhs").lower()
        plat = platform_registry.get_platform(acc_platform)
        if not plat:
            logger.warning(f"[trending] unknown platform '{acc_platform}' for account {account.get('id')}, skipping")
            continue
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
                note=f"keyword={keyword} found={len(posts) if posts else 0}",
            )
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
                    platform=acc_platform,
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
    # 我的帖子的评论独立轮询（跟监控间隔一致；带 cookie 才有效，没绑账号会自动跳过）
    scheduler.add_job(run_own_comments_check, "interval", minutes=interval,
                      id="own_comments_check", replace_existing=True)
    # 博主订阅追新（每 6 小时一次）
    scheduler.add_job(run_creator_check, "interval", hours=6,
                      id="creator_check", replace_existing=True)
    # 直播间状态轮询（每 5 分钟）
    scheduler.add_job(run_live_check, "interval", minutes=5,
                      id="live_check", replace_existing=True)
    # Cookie 健康度探针：每 6 小时跑一次，按 user_id 分桶推送 webhook。
    # 间隔不能太短，否则探测请求本身可能触发风控；6h 兼顾及时性 + 安全性。
    scheduler.add_job(
        run_cookie_health_check,
        CronTrigger(hour="*/6", minute=0, timezone="Asia/Shanghai"),
        id="cookie_health", replace_existing=True,
    )
    # 商品图异步上传到七牛：每 1 分钟跑一次，每次最多 3 张
    # 监控任务跟它在一台机器上抢出向带宽（这台 ECS ~5Mbps），所以频率/批量都设保守
    scheduler.add_job(
        image_upload_worker.run_batch, "interval", minutes=1,
        id="image_upload_worker", replace_existing=True,
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
