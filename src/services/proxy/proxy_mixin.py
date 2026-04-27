# -*- coding: utf-8 -*-
"""
代理自动刷新 Mixin 模块

提供代理 IP 自动刷新功能，供 API 客户端继承使用。

使用方法:
1. API 客户端类继承此 Mixin
2. 在 __init__ 中调用 init_proxy_pool(proxy_ip_pool)
3. 每次请求前调用 await _refresh_proxy_if_expired()

要求:
- 客户端类必须有 self.proxy 属性存储当前代理 URL
"""
from typing import TYPE_CHECKING, Optional

from src.utils import utils

if TYPE_CHECKING:
    from src.services.proxy.proxy_ip_pool import ProxyIpPool


class ProxyRefreshMixin:
    """
    代理自动刷新 Mixin 类

    在每次 HTTP 请求前检查代理是否过期，自动获取新代理。
    """

    _proxy_ip_pool: Optional["ProxyIpPool"] = None

    def init_proxy_pool(self, proxy_ip_pool: Optional["ProxyIpPool"]) -> None:
        """
        初始化代理池引用

        Args:
            proxy_ip_pool: 代理 IP 池实例
        """
        self._proxy_ip_pool = proxy_ip_pool

    async def _refresh_proxy_if_expired(self) -> None:
        """
        检查代理是否过期，过期则自动刷新

        应在每次请求前调用，确保代理有效
        """
        if self._proxy_ip_pool is None:
            return

        if self._proxy_ip_pool.is_current_proxy_expired():
            utils.logger.info(
                f"[{self.__class__.__name__}._refresh_proxy_if_expired] 代理已过期，正在刷新..."
            )
            new_proxy = await self._proxy_ip_pool.get_or_refresh_proxy()
            # 更新 httpx 代理 URL
            if new_proxy.user and new_proxy.password:
                self.proxy = f"http://{new_proxy.user}:{new_proxy.password}@{new_proxy.ip}:{new_proxy.port}"
            else:
                self.proxy = f"http://{new_proxy.ip}:{new_proxy.port}"
            utils.logger.info(
                f"[{self.__class__.__name__}._refresh_proxy_if_expired] 新代理: {new_proxy.ip}:{new_proxy.port}"
            )
