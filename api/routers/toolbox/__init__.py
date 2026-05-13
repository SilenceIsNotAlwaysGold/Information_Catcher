# -*- coding: utf-8 -*-
"""实用工具箱（v2 板块 3）— 不耗 AI 的实用功能。

子模块：
- uptime：服务监控（HTTP/TCP 探活 + 失败告警）
- （后续）docs：文档转换（gotenberg）
- （后续）music：AI 音乐生成（ace-step-ui）

路由前缀 /toolbox。
"""
from fastapi import APIRouter

from . import uptime

router = APIRouter()
router.include_router(uptime.router)
