# -*- coding: utf-8 -*-
"""
爬虫抽象基类模块

定义爬虫框架的核心抽象接口，包括:
- AbstractCrawler: 爬虫基类
- AbstractLogin: 登录基类
- AbstractStore: 存储基类
- AbstractApiClient: API 客户端基类
"""
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Dict, Optional

from playwright.async_api import BrowserContext, BrowserType, Playwright

if TYPE_CHECKING:
    from src.utils.cdp_browser import CDPBrowserManager


class AbstractCrawler(ABC):
    """爬虫抽象基类，定义爬虫的核心接口"""

    @abstractmethod
    async def start(self):
        """启动爬虫"""
        pass

    @abstractmethod
    async def search(self):
        """执行搜索任务"""
        pass

    @abstractmethod
    async def launch_browser(
        self,
        chromium: BrowserType,
        playwright_proxy: Optional[Dict],
        user_agent: Optional[str],
        headless: bool = True,
    ) -> BrowserContext:
        """
        启动浏览器

        Args:
            chromium: Chromium 浏览器实例
            playwright_proxy: 代理配置
            user_agent: 用户代理字符串
            headless: 是否无头模式

        Returns:
            BrowserContext: 浏览器上下文
        """
        pass

    async def launch_browser_with_cdp(
        self,
        playwright: Playwright,
        playwright_proxy: Optional[Dict],
        user_agent: Optional[str],
        headless: bool = True,
    ) -> BrowserContext:
        """
        使用 CDP 模式启动浏览器（可选实现）

        Args:
            playwright: Playwright 实例
            playwright_proxy: 代理配置
            user_agent: 用户代理字符串
            headless: 是否无头模式

        Returns:
            BrowserContext: 浏览器上下文
        """
        # 默认回退到标准模式
        return await self.launch_browser(
            playwright.chromium, playwright_proxy, user_agent, headless
        )


class AbstractLogin(ABC):
    """登录抽象基类，定义多种登录方式的接口"""

    @abstractmethod
    async def begin(self):
        """开始登录流程"""
        pass

    @abstractmethod
    async def login_by_qrcode(self):
        """扫码登录"""
        pass

    @abstractmethod
    async def login_by_mobile(self):
        """手机号登录"""
        pass

    @abstractmethod
    async def login_by_cookies(self):
        """Cookie 登录"""
        pass


class AbstractStore(ABC):
    """存储抽象基类，定义数据持久化接口"""

    @abstractmethod
    async def store_content(self, content_item: Dict):
        """存储内容/帖子数据"""
        pass

    @abstractmethod
    async def store_comment(self, comment_item: Dict):
        """存储评论数据"""
        pass

    @abstractmethod
    async def store_creator(self, creator: Dict):
        """存储创作者数据"""
        pass


class AbstractStoreImage(ABC):
    """图片存储抽象基类"""

    async def store_image(self, image_content_item: Dict):
        """存储图片数据"""
        pass


class AbstractStoreVideo(ABC):
    """视频存储抽象基类"""

    async def store_video(self, video_content_item: Dict):
        """存储视频数据"""
        pass


class AbstractApiClient(ABC):
    """API 客户端抽象基类，定义 HTTP 请求接口"""

    @abstractmethod
    async def request(self, method, url, **kwargs):
        """发送 HTTP 请求"""
        pass

    @abstractmethod
    async def update_cookies(self, browser_context: BrowserContext):
        """从浏览器上下文更新 Cookie"""
        pass
