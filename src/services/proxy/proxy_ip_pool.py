# -*- coding: utf-8 -*-
"""
代理 IP 池模块

管理代理 IP 的获取、验证、刷新等功能。
"""
import random
from typing import Dict, List

import httpx
from tenacity import retry, stop_after_attempt, wait_fixed

import config
from src.services.proxy.providers import (
    new_kuai_daili_proxy,
    new_wandou_http_proxy,
)
from src.utils import utils

from .base_proxy import ProxyProvider
from .types import IpInfoModel, ProviderNameEnum


class ProxyIpPool:
    """代理 IP 池，提供代理的加载、验证、获取和刷新功能"""

    def __init__(
        self, ip_pool_count: int, enable_validate_ip: bool, ip_provider: ProxyProvider
    ) -> None:
        """
        初始化代理 IP 池

        Args:
            ip_pool_count: IP 池大小
            enable_validate_ip: 是否验证 IP 有效性
            ip_provider: IP 代理提供商实例
        """
        self.valid_ip_url = "https://echo.apifox.cn/"  # 用于验证 IP 有效性的 URL
        self.ip_pool_count = ip_pool_count
        self.enable_validate_ip = enable_validate_ip
        self.proxy_list: List[IpInfoModel] = []
        self.ip_provider: ProxyProvider = ip_provider
        self.current_proxy: IpInfoModel | None = None  # 当前使用的代理

    async def load_proxies(self) -> None:
        """加载代理 IP 到池中"""
        self.proxy_list = await self.ip_provider.get_proxy(self.ip_pool_count)

    async def _is_valid_proxy(self, proxy: IpInfoModel) -> bool:
        """
        验证代理 IP 是否有效

        Args:
            proxy: 代理 IP 信息

        Returns:
            bool: 是否有效
        """
        utils.logger.info(f"[ProxyIpPool._is_valid_proxy] 正在验证 {proxy.ip} 是否有效...")
        try:
            # httpx 0.28.1 需要直接传代理 URL 字符串
            if proxy.user and proxy.password:
                proxy_url = f"http://{proxy.user}:{proxy.password}@{proxy.ip}:{proxy.port}"
            else:
                proxy_url = f"http://{proxy.ip}:{proxy.port}"

            async with httpx.AsyncClient(proxy=proxy_url) as client:
                response = await client.get(self.valid_ip_url)
            return response.status_code == 200
        except Exception as e:
            utils.logger.info(f"[ProxyIpPool._is_valid_proxy] 验证 {proxy.ip} 失败: {e}")
            raise e

    @retry(stop=stop_after_attempt(3), wait=wait_fixed(1))
    async def get_proxy(self) -> IpInfoModel:
        """
        从代理池中随机获取一个代理 IP

        Returns:
            IpInfoModel: 代理 IP 信息
        """
        if len(self.proxy_list) == 0:
            await self._reload_proxies()

        proxy = random.choice(self.proxy_list)
        self.proxy_list.remove(proxy)  # 取出后从池中移除
        if self.enable_validate_ip:
            if not await self._is_valid_proxy(proxy):
                raise Exception("[ProxyIpPool.get_proxy] 当前 IP 无效，重新获取")
        self.current_proxy = proxy  # 保存当前使用的代理
        return proxy

    def is_current_proxy_expired(self, buffer_seconds: int = 30) -> bool:
        """
        检查当前代理是否已过期

        Args:
            buffer_seconds: 缓冲时间（秒），提前多少秒视为过期

        Returns:
            bool: True 表示已过期或无当前代理，False 表示仍有效
        """
        if self.current_proxy is None:
            return True
        return self.current_proxy.is_expired(buffer_seconds)

    async def get_or_refresh_proxy(self, buffer_seconds: int = 30) -> IpInfoModel:
        """
        获取当前代理，过期则自动刷新

        应在每次请求前调用，确保代理有效

        Args:
            buffer_seconds: 缓冲时间（秒），提前多少秒视为过期

        Returns:
            IpInfoModel: 有效的代理 IP 信息
        """
        if self.is_current_proxy_expired(buffer_seconds):
            utils.logger.info(
                "[ProxyIpPool.get_or_refresh_proxy] 当前代理已过期或未设置，正在获取新代理..."
            )
            return await self.get_proxy()
        return self.current_proxy

    async def _reload_proxies(self):
        """重新加载代理池"""
        self.proxy_list = []
        await self.load_proxies()


# 代理服务商映射
IpProxyProvider: Dict[str, ProxyProvider] = {
    ProviderNameEnum.KUAI_DAILI_PROVIDER.value: new_kuai_daili_proxy(),
    ProviderNameEnum.WANDOU_HTTP_PROVIDER.value: new_wandou_http_proxy(),
}


async def create_ip_pool(ip_pool_count: int, enable_validate_ip: bool) -> ProxyIpPool:
    """
    创建代理 IP 池

    Args:
        ip_pool_count: IP 池大小
        enable_validate_ip: 是否启用 IP 验证

    Returns:
        ProxyIpPool: 代理 IP 池实例
    """
    pool = ProxyIpPool(
        ip_pool_count=ip_pool_count,
        enable_validate_ip=enable_validate_ip,
        ip_provider=IpProxyProvider.get(config.IP_PROXY_PROVIDER_NAME),
    )
    await pool.load_proxies()
    return pool


if __name__ == "__main__":
    pass
