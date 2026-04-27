# -*- coding: utf-8 -*-
"""
上下文变量模块

使用 contextvars 实现异步任务间的变量传递，避免全局变量污染。
主要用于在爬虫执行过程中传递：
- 当前搜索关键词
- 爬虫类型
- 数据库连接池
- 异步任务列表
"""
from asyncio.tasks import Task
from contextvars import ContextVar
from typing import List

import aiomysql

# 当前请求的关键词（用于 API 请求）
request_keyword_var: ContextVar[str] = ContextVar("request_keyword", default="")

# 爬虫类型: search | detail | creator
crawler_type_var: ContextVar[str] = ContextVar("crawler_type", default="")

# 评论爬取任务列表（用于并发控制）
comment_tasks_var: ContextVar[List[Task]] = ContextVar("comment_tasks", default=[])

# MySQL 连接池
db_conn_pool_var: ContextVar[aiomysql.Pool] = ContextVar("db_conn_pool_var")

# 数据来源关键词（用于文件命名和数据标记）
source_keyword_var: ContextVar[str] = ContextVar("source_keyword", default="")
