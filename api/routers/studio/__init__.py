# -*- coding: utf-8 -*-
"""AI 工坊（v2 板块 2）路由装配。

子模块：
- comic：AI 漫画（对话引导写故事 → 拆分镜 → 角色卡 → 逐格生图）
- （后续）novel：AI 小说；travel：AI 旅游攻略；ppt：AI PPT …

路由前缀 /studio。
"""
from fastapi import APIRouter

from . import comic, travel, novel, ppt, ppt_templates

router = APIRouter()
router.include_router(comic.router)
router.include_router(travel.router)
router.include_router(novel.router)
router.include_router(ppt.router)
router.include_router(ppt_templates.router)
