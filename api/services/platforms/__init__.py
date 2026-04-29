"""
平台注册中心。

新增平台：
  1. 在 api/services/platforms/{name}/ 下实现 Platform 子类
  2. 在 _REGISTRY 里加一行
"""
from __future__ import annotations

from typing import Dict, Optional

from .base import Platform
from .xhs import XHSPlatform
from .douyin import DouyinPlatform
from .mp import MpPlatform


# 单例注册表：name → Platform 实例
_REGISTRY: Dict[str, Platform] = {
    XHSPlatform.name: XHSPlatform(),
    DouyinPlatform.name: DouyinPlatform(),
    MpPlatform.name: MpPlatform(),
}


# URL 自动识别时的尝试顺序
_DETECT_ORDER = [XHSPlatform, DouyinPlatform, MpPlatform]


def get_platform(name: str) -> Optional[Platform]:
    """按 platform name 取实例，未知返回 None。"""
    if not name:
        return None
    return _REGISTRY.get(name)


def detect_platform(raw_url: str) -> Optional[Platform]:
    """根据 URL 识别平台；不能识别返回 None。"""
    if not raw_url:
        return None
    for cls in _DETECT_ORDER:
        if cls.match_url(raw_url):
            return _REGISTRY[cls.name]
    return None


def list_platforms() -> Dict[str, str]:
    """给前端用的 {name: label} 字典。"""
    return {p.name: p.label for p in _REGISTRY.values()}
