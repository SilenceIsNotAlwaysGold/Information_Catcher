# -*- coding: utf-8 -*-
"""飞书集成（OAuth 绑定 + 应用机器人 + 多维表格）。

模块：
- client    通用 HTTP 客户端、tenant_access_token 缓存、错误封装
- oauth     OAuth 网页授权（authorize / code 换 token / refresh / user_info）

后续阶段会扩展 chat / bitable / provisioning。
"""
from .client import FeishuApiError, get_tenant_token, post, get  # noqa: F401
from . import oauth  # noqa: F401
