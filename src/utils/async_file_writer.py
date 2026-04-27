# -*- coding: utf-8 -*-
"""
异步文件写入模块

提供线程安全的异步文件写入功能，支持 CSV 和 JSON 格式。
"""
import asyncio
import csv
import json
import os
import pathlib
from typing import Dict, List

import aiofiles

import config
from src.utils.utils import utils
from src.utils.words import AsyncWordCloudGenerator


class AsyncFileWriter:
    """异步文件写入器，支持并发安全的文件操作"""

    def __init__(self, platform: str, crawler_type: str):
        """
        初始化文件写入器

        Args:
            platform: 平台名称 (xhs/zhihu)
            crawler_type: 爬虫类型 (search/detail/creator)
        """
        self.lock = asyncio.Lock()
        self.platform = platform
        self.crawler_type = crawler_type
        self.wordcloud_generator = (
            AsyncWordCloudGenerator() if config.ENABLE_GET_WORDCLOUD else None
        )

    def _get_file_path(self, file_type: str, item_type: str) -> str:
        """
        生成文件保存路径

        Args:
            file_type: 文件类型 (csv/json)
            item_type: 数据类型 (contents/comments)

        Returns:
            str: 完整的文件路径
        """
        base_path = f"data/{self.platform}/{file_type}"
        pathlib.Path(base_path).mkdir(parents=True, exist_ok=True)
        file_name = f"{self.crawler_type}_{item_type}_{utils.get_current_date()}.{file_type}"
        return f"{base_path}/{file_name}"

    async def write_to_csv(self, item: Dict, item_type: str):
        """
        异步写入单条数据到 CSV 文件

        Args:
            item: 要写入的数据字典
            item_type: 数据类型
        """
        file_path = self._get_file_path("csv", item_type)
        async with self.lock:
            file_exists = os.path.exists(file_path)
            async with aiofiles.open(
                file_path, "a", newline="", encoding="utf-8-sig"
            ) as f:
                writer = csv.DictWriter(f, fieldnames=item.keys())
                if not file_exists or await f.tell() == 0:
                    await writer.writeheader()
                await writer.writerow(item)

    async def write_single_item_to_json(self, item: Dict, item_type: str):
        """
        异步写入单条数据到 JSON 文件（追加模式）

        Args:
            item: 要写入的数据字典
            item_type: 数据类型
        """
        file_path = self._get_file_path('json', item_type)
        async with self.lock:
            existing_data = []
            if os.path.exists(file_path) and os.path.getsize(file_path) > 0:
                async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
                    try:
                        content = await f.read()
                        if content:
                            existing_data = json.loads(content)
                        if not isinstance(existing_data, list):
                            existing_data = [existing_data]
                    except json.JSONDecodeError:
                        existing_data = []

            existing_data.append(item)

            async with aiofiles.open(file_path, 'w', encoding='utf-8') as f:
                await f.write(json.dumps(existing_data, ensure_ascii=False, indent=4))

    async def generate_wordcloud_from_comments(self):
        """
        从评论数据生成词云图

        仅在 ENABLE_GET_WORDCLOUD 和 ENABLE_GET_COMMENTS 都为 True 时生效
        """
        if not config.ENABLE_GET_WORDCLOUD or not config.ENABLE_GET_COMMENTS:
            return

        if not self.wordcloud_generator:
            return

        try:
            # 读取评论 JSON 文件
            comments_file_path = self._get_file_path("json", "comments")
            if (
                not os.path.exists(comments_file_path)
                or os.path.getsize(comments_file_path) == 0
            ):
                utils.logger.info(
                    f"[AsyncFileWriter.generate_wordcloud_from_comments] 未找到评论文件: {comments_file_path}"
                )
                return

            async with aiofiles.open(comments_file_path, "r", encoding="utf-8") as f:
                content = await f.read()
                if not content:
                    utils.logger.info(
                        "[AsyncFileWriter.generate_wordcloud_from_comments] 评论文件为空"
                    )
                    return

                comments_data = json.loads(content)
                if not isinstance(comments_data, list):
                    comments_data = [comments_data]

            # 提取评论内容字段（兼容不同平台的字段名）
            filtered_data = []
            for comment in comments_data:
                if isinstance(comment, dict):
                    content_text = (
                        comment.get("content")
                        or comment.get("comment_text")
                        or comment.get("text")
                        or ""
                    )
                    if content_text:
                        filtered_data.append({"content": content_text})

            if not filtered_data:
                utils.logger.info(
                    "[AsyncFileWriter.generate_wordcloud_from_comments] 未找到有效的评论内容"
                )
                return

            # 生成词云图
            words_base_path = f"data/{self.platform}/words"
            pathlib.Path(words_base_path).mkdir(parents=True, exist_ok=True)
            words_file_prefix = (
                f"{words_base_path}/{self.crawler_type}_comments_{utils.get_current_date()}"
            )

            utils.logger.info(
                f"[AsyncFileWriter.generate_wordcloud_from_comments] 正在从 {len(filtered_data)} 条评论生成词云..."
            )
            await self.wordcloud_generator.generate_word_frequency_and_cloud(
                filtered_data, words_file_prefix
            )
            utils.logger.info(
                f"[AsyncFileWriter.generate_wordcloud_from_comments] 词云生成成功: {words_file_prefix}"
            )

        except Exception as e:
            utils.logger.error(
                f"[AsyncFileWriter.generate_wordcloud_from_comments] 生成词云时出错: {e}"
            )
