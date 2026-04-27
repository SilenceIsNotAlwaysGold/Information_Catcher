# -*- coding: utf-8 -*-
"""
小红书平台配置
"""

# 搜索结果排序方式（枚举值见 src/platforms/xhs/field.py）
# 可选: general(综合) | popularity_descending(最热) | time_descending(最新)
SORT_TYPE = "popularity_descending"

# 指定笔记 URL 列表（detail 模式使用）
# 注意: URL 必须携带 xsec_token 参数
XHS_SPECIFIED_NOTE_URL_LIST = [
    # 示例: "https://www.xiaohongshu.com/explore/xxx?xsec_token=xxx"
]

# 指定创作者 URL 列表（creator 模式使用）
# 注意: URL 需携带 xsec_token 和 xsec_source 参数
XHS_CREATOR_ID_LIST = [
    # 示例: "https://www.xiaohongshu.com/user/profile/xxx?xsec_token=xxx&xsec_source=xxx"
]
