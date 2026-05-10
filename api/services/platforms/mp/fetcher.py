"""
公众号 (mp.weixin.qq.com) 平台实现 - v1：URL 监控 + 静态详情。

通道：mp.weixin.qq.com/s?__biz=...&mid=...&idx=... 完全匿名可达。
HTML 内嵌 JS 全局变量：msg_title / msg_desc / nickname / biz / mid / idx /
                        msg_cdn_url / ct（时间戳）/ copyright_stat / msg_source_url
正文：<div id="js_content"> ... </div>

不实现：
  - search_trending：公众号无公开搜索
  - 阅读数 / 在看数：需要客户端凭证（uin/key/pass_ticket），单独 issue #22
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs, unquote

import httpx

from ..base import Platform

logger = logging.getLogger(__name__)


from .._ua_pool import random_mobile_ua


def _request_headers() -> dict:
    return {
        "User-Agent": random_mobile_ua(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }


def _build_post_id(biz: str, mid: str, idx: str) -> str:
    """公众号文章用 (biz, mid, idx) 三元组唯一标识。拼成单字符串作 note_id。"""
    return f"{biz}__{mid}__{idx}"


def _split_post_id(post_id: str) -> Optional[tuple[str, str, str]]:
    parts = (post_id or "").split("__")
    if len(parts) != 3:
        return None
    return parts[0], parts[1], parts[2]


def _extract_ids_from_url(url: str) -> Optional[Dict[str, str]]:
    """从 mp.weixin.qq.com URL 抽 biz/mid/idx。

    支持两种形态：
      - /s?__biz=xxx&mid=xxx&idx=1&...
      - /s/SHORT_HASH （无参数短链，需要先访问跟随 30x）
    """
    try:
        p = urlparse(url)
    except Exception:
        return None
    if "mp.weixin.qq.com" not in (p.hostname or ""):
        return None
    qs = parse_qs(p.query)
    biz = (qs.get("__biz") or [""])[0]
    mid = (qs.get("mid") or [""])[0]
    idx = (qs.get("idx") or [""])[0]
    if biz and mid and idx:
        return {"biz": biz, "mid": mid, "idx": idx}
    # /s/HASH 形态：没有 query 参数，需要 follow 拿真实 URL
    return None


def _parse_js_var(html: str, name: str) -> str:
    """提取 `var xxx = "..."` / `xxx: "..."` / `var xxx = htmlDecode("...")` 格式的 JS 变量值。"""
    # 优先：var xxx = htmlDecode("...") / decodeURIComponent("...")
    m = re.search(
        rf'var\s+{name}\s*=\s*(?:htmlDecode|decodeURIComponent)\(\s*["\']([^"\']*)["\']\s*\)',
        html,
    )
    if m:
        return m.group(1).strip()
    # 普通：var xxx = '...' 或 var xxx = "..."
    m = re.search(rf'var\s+{name}\s*=\s*["\']([^"\']*)["\']', html)
    if m:
        return m.group(1).strip()
    # 兜底：去掉引号情况
    m = re.search(rf'var\s+{name}\s*=\s*([^;\n]+)\s*;', html)
    if m:
        v = m.group(1).strip().strip("\"'")
        # 再剥一层 htmlDecode("...")
        wrap = re.match(r'(?:htmlDecode|decodeURIComponent)\(\s*["\']([^"\']*)["\']\s*\)', v)
        if wrap:
            return wrap.group(1).strip()
        return v
    return ""


def _strip_html(s: str) -> str:
    """简易 HTML strip。仅用于摘要预览。"""
    s = re.sub(r"<script[^>]*>.*?</script>", " ", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<style[^>]*>.*?</style>", " ", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _extract_body(html: str) -> tuple[str, list[str]]:
    """抽 #js_content 正文和图片列表。返回 (纯文本预览, 图片 URL 列表)"""
    m = re.search(
        r'<div[^>]+id="js_content"[^>]*>(.*?)</div>\s*<(?:div|script)',
        html, re.DOTALL,
    )
    if not m:
        return "", []
    raw = m.group(1)
    # 收集图片
    imgs = re.findall(r'data-src="([^"]+)"', raw) or re.findall(r'src="(https?://mmbiz[^"]+)"', raw)
    return _strip_html(raw), imgs[:20]


