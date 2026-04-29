"""
XHS 平台实现：包装现有 monitor_fetcher（详情）和 trending_fetcher（搜索）。

为什么是 wrapper 而不是 import 重写：
  现有两个 fetcher 已经经过大量线上验证、风控调优、token 失效处理等。
  抽象层只负责调度，不重写底层抓取逻辑。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse, parse_qs

from ..base import Platform
from ... import monitor_fetcher, trending_fetcher


class XHSPlatform(Platform):
    name = "xhs"
    label = "小红书"
    url_hints = ["xiaohongshu.com", "xhslink.com"]

    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        link = (raw_url or "").strip()
        if not link:
            return None

        # 短链或非 xhs 域名（例如微信复制出来的纯 ID 串）走短链 resolver
        if "xhslink.com" in link or "xiaohongshu.com" not in link:
            info = await monitor_fetcher.resolve_short_link(link)
            if not info:
                return None
        else:
            parsed = urlparse(link)
            params = parse_qs(parsed.query)
            parts = parsed.path.strip("/").split("/")
            if len(parts) < 2 or parts[0] != "explore":
                return None
            info = {
                "note_id": parts[1],
                "xsec_token": params.get("xsec_token", [""])[0],
                # 强制 app_share，公开通道
                "xsec_source": "app_share",
                "note_url": link,
            }

        # 不管是哪种来源，xsec_source 都强制 app_share（实测稳定）
        info["xsec_source"] = "app_share"
        return {
            "platform": self.name,
            "post_id": info["note_id"],
            "url": info["note_url"],
            "xsec_token": info.get("xsec_token", ""),
            "xsec_source": info["xsec_source"],
        }

    async def fetch_detail(
        self, post: Dict[str, Any], account: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        return await monitor_fetcher.fetch_note_metrics(
            note_id=post.get("note_id") or post.get("post_id"),
            xsec_token=post.get("xsec_token", ""),
            xsec_source=post.get("xsec_source", "app_share"),
            cookie=post.get("account_cookie"),
            account=account,
        )

    async def search_trending(
        self, keyword: str, account: Dict[str, Any], min_likes: int = 0,
    ) -> List[Dict[str, Any]]:
        # 现有签名：(keyword, account, min_likes)
        return await trending_fetcher.search_trending_notes(keyword, account, min_likes)
