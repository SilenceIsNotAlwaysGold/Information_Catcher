"""SaaS 套餐定义 + 配额查询。

套餐：
- trial：14 天试用，到期 scheduler 降级到 free
- free：永久免费，最低配额
- pro：付费专业版
- team：团队版
- enterprise：企业版（无限制）

每个套餐定义五类配额：
- monitor_posts：监控帖子总数（小红书 + 抖音 + 公众号合计）
- daily_image_gen：每天生成图片张数（商品图 / 作品仿写图 / 文字仿写图 合计）
- daily_text_gen：每天 AI 文案生成数（作品仿写文案 / 其他 AI 改写 合计）
- accounts：爬虫账号池绑定上限
- daily_remix_sets（已废弃）：兼容老前端，全部走 daily_image_gen 后续会移除

`-1` 代表无限制。admin 永远豁免（在 quota_service 里特判）。
"""
from __future__ import annotations

from typing import Any, Dict, Optional


PLANS: Dict[str, Dict[str, Any]] = {
    "trial": {
        "label": "试用",
        "monitor_posts": 50,
        "daily_image_gen": 30,    # 图：1 套 5 张 × 6 套 = 30
        "daily_text_gen":  10,    # 文：6 套文案 + 余量
        "daily_remix_sets": 5,    # deprecated, 仅老前端展示
        "accounts": 1,
        "duration_days": 14,
        "color": "warning",
    },
    "free": {
        "label": "免费版",
        "monitor_posts": 20,
        "daily_image_gen": 15,
        "daily_text_gen":  5,
        "daily_remix_sets": 3,    # deprecated
        "accounts": 1,
        "duration_days": None,
        "color": "default",
    },
    "pro": {
        "label": "专业版",
        "monitor_posts": 500,
        "daily_image_gen": 200,
        "daily_text_gen":  60,
        "daily_remix_sets": 30,   # deprecated
        "accounts": 5,
        "duration_days": None,
        "color": "primary",
    },
    "team": {
        "label": "团队版",
        "monitor_posts": 2000,
        "daily_image_gen": 1000,
        "daily_text_gen":  300,
        "daily_remix_sets": 100,  # deprecated
        "accounts": 20,
        "duration_days": None,
        "color": "secondary",
    },
    "enterprise": {
        "label": "企业版",
        "monitor_posts": -1,
        "daily_image_gen": -1,
        "daily_text_gen":  -1,
        "daily_remix_sets": -1,   # deprecated
        "accounts": -1,
        "duration_days": None,
        "color": "success",
    },
}

# 主要 quota keys（admin UI 与配额限额都用这个）
QUOTA_KEYS = (
    "monitor_posts",
    "daily_image_gen",
    "daily_text_gen",
    "accounts",
    # deprecated，但保留以避免旧前端读 admin/users/{id} 报错
    "daily_remix_sets",
)


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