async def fetch_article_stats(
    biz: str, mid: str, idx: str,
    uin: str, key: str, pass_ticket: str = "", appmsg_token: str = "",
    user_id: Optional[int] = None,
) -> Optional[Dict[str, int]]:
    """走 /mp/getappmsgext 拿阅读数 / 在看数 / 点赞数 / 打赏 / IP 属地。

    需要客户端凭证（uin / key），key 约 30 分钟过期。
    返回 {"read_num", "like_num", "old_like_num", "reward_total_count", "ip_wording"}
    或 None（凭证无效/失败）。

    user_id 给定时：失败 → 标 mp_auth_status='expired' + 24h 限频推送告警；
                    成功 → 标 mp_auth_status='valid'。
    """
    if not uin or not key:
        return None
    url = "https://mp.weixin.qq.com/mp/getappmsgext"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
            "AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.40"
        ),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    params = {
        "uin": uin, "key": key,
        "pass_ticket": pass_ticket or "",
        "wxtoken": "777",
        "appmsg_token": appmsg_token or "",
        "x5": "0", "f": "json",
    }
    body = {"is_only_read": "1", "is_temp_url": "0", "appmsg_type": "9"}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(url, headers=headers, params=params, data=body)
            data = r.json()
    except Exception as e:
        logger.warning(f"[mp] getappmsgext fail: {e}")
        # 网络异常不视为凭证失效（避免 24h 限频被白白消耗）
        return None
    info = data.get("appmsgstat") or {}
    if not info:
        ret = (data.get("base_resp") or {}).get("ret")
        logger.warning(f"[mp] getappmsgext ret={ret} (凭证可能过期)")
        if user_id is not None:
            await _on_mp_auth_expired(user_id, ret)
        return None
    if user_id is not None:
        await _on_mp_auth_valid(user_id)
    return {
        "read_num":            int(info.get("read_num") or 0),
        "like_num":            int(info.get("like_num") or 0),
        "old_like_num":        int(info.get("old_like_num") or 0),
        "reward_total_count":  int(info.get("reward_total_count") or 0),
        "ip_wording":          (data.get("ip_wording") or {}).get("province_name") or "",
    }


async def _on_mp_auth_valid(user_id: int) -> None:
    """凭证成功一次：把 status 标 valid（旧的 expired 自动恢复）。"""
    try:
        from ... import auth_service
        u = auth_service.get_user_by_id(user_id) or {}
        if (u.get("mp_auth_status") or "unknown") != "valid":
            auth_service.mark_mp_auth_status(user_id, "valid")
    except Exception as e:
        logger.debug(f"[mp] _on_mp_auth_valid failed: {e}")


async def _on_mp_auth_expired(user_id: int, ret_code) -> None:
    """凭证失效：标 expired + 24h 限频推送 webhook。"""
    try:
        from ... import auth_service, notifier
        from datetime import datetime, timedelta

        u = auth_service.get_user_by_id(user_id) or {}
        prev_status = u.get("mp_auth_status") or "unknown"
        notified_at = u.get("mp_auth_expired_notified_at") or ""

        # 距上次推送 < 24h 不再推（标 status 但不发消息）
        suppress = False
        if notified_at:
            try:
                last = datetime.fromisoformat(notified_at)
                if datetime.now() - last < timedelta(hours=24):
                    suppress = True
            except Exception:
                pass

        wecom = u.get("wecom_webhook_url", "") or ""
        feishu = u.get("feishu_webhook_url", "") or ""
        chat = u.get("feishu_chat_id", "") or ""
        has_channel = bool(wecom or feishu or chat)

        # 写状态：第一次失效时同时刷新 notified_at；限频期内只标状态
        auth_service.mark_mp_auth_status(
            user_id, "expired",
            set_notified=(has_channel and not suppress),
        )

        if has_channel and not suppress:
            try:
                await notifier.notify_mp_auth_expired(
                    wecom_url=wecom, feishu_url=feishu,
                    feishu_chat_id=chat, ret_code=ret_code,
                )
            except Exception as e:
                logger.warning(f"[mp] notify expired failed: {e}")

        # 状态首次跳变也写一次日志便于排查
        if prev_status != "expired":
            logger.warning(
                f"[mp] user {user_id} mp_auth marked expired (ret={ret_code})"
            )
    except Exception as e:
        logger.debug(f"[mp] _on_mp_auth_expired failed: {e}")


