# -*- coding: utf-8 -*-
"""
路由模块初始化

导出所有API路由：
- auth_router: 认证相关（登录、登出、用户信息）
- crawler_router: 爬虫控制（启动、停止、状态）
- data_router: 数据管理（文件列表、预览、下载）
- websocket_router: WebSocket实时通信
- publisher_router: 笔记发布（小红书）
"""

from .auth import router as auth_router
from .crawler import router as crawler_router
from .data import router as data_router
from .websocket import router as websocket_router
from .publisher import router as publisher_router
from .monitor import router as monitor_router
from .dashboard_overview import router as dashboard_overview_router
from .health_ops import router as health_ops_router
from .global_search import router as global_search_router
from .image_gen import router as image_gen_router
from .feishu import router as feishu_router
from .extension import router as extension_router
from .archive import router as archive_router
from .creator_stats import router as creator_stats_router

__all__ = [
    "auth_router", "crawler_router", "data_router", "websocket_router",
    "publisher_router", "monitor_router",
    "dashboard_overview_router", "health_ops_router",
    "global_search_router", "image_gen_router", "feishu_router",
    "extension_router", "archive_router", "creator_stats_router",
]
