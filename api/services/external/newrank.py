"""
NewRank SaaS 集成（占位 client）。

NewRank（newrank.cn）提供公众号文章/账号/阅读数 API。开通后填 API Key 到 admin 后台。
当前实现仅有签名校验和接口骨架，具体 endpoint 等签约获得 docs 后填充。

实际签约前可以本地填假 key（has_credentials() 返回 True）让公众号 fetcher 走 SaaS 路径
而不是手动凭证模式。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class NewRankClient:
    """新榜开放平台 API 占位 client。

    使用：
        cli = await NewRankClient.from_settings()
        if cli.has_credentials():
            stats = await cli.get_article_stats(biz, mid, idx)
    """

    def __init__(self, api_key: str = "", api_base: str = "https://api.newrank.cn"):
        self.api_key = (api_key or "").strip()
        self.api_base = api_base.rstrip("/")

    @classmethod
    async def from_settings(cls) -> "NewRankClient":
        from .. import monitor_db
        s = await monitor_db.get_all_settings()
        return cls(
            api_key=s.get("newrank_api_key", "") or "",
            api_base=s.get("newrank_api_base", "") or "https://api.newrank.cn",
        )

    def has_credentials(self) -> bool:
        return bool(self.api_key)

    async def _request(self, method: str, path: str, **kwargs) -> Optional[Dict[str, Any]]:
        if not self.has_credentials():
            return None
        url = f"{self.api_base}{path}"
        headers = kwargs.pop("headers", {}) or {}
        headers.setdefault("X-API-Key", self.api_key)
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                resp = await c.request(method, url, headers=headers, **kwargs)
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            logger.warning(f"[newrank] {method} {path} fail: {e}")
            return None

    # ── 待签约后实现的接口（保持稳定签名让上层先接） ─────────────────────────

    async def get_article_stats(self, biz: str, mid: str, idx: str) -> Optional[Dict]:
        """拿一篇文章的阅读数 / 在看数 / 点赞数。

        签约新榜 API 后填具体 endpoint 和参数映射。当前返回 None 表示未实现，
        上层会退回到「让用户手动提供 cookie+key」的 v1 路径。
        """
        # TODO(签约后)：替换成真实 endpoint
        # 示例: data = await self._request("GET", f"/v1/article/stats?biz={biz}&mid={mid}&idx={idx}")
        # return {"read_num": data["readNum"], "like_num": data["likeNum"], ...}
        return None

    async def list_account_articles(self, biz: str, since_ts: Optional[int] = None) -> List[Dict]:
        """拿某公众号最近发的文章列表（用于「博主追新」#11 的核心通道）。"""
        # TODO(签约后)
        return []

    async def search_articles(self, keyword: str, limit: int = 20) -> List[Dict]:
        """关键词搜索文章。"""
        # TODO(签约后)
        return []