async def search_sogou_articles(
    nickname: str, max_count: int = 10,
) -> list[Dict[str, str]]:
    """通过搜狗微信搜索拉某个公众号最近文章（零配置，best-effort）。

    返回 [{title, url, published_at, creator_name, post_id}, ...]，
    其中 url 是 mp.weixin.qq.com 真实链接（搜狗的 link?url= 重定向已跟随）。
    """
    if not nickname or not nickname.strip():
        return []
    nickname = nickname.strip()

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    from urllib.parse import quote
    search_url = (
        f"https://weixin.sogou.com/weixin?type=2&query={quote(nickname)}"
    )

    async with httpx.AsyncClient(
        timeout=15, follow_redirects=False, headers=headers,
    ) as c:
        try:
            r = await c.get(search_url)
        except Exception as e:
            logger.warning(f"[mp][sogou] search '{nickname}' fail: {e}")
            return []
        if r.status_code != 200 or "antispider" in r.text or "captcha" in r.text.lower():
            logger.warning(f"[mp][sogou] '{nickname}' 命中风控/验证码 (status={r.status_code})")
            return []
        html = r.text

        # 搜狗结果项：每条 <li id="sogou_vr_..."> 含 <a target="_blank" href="/link?url=..." ...>标题</a>
        # 公众号名在 <a class="account">公众号名</a>
        items = re.findall(
            r'<li[^>]+id="sogou_vr_[^"]*"[^>]*>(.*?)</li>',
            html, re.DOTALL,
        )
        if not items:
            return []

        results: list[Dict[str, str]] = []
        for item_html in items[:max_count * 2]:  # 多取一些后过滤
            # 标题：取 <h3> 内的 <a target="_blank" href="/link?...">...</a>
            t = re.search(
                r'<h3>\s*<a[^>]+href="(/link\?url=[^"]+)"[^>]*>(.*?)</a>',
                item_html, re.DOTALL,
            )
            if not t:
                continue
            link_path = t.group(1).replace("&amp;", "&")
            # 标题里 <em><!--red_beg-->...<!--red_end--></em> 高亮标签要剥
            raw_title = t.group(2)
            raw_title = re.sub(r"<!--red_(beg|end)-->", "", raw_title)
            title = _strip_html(raw_title).strip()
            if not title:
                continue

            # 公众号名（搜狗结构：<span class="all-time-y2">公众号</span>）
            acc_match = re.search(
                r'<span[^>]+class="all-time-y2"[^>]*>([^<]+)</span>',
                item_html,
            )
            if not acc_match:
                # 兼容旧结构 class="account"
                acc_match = re.search(
                    r'<a[^>]+class="account"[^>]*>([^<]+)</a>',
                    item_html,
                )
            account_name = (acc_match.group(1).strip() if acc_match else "")

            # 名称过滤（双向 substring；为空时不过滤）
            if account_name and nickname not in account_name and account_name not in nickname:
                continue

            # 发布时间（timeConvert('1508898314')）
            ts = 0
            ts_match = re.search(r"timeConvert\(['\"](\d{10})['\"]\)", item_html)
            if ts_match:
                try: ts = int(ts_match.group(1))
                except: pass

            # 跟随 sogou 跳转。第一跳是 JS 拼接的签名 URL，再跳一次到真实 /s?__biz=...
            try:
                rr = await c.get("https://weixin.sogou.com" + link_path)
                # 拼出签名 URL
                parts = re.findall(r"url\s*\+=\s*['\"]([^'\"]+)['\"]", rr.text)
                signed_url = "".join(parts) if parts else (rr.headers.get("location") or "")
                if not signed_url or "mp.weixin.qq.com" not in signed_url:
                    continue
                # 第二跳：访问签名 URL 后被重定向到带 __biz/mid/idx 的真实 URL
                async with httpx.AsyncClient(
                    timeout=12, follow_redirects=True, headers=_request_headers(),
                ) as c2:
                    r3 = await c2.get(signed_url)
                    real_url = str(r3.url)
            except Exception as e:
                logger.debug(f"[mp][sogou] follow redirect fail: {e}")
                continue

            ids = _extract_ids_from_url(real_url)
            if not ids:
                # 兜底：从最终 HTML 里抓 biz/mid/idx JS 变量
                try:
                    biz = _parse_js_var(r3.text, "biz") or _parse_js_var(r3.text, "__biz")
                    mid = _parse_js_var(r3.text, "mid")
                    idx = _parse_js_var(r3.text, "idx")
                    if biz and mid and idx:
                        ids = {"biz": biz, "mid": mid, "idx": idx}
                except Exception:
                    pass
            if not ids:
                continue
            post_id = _build_post_id(ids["biz"], ids["mid"], ids["idx"])
            # 重建标准 URL（不带过期签名）
            canonical_url = (
                f"https://mp.weixin.qq.com/s?__biz={ids['biz']}"
                f"&mid={ids['mid']}&idx={ids['idx']}"
            )
            results.append({
                "post_id": post_id,
                "url": canonical_url,
                "title": title[:200],
                "creator_name": account_name,
                "published_at": ts,
                "xsec_token": "",
            })
            if len(results) >= max_count:
                break

        return results


