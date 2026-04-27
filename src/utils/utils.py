# -*- coding: utf-8 -*-
"""
通用工具模块

提供日志配置、字符串处理等基础工具函数。
"""
import argparse
import logging

from .crawler_util import *
from .slider_util import *
from .time_util import *


def init_loging_config():
    """
    初始化日志配置

    Returns:
        Logger: 配置完成的日志实例
    """
    level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)s %(levelname)s (%(filename)s:%(lineno)d) - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    _logger = logging.getLogger("LittleCrawler")
    _logger.setLevel(level)

    # 禁用 httpx 的 INFO 级别日志（减少冗余输出）
    logging.getLogger("httpx").setLevel(logging.WARNING)

    return _logger


logger = init_loging_config()


def str2bool(v):
    """
    将字符串转换为布尔值

    支持的真值: yes, true, t, y, 1
    支持的假值: no, false, f, n, 0

    Args:
        v: 输入值（布尔或字符串）

    Returns:
        bool: 转换后的布尔值

    Raises:
        ArgumentTypeError: 无法解析的值
    """
    if isinstance(v, bool):
        return v
    if v.lower() in ("yes", "true", "t", "y", "1"):
        return True
    elif v.lower() in ("no", "false", "f", "n", "0"):
        return False
    else:
        raise argparse.ArgumentTypeError("需要布尔值（yes/no, true/false, 1/0）")
