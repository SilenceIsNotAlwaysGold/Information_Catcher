"""SaaS 套餐定义 + 配额查询。

套餐：
- trial：14 天试用，到期 scheduler 降级到 free
- free：永久免费，最低配额
- pro：付费专业版
- team：团队版
- enterprise：企业版（无限制）

每个套餐定义这些配额：
- monitor_posts：监控帖子总数（小红书 + 抖音 + 公众号合计）
- total_image_gen：账户**累计**生图数（不重置，用完为止）
- daily_text_gen：每天 AI 文案生成数（每日 0 点重置）
- accounts：爬虫账号池绑定上限
- daily_image_gen（已废弃）：兼容老前端，实际指向 total_image_gen
- daily_remix_sets（已废弃）：兼容老前端

`-1` 代表无限制。admin 永远豁免（在 quota_service 里特判）。
"""
from __future__ import annotations

from typing import Any, Dict, Optional


PLANS: Dict[str, Dict[str, Any]] = {
    "trial": {
        "label": "试用",
        "monitor_posts": 50,
        "total_image_gen": 100,   # 账户累计图额度（不重置）— v2 起仅作历史展示
        "daily_text_gen":  10,
        "daily_image_gen": 100,
        "daily_remix_sets": 5,
        "accounts": 1,
        "duration_days": 14,
        "monthly_credits": 50,    # v2: 每月免费点数（cron grant）
        "color": "warning",
    },
    "free": {
        "label": "免费版",
        "monitor_posts": 20,
        "total_image_gen": 50,
        "daily_text_gen":  5,
        "daily_image_gen": 50,
        "daily_remix_sets": 3,
        "accounts": 1,
        "duration_days": None,
        "monthly_credits": 20,    # v2
        "color": "default",
    },
    "pro": {
        "label": "专业版",
        "monitor_posts": 500,
        "total_image_gen": 2000,
        "daily_text_gen":  60,
        "daily_image_gen": 2000,
        "daily_remix_sets": 30,
        "accounts": 5,
        "duration_days": None,
        "monthly_credits": 500,   # v2
        "color": "primary",
    },
    "team": {
        "label": "团队版",
        "monitor_posts": 2000,
        "total_image_gen": 20000,
        "daily_text_gen":  300,
        "daily_image_gen": 20000,
        "daily_remix_sets": 100,
        "accounts": 20,
        "duration_days": None,
        "monthly_credits": 3000,  # v2
        "color": "secondary",
    },
    "enterprise": {
        "label": "企业版",
        "monitor_posts": -1,
        "total_image_gen": -1,
        "daily_text_gen":  -1,
        "daily_image_gen": -1,
        "daily_remix_sets": -1,
        "accounts": -1,
        "duration_days": None,
        "monthly_credits": 0,     # 企业版不送，按需充值
        "color": "success",
    },
}

# 主要 quota keys（admin UI 与配额限额都用这个）
QUOTA_KEYS = (
    "monitor_posts",
    "total_image_gen",
    "daily_text_gen",
    "accounts",
    # deprecated，但保留以避免旧前端读 admin/users/{id} 报错
    "daily_image_gen",
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