class MpPlatform(Platform):
    name = "mp"
    label = "公众号"
    url_hints = ["mp.weixin.qq.com"]

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        link = (raw_url or "").strip()
        if not link:
            return None

        ids = _extract_ids_from_url(link)
        # 短链 /s/HASH：没 query 参数。微信返回文章 HTML 而非 30x，所以先 follow，
        # 优先看最终 URL 里有没有 query；没有就从 HTML 的 JS 变量里挖 biz/mid/idx
        if not ids:
            try:
                async with httpx.AsyncClient(timeout=12, follow_redirects=True, max_redirects=3) as c:
                    r = await c.get(link, headers=_request_headers())
                    final = str(r.url)
                ids = _extract_ids_from_url(final)
                if ids:
                    link = final
                else:
                    biz = _parse_js_var(r.text, "biz") or _parse_js_var(r.text, "__biz")
                    mid = _parse_js_var(r.text, "mid")
                    idx = _parse_js_var(r.text, "idx")
                    if biz and mid and idx:
                        ids = {"biz": biz, "mid": mid, "idx": idx}
                        # link 保持短链形态可访问；不强行重写
            except Exception as e:
                logger.warning(f"[mp] short-link resolve fail: {e}")
                return None

        if not ids:
            return None
        post_id = _build_post_id(ids["biz"], ids["mid"], ids["idx"])
        return {
            "platform": self.name,
            "post_id": post_id,
            "url": link,
        }

    async def fetch_detail(
        self, post: Dict[str, Any], account: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        # 优先用 post 里存的 URL；没有就根据 post_id 重建
        url = post.get("url") or post.get("note_url")
        if not url:
            ids = _split_post_id(post.get("post_id") or post.get("note_id") or "")
            if not ids:
                return None, "error"
            biz, mid, idx = ids
            url = f"https://mp.weixin.qq.com/s?__biz={biz}&mid={mid}&idx={idx}"

        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, max_redirects=5) as c:
                r = await c.get(url, headers=_request_headers())
        except Exception as e:
            logger.warning(f"[mp] request fail: {e}")
            return None, "error"

        if r.status_code != 200:
            return None, "error"

        text = r.text
        # 文章被删 / 违规
        if "环境异常" in text or "无法查看" in text or "已被发布者删除" in text:
            return None, "deleted"
        # 没有 msg_title 通常说明命中风控验证页
        title = _parse_js_var(text, "msg_title")
        if not title:
            # 兜底：尝试 og:title meta
            m = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', text)
            if m:
                title = m.group(1).strip()
        if not title:
            logger.warning(f"[mp] 无 msg_title, head={text[:160]!r}")
            return None, "error"

        desc = _parse_js_var(text, "msg_desc") or _parse_js_var(text, "msg_link")
        nickname = _parse_js_var(text, "nickname") or _parse_js_var(text, "user_name")
        cdn = _parse_js_var(text, "msg_cdn_url")
        ct = _parse_js_var(text, "ct")  # 发布时间戳（秒）
        copyright_stat = _parse_js_var(text, "copyright_stat")  # "11" = 原创
        source_url = _parse_js_var(text, "msg_source_url")  # 转载来源

        body_preview, body_imgs = _extract_body(text)
        # desc 留 200 字预览，正文最多 5000 给 AI 摘要
        body_for_ai = body_preview[:5000]

        # 阅读数 / 在看数 / 打赏 / IP 属地：走 /mp/getappmsgext 客户端凭证
        read_num = 0
        like_num = 0
        reward_total = 0
        ip_wording = ""
        if account and account.get("mp_auth_uin"):
            ids = _extract_ids_from_url(url)
            if ids:
                stats = await fetch_article_stats(
                    biz=ids["biz"], mid=ids["mid"], idx=ids["idx"],
                    uin=account.get("mp_auth_uin", ""),
                    key=account.get("mp_auth_key", ""),
                    pass_ticket=account.get("mp_auth_pass_ticket", ""),
                    appmsg_token=account.get("mp_auth_appmsg_token", ""),
                    user_id=account.get("user_id"),
                )
                if stats:
                    read_num = stats["read_num"]
                    like_num = stats["like_num"]
                    reward_total = stats.get("reward_total_count", 0) or 0
                    ip_wording = stats.get("ip_wording", "") or ""

        return ({
            "title": title[:200],
            # 正文太长时把摘要+正文都塞 desc 字段（schema 已是 5000 上限）
            "desc": (desc + "\n\n" + body_for_ai).strip()[:5000],
            # 公众号语义复用：liked = 在看（like_num） / collected = 阅读数（read_num）
            "liked_count": like_num,
            "collected_count": read_num,
            "comment_count": 0,
            "share_count": 0,
            "cover_url": cdn,
            "images": body_imgs,
            "video_url": "",
            "note_type": "article",
            "author": nickname,
            "publish_ts": int(ct) if (ct and ct.isdigit()) else 0,
            "copyright_stat": copyright_stat,
            "source_url": source_url,
            "reward_total": reward_total,
            "ip_wording": ip_wording,
        }, "ok")

    async def fetch_creator_posts(
        self, creator_url: str, account: Optional[Dict[str, Any]] = None,
    ) -> list[Dict[str, Any]]:
        """公众号"博主追新"：零配置，走搜狗微信搜索。

        creator_url 字段含义对公众号略宽泛：
          - 公众号昵称（推荐，"测试公众号"）
          - 任意一篇该公众号文章 URL（兜底从 nickname JS 变量提取）

        best-effort：搜狗有风控/验证码、只返回最近 ~10 篇。
        """
        nickname = (creator_url or "").strip()
        if not nickname:
            return []

        # 如果传的是文章 URL，先访问拿 nickname
        if "mp.weixin.qq.com" in nickname:
            try:
                async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
                    r = await c.get(nickname, headers=_request_headers())
                    nickname = _parse_js_var(r.text, "nickname") or _parse_js_var(r.text, "user_name") or ""
            except Exception as e:
                logger.warning(f"[mp] resolve nickname from url fail: {e}")
                return []
            if not nickname:
                return []

        return await search_sogou_articles(nickname, max_count=10)
