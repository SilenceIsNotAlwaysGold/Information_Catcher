"""SaaS 套餐定义 + 配额查询。

套餐：
- trial：14 天试用，到期 scheduler 降级到 free
- free：永久免费，最低配额
- pro：付费专业版
- team：团队版
- enterprise：企业版（无限制）

每个套餐定义四类配额：
- monitor_posts：监控帖子总数（小红书 + 抖音 + 公众号合计）
- daily_image_gen：每天生成图片张数
- daily_remix_sets：每天提交仿写套数
- accounts：爬虫账号池绑定上限

`-1` 代表无限制。admin 永远豁免（在 quota_service 里特判）。
"""
from __future__ import annotations

from typing import Any, Dict, Optional


PLANS: Dict[str, Dict[str, Any]] = {
    "trial": {
        "label": "试用",
        "monitor_posts": 50,
        "daily_image_gen": 20,
        "daily_remix_sets": 5,
        "accounts": 1,
        "duration_days": 14,
        "color": "warning",
    },
    "free": {
        "label": "免费版",
        "monitor_posts": 20,
        "daily_image_gen": 10,
        "daily_remix_sets": 3,
        "accounts": 1,
        "duration_days": None,
        "color": "default",
    },
    "pro": {
        "label": "专业版",
        "monitor_posts": 500,
        "daily_image_gen": 100,
        "daily_remix_sets": 30,
        "accounts": 5,
        "duration_days": None,
        "color": "primary",
    },
    "team": {
        "label": "团队版",
        "monitor_posts": 2000,
        "daily_image_gen": 500,
        "daily_remix_sets": 100,
        "accounts": 20,
        "duration_days": None,
        "color": "secondary",
    },
    "enterprise": {
        "label": "企业版",
        "monitor_posts": -1,
        "daily_image_gen": -1,
        "daily_remix_sets": -1,
        "accounts": -1,
        "duration_days": None,
        "color": "success",
    },
}

QUOTA_KEYS = ("monitor_posts", "daily_image_gen", "daily_remix_sets", "accounts")


def get_plan(plan: Optional[str]) -> Dict[str, Any]:
    """根据 plan 名取套餐定义；未知值回退到 free。"""
    return PLANS.get((plan or "").strip().lower(), PLANS["free"])


def get_quota(plan: Optional[str], key: str) -> int:
    """取套餐下的某一类配额。`-1` 表示无限制。"""
    return int(get_plan(plan).get(key, 0))


def list_plans() -> list:
    """前端选择套餐时用：返回 [{key, label, ...quotas}]。"""
    return [{"key": k, **v} for k, v in PLANS.items()]


def is_unlimited(value: int) -> bool:
    return value < 0
