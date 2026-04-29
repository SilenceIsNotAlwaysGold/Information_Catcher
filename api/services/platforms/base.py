"""
Platform 抽象：每个内容平台（xhs / douyin / mp / ...）实现这个协议。

调用约定：
  - resolve_url(raw_url) → 用户粘贴的链接（短链/长链/带 source 参数）解析成
    标准化的 post 元数据：{platform, post_id, title, author, url, share_url, ...}
    返回 None 表示这条 URL 不属于该平台或无法解析。
  - fetch_detail(post, account=None) → 抓详情页。
    account=None 走匿名通道（如果该平台支持）；带 account 的话用其 cookie/代理。
    返回 (metrics_dict, status)，status 取值：
      'ok' / 'login_required' / 'deleted' / 'error'
  - search_trending(keyword, account, min_likes) → 关键词搜索热门内容。
    可选实现（公众号没有公开搜索，可以 raise NotImplementedError）。

每个平台子目录：
  api/services/platforms/{name}/
    __init__.py    导出 Platform 实例
    fetcher.py     实现接口
    parser.py      HTML / JSON 解析
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple


class Platform(ABC):
    """所有平台实现需要继承这个类。"""

    name: str  # 'xhs' / 'douyin' / 'mp'，对应 DB 里 platform 字段
    label: str  # 给前端显示用的中文名

    # 用 URL host/path 关键字匹配。例如 xhs：["xiaohongshu.com", "xhslink.com"]。
    url_hints: List[str] = []

    @classmethod
    def match_url(cls, raw_url: str) -> bool:
        if not raw_url:
            return False
        url_low = raw_url.lower()
        return any(h in url_low for h in cls.url_hints)

    @abstractmethod
    async def resolve_url(self, raw_url: str) -> Optional[Dict[str, Any]]:
        """把用户粘贴的 URL 解析成标准 post dict。"""
        ...

    @abstractmethod
    async def fetch_detail(
        self, post: Dict[str, Any], account: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Optional[Dict[str, Any]], str]:
        """抓详情。返回 (metrics_or_none, status)。"""
        ...

    async def search_trending(
        self, keyword: str, account: Dict[str, Any], min_likes: int = 0,
    ) -> List[Dict[str, Any]]:
        """关键词搜索热门内容。默认未实现，平台可选覆盖。"""
        raise NotImplementedError(f"{self.name} 不支持搜索")
