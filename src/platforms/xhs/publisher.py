# -*- coding: utf-8 -*-
"""
小红书笔记发布模块

基于技术文档实现: https://www.sddtc.florist/blog/2025-06-24-xhs-robot/

功能:
1. 通过关键字搜索话题 (search_topic)
2. 获取图片上传凭证 (get_upload_permit)
3. 上传图片到小红书 (upload_image)
4. 发布图文笔记 (publish_note)
"""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx
from PIL import Image
from tenacity import retry, stop_after_attempt, wait_fixed

from src.utils import utils


# 不可见字符，用于话题标记
TOPIC_MARKER = "\ufeff"


@dataclass
class TopicInfo:
    """话题信息"""
    id: str
    name: str
    link: str
    type: str = "topic"


@dataclass
class ImageInfo:
    """图片上传信息"""
    file_id: str
    width: int
    height: int
    local_path: str = ""


@dataclass
class NoteContent:
    """笔记内容"""
    title: str
    desc: str
    images: List[str]  # 本地图片路径列表
    topics: List[str] = field(default_factory=list)  # 话题关键词列表


class XiaoHongShuPublisher:
    """小红书笔记发布器
    
    使用方式:
        publisher = XiaoHongShuPublisher(headers, cookie_dict, sign_func)
        
        # 搜索话题
        topics = await publisher.search_topic("比格")
        
        # 发布笔记
        result = await publisher.publish_note(NoteContent(
            title="我的笔记",
            desc="描述内容",
            images=["./image1.jpg", "./image2.jpg"],
            topics=["比格犬"]
        ))
    """

    def __init__(
        self,
        headers: Dict[str, str],
        cookie_dict: Dict[str, str],
        sign_func,  # async (uri, data, method) -> Dict[str, str]
        proxy: Optional[str] = None,
        timeout: int = 60,
    ):
        """初始化发布器
        
        Args:
            headers: HTTP 请求头
            cookie_dict: Cookie 字典
            sign_func: 签名函数，返回 {"x-s": ..., "x-t": ...}
            proxy: 代理地址
            timeout: 请求超时时间
        """
        self.headers = headers.copy()
        self.cookie_dict = cookie_dict
        self.sign_func = sign_func
        self.proxy = proxy
        self.timeout = timeout
        
        # API 域名
        self._edith_host = "https://edith.xiaohongshu.com"
        self._creator_host = "https://creator.xiaohongshu.com"
        self._upload_host = "https://ros-upload.xiaohongshu.com"

    async def _sign_headers(
        self,
        uri: str,
        data: Optional[Dict] = None,
        method: str = "POST",
        origin: str = "https://creator.xiaohongshu.com",
    ) -> Dict[str, str]:
        """生成签名后的请求头"""
        signs = await self.sign_func(uri, data, method)
        
        headers = self.headers.copy()
        headers.update({
            "X-S": signs.get("x-s", ""),
            "X-T": signs.get("x-t", ""),
            "Origin": origin,
            "Content-Type": "application/json;charset=UTF-8",
        })
        
        if "x-s-common" in signs:
            headers["x-S-Common"] = signs["x-s-common"]
        
        return headers

    @retry(stop=stop_after_attempt(3), wait=wait_fixed(1))
    async def _request(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        **kwargs,
    ) -> Any:
        """发送 HTTP 请求"""
        async with httpx.AsyncClient(proxy=self.proxy) as client:
            response = await client.request(
                method, url, headers=headers, timeout=self.timeout, **kwargs
            )
            response.raise_for_status()
            
            # 部分接口返回非 JSON
            content_type = response.headers.get("content-type", "")
            if "application/json" in content_type:
                data = response.json()
                if isinstance(data, dict) and data.get("success") is False:
                    raise Exception(f"API 错误: {data.get('msg', response.text)}")
                return data
            return response

    # ========== 1. 话题搜索 ==========

    async def search_topic(self, keyword: str, page: int = 1, page_size: int = 20) -> List[TopicInfo]:
        """通过关键字搜索话题
        
        Args:
            keyword: 搜索关键词
            page: 页码
            page_size: 每页数量
            
        Returns:
            话题列表
        """
        uri = "/web_api/sns/v1/search/topic"
        data = {
            "keyword": keyword,
            "suggest_topic_request": {
                "title": "",
                "desc": f"#{keyword}",
            },
            "page": {
                "page_size": page_size,
                "page": page,
            },
        }
        
        headers = await self._sign_headers(uri, data, "POST")
        url = f"{self._edith_host}{uri}"
        
        result = await self._request("POST", url, headers, json=data)
        
        topics = []
        topic_list = result.get("data", {}).get("topic_info_dtos", [])
        for item in topic_list:
            topics.append(TopicInfo(
                id=item.get("id", ""),
                name=item.get("name", ""),
                link=item.get("link", ""),
                type="topic",
            ))
        
        utils.logger.info(f"[Publisher] 搜索话题 '{keyword}' 找到 {len(topics)} 个结果")
        return topics

    # ========== 2. 获取上传凭证 ==========

    async def get_upload_permit(self, file_count: int = 1) -> Dict[str, Any]:
        """获取图片上传凭证
        
        Args:
            file_count: 要上传的图片数量
            
        Returns:
            包含 file_ids 和 credentials 的字典
        """
        uri = "/api/media/v1/upload/web/permit"
        params = {
            "biz_name": "spectrum",
            "scene": "image",
            "file_count": file_count,
            "version": 1,
            "source": "web",
        }
        
        headers = await self._sign_headers(uri, params, "GET")
        headers["Referer"] = "https://creator.xiaohongshu.com/publish/publish?from=tab_switch"
        
        url = f"{self._creator_host}{uri}"
        result = await self._request("GET", url, headers, params=params)
        
        data = result.get("data", {})
        utils.logger.info(f"[Publisher] 获取上传凭证成功，file_ids: {len(data.get('file_ids', []))} 个")
        
        return {
            "file_ids": data.get("file_ids", []),
            "token": data.get("credential", {}).get("token", ""),
        }

    # ========== 3. 上传图片 ==========

    async def upload_image(
        self,
        image_path: str,
        file_id: str,
        token: str,
    ) -> ImageInfo:
        """上传单张图片
        
        Args:
            image_path: 本地图片路径
            file_id: 从 get_upload_permit 获取的 file_id
            token: 上传凭证 token
            
        Returns:
            图片上传信息
        """
        # 读取图片尺寸
        with Image.open(image_path) as img:
            width, height = img.size
        
        # 读取图片二进制
        with open(image_path, "rb") as f:
            image_data = f.read()
        
        # 上传图片
        url = f"{self._upload_host}/{file_id}"
        headers = {
            "Cookie": self.headers.get("Cookie", ""),
            "Content-Type": "image/jpeg",
            "X-Cos-Security-Token": token,
            "Origin": self._creator_host,
        }
        
        async with httpx.AsyncClient(proxy=self.proxy) as client:
            response = await client.put(
                url, headers=headers, content=image_data, timeout=self.timeout
            )
            response.raise_for_status()
        
        utils.logger.info(f"[Publisher] 图片上传成功: {os.path.basename(image_path)} -> {file_id}")
        
        return ImageInfo(
            file_id=file_id,
            width=width,
            height=height,
            local_path=image_path,
        )

    async def upload_images(self, image_paths: List[str]) -> List[ImageInfo]:
        """批量上传图片
        
        Args:
            image_paths: 图片路径列表
            
        Returns:
            上传结果列表
        """
        if not image_paths:
            raise ValueError("至少需要一张图片")
        
        # 获取上传凭证
        permit = await self.get_upload_permit(len(image_paths))
        file_ids = permit["file_ids"]
        token = permit["token"]
        
        if len(file_ids) < len(image_paths):
            raise Exception(f"获取的 file_id 数量不足: {len(file_ids)} < {len(image_paths)}")
        
        # 逐个上传
        results = []
        for i, path in enumerate(image_paths):
            info = await self.upload_image(path, file_ids[i], token)
            results.append(info)
        
        return results

    # ========== 4. 发布笔记 ==========

    def _build_desc_with_topics(
        self,
        desc: str,
        topics: List[TopicInfo],
    ) -> str:
        """构建带话题标记的描述文本
        
        话题格式: {MARKER}#话题名称[话题]{MARKER}
        """
        result = desc
        for topic in topics:
            # 添加不可见字符标记
            tag_text = f"{TOPIC_MARKER}#{topic.name}[话题]#{TOPIC_MARKER}"
            if f"#{topic.name}" not in result:
                result += f" {tag_text}"
        return result

    def _build_note_payload(
        self,
        title: str,
        desc: str,
        images: List[ImageInfo],
        topics: List[TopicInfo],
    ) -> Dict[str, Any]:
        """构建发布笔记的请求体"""
        
        # 构建 hash_tag
        hash_tags = []
        for topic in topics:
            hash_tags.append({
                "id": topic.id,
                "name": topic.name,
                "link": topic.link,
                "type": topic.type,
            })
        
        # 构建图片列表
        image_list = []
        for img in images:
            image_list.append({
                "file_id": img.file_id,
                "width": img.width,
                "height": img.height,
                "metadata": {"source": -1},
                "stickers": {"version": 2, "floating": []},
                "extra_info_json": '{"mimeType":"image/jpeg"}',
            })
        
        return {
            "common": {
                "type": "normal",
                "note_id": "",
                "post_id": "",
                "source": json.dumps({
                    "type": "web",
                    "ids": "",
                    "extraInfo": json.dumps({"systemId": "web"}),
                }),
                "title": title,
                "desc": desc,
                "ats": [],
                "hash_tag": hash_tags,
                "business_binds": json.dumps({
                    "version": 1,
                    "noteId": 0,
                    "bizType": 0,
                    "noteOrderBind": {},
                    "notePostTiming": {},
                    "noteCollectionBind": {"id": ""},
                    "noteSketchCollectionBind": {"id": ""},
                    "coProduceBind": {"enable": False},
                    "noteCopyBind": {"copyable": False},
                    "interactionPermissionBind": {"commentPermission": 0},
                    "optionRelationList": [],
                }),
                "privacy_info": {
                    "op_type": 1,
                    "type": 0,
                    "user_ids": [],
                },
                "goods_info": {},
                "biz_relations": [],
            },
            "image_info": {
                "images": image_list,
            },
            "video_info": None,
        }

    async def publish_note(self, content: NoteContent) -> Dict[str, Any]:
        """发布图文笔记
        
        Args:
            content: 笔记内容
            
        Returns:
            发布结果
        """
        utils.logger.info(f"[Publisher] 开始发布笔记: {content.title}")
        
        # 1. 上传图片
        images = await self.upload_images(content.images)
        
        # 2. 搜索话题
        topics: List[TopicInfo] = []
        for keyword in content.topics:
            topic_list = await self.search_topic(keyword)
            if topic_list:
                topics.append(topic_list[0])  # 取第一个匹配结果
        
        # 3. 构建描述文本（带话题标记）
        desc = self._build_desc_with_topics(content.desc, topics)
        
        # 4. 发布笔记
        uri = "/web_api/sns/v2/note"
        payload = self._build_note_payload(content.title, desc, images, topics)
        
        headers = await self._sign_headers(uri, payload, "POST")
        url = f"{self._edith_host}{uri}"
        
        result = await self._request("POST", url, headers, json=payload)
        
        note_id = result.get("data", {}).get("note_id", "")
        utils.logger.info(f"[Publisher] 笔记发布成功! note_id: {note_id}")
        
        return {
            "success": True,
            "note_id": note_id,
            "data": result,
        }


# ========== 便捷函数 ==========

async def create_publisher_from_client(client) -> XiaoHongShuPublisher:
    """从现有 XiaoHongShuClient 创建发布器
    
    Args:
        client: XiaoHongShuClient 实例
        
    Returns:
        XiaoHongShuPublisher 实例
    """
    from .playwright_sign import sign_with_playwright
    
    async def sign_func(uri: str, data: Optional[Dict], method: str) -> Dict[str, str]:
        return await sign_with_playwright(
            page=client.playwright_page,
            uri=uri,
            data=data,
            a1=client.cookie_dict.get("a1", ""),
            method=method,
        )
    
    return XiaoHongShuPublisher(
        headers=client.headers,
        cookie_dict=client.cookie_dict,
        sign_func=sign_func,
        proxy=client.proxy,
        timeout=client.timeout,
    )
