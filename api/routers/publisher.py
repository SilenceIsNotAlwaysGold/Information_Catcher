# -*- coding: utf-8 -*-
"""
笔记发布路由模块

提供小红书笔记发布的API端点：
- POST /publisher/topic/search - 搜索话题
- POST /publisher/upload - 上传图片
- POST /publisher/publish - 发布笔记
- GET /publisher/status - 获取发布器状态

所有接口需要Bearer Token认证
"""

import base64
import os
import tempfile
from typing import List

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from pydantic import BaseModel

from .auth import get_current_user
from src.utils import utils


router = APIRouter(prefix="/publisher", tags=["笔记发布"])


# ========== 数据模型 ==========

class TopicSearchRequest(BaseModel):
    """话题搜索请求"""
    keyword: str
    page: int = 1
    page_size: int = 20


class TopicInfo(BaseModel):
    """话题信息"""
    id: str
    name: str
    link: str
    type: str = "topic"


class TopicSearchResponse(BaseModel):
    """话题搜索响应"""
    topics: List[TopicInfo]


class ImageUploadResponse(BaseModel):
    """图片上传响应"""
    file_id: str
    width: int
    height: int
    url: str  # 临时预览URL


class PublishNoteRequest(BaseModel):
    """发布笔记请求"""
    title: str
    desc: str
    image_ids: List[str]  # 已上传的图片ID列表
    topic_ids: List[str] = []  # 话题ID列表


class PublishNoteResponse(BaseModel):
    """发布笔记响应"""
    success: bool
    note_id: str = ""
    message: str = ""


class PublisherStatusResponse(BaseModel):
    """发布器状态响应"""
    available: bool
    logged_in: bool
    platform: str = "xhs"
    message: str = ""


# ========== 全局状态 ==========

# 发布器实例缓存（实际项目中应该使用更可靠的状态管理）
_publisher_instance = None
_uploaded_images: dict = {}  # file_id -> 图片信息


def get_publisher():
    """获取发布器实例（懒加载）"""
    global _publisher_instance
    return _publisher_instance


def set_publisher(publisher):
    """设置发布器实例"""
    global _publisher_instance
    _publisher_instance = publisher


# ========== API 端点 ==========

@router.get("/status", response_model=PublisherStatusResponse, summary="获取发布器状态")
async def get_publisher_status(current_user: dict = Depends(get_current_user)):
    """
    获取发布器当前状态
    
    检查发布器是否可用、是否已登录
    """
    publisher = get_publisher()
    
    if publisher is None:
        return PublisherStatusResponse(
            available=False,
            logged_in=False,
            message="发布器未初始化，请先启动爬虫登录小红书"
        )
    
    return PublisherStatusResponse(
        available=True,
        logged_in=True,
        platform="xhs",
        message="发布器就绪"
    )


@router.post("/topic/search", response_model=TopicSearchResponse, summary="搜索话题")
async def search_topic(
    request: TopicSearchRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    搜索小红书话题
    
    - **keyword**: 搜索关键词
    - **page**: 页码
    - **page_size**: 每页数量
    """
    publisher = get_publisher()
    
    if publisher is None:
        raise HTTPException(status_code=503, detail="发布器未初始化，请先启动爬虫登录")
    
    try:
        topics = await publisher.search_topic(
            keyword=request.keyword,
            page=request.page,
            page_size=request.page_size
        )
        
        return TopicSearchResponse(
            topics=[
                TopicInfo(
                    id=t.id,
                    name=t.name,
                    link=t.link,
                    type=t.type
                ) for t in topics
            ]
        )
    except Exception as e:
        utils.logger.error(f"[Publisher API] 搜索话题失败: {e}")
        raise HTTPException(status_code=500, detail=f"搜索话题失败: {str(e)}")


@router.post("/upload", response_model=ImageUploadResponse, summary="上传图片")
async def upload_image(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user)
):
    """
    上传图片到小红书
    
    支持 jpg/jpeg/png/webp 格式
    """
    publisher = get_publisher()
    
    if publisher is None:
        raise HTTPException(status_code=503, detail="发布器未初始化，请先启动爬虫登录")
    
    # 验证文件类型
    allowed_types = {"image/jpeg", "image/png", "image/webp"}
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400, 
            detail=f"不支持的图片格式: {file.content_type}"
        )
    
    try:
        # 保存临时文件
        suffix = os.path.splitext(file.filename or "image.jpg")[1] or ".jpg"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name
        
        try:
            # 获取上传凭证并上传
            permit = await publisher.get_upload_permit(1)
            file_id = permit["file_ids"][0]
            token = permit["token"]
            
            image_info = await publisher.upload_image(tmp_path, file_id, token)
            
            # 缓存图片信息
            _uploaded_images[file_id] = {
                "file_id": file_id,
                "width": image_info.width,
                "height": image_info.height,
                "local_path": tmp_path,
            }
            
            # 生成预览URL（Base64 data URL）
            preview_url = f"data:{file.content_type};base64,{base64.b64encode(content).decode()}"
            
            return ImageUploadResponse(
                file_id=file_id,
                width=image_info.width,
                height=image_info.height,
                url=preview_url
            )
        finally:
            # 注意：这里不删除临时文件，因为发布时还需要
            pass
            
    except Exception as e:
        utils.logger.error(f"[Publisher API] 上传图片失败: {e}")
        raise HTTPException(status_code=500, detail=f"上传图片失败: {str(e)}")


@router.post("/publish", response_model=PublishNoteResponse, summary="发布笔记")
async def publish_note(
    request: PublishNoteRequest,
    current_user: dict = Depends(get_current_user)
):
    """
    发布图文笔记
    
    - **title**: 笔记标题
    - **desc**: 笔记描述
    - **image_ids**: 已上传的图片ID列表
    - **topic_ids**: 话题ID列表（可选）
    """
    publisher = get_publisher()
    
    if publisher is None:
        raise HTTPException(status_code=503, detail="发布器未初始化，请先启动爬虫登录")
    
    if not request.image_ids:
        raise HTTPException(status_code=400, detail="至少需要一张图片")
    
    # 验证图片是否已上传
    for img_id in request.image_ids:
        if img_id not in _uploaded_images:
            raise HTTPException(status_code=400, detail=f"图片未找到: {img_id}")
    
    try:
        # 构建图片信息列表
        from src.platforms.xhs.publisher import ImageInfo, TopicInfo as PubTopicInfo
        
        images = [
            ImageInfo(
                file_id=_uploaded_images[img_id]["file_id"],
                width=_uploaded_images[img_id]["width"],
                height=_uploaded_images[img_id]["height"],
            )
            for img_id in request.image_ids
        ]
        
        # 构建话题信息（如果有）
        topics = []
        for topic_id in request.topic_ids:
            # 这里简化处理，实际应该从缓存中获取完整话题信息
            topics.append(PubTopicInfo(
                id=topic_id,
                name="",  # 需要从搜索结果缓存获取
                link="",
                type="topic"
            ))
        
        # 调用发布器发布
        result = await publisher._publish_with_images(
            title=request.title,
            desc=request.desc,
            images=images,
            topics=topics
        )
        
        # 清理已使用的图片缓存
        for img_id in request.image_ids:
            if img_id in _uploaded_images:
                # 删除临时文件
                tmp_path = _uploaded_images[img_id].get("local_path")
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass
                del _uploaded_images[img_id]
        
        return PublishNoteResponse(
            success=True,
            note_id=result.get("note_id", ""),
            message="笔记发布成功"
        )
        
    except Exception as e:
        utils.logger.error(f"[Publisher API] 发布笔记失败: {e}")
        raise HTTPException(status_code=500, detail=f"发布笔记失败: {str(e)}")


@router.delete("/upload/{file_id}", summary="删除已上传图片")
async def delete_uploaded_image(
    file_id: str,
    current_user: dict = Depends(get_current_user)
):
    """
    删除已上传但未发布的图片
    """
    if file_id not in _uploaded_images:
        raise HTTPException(status_code=404, detail="图片未找到")
    
    # 删除临时文件
    tmp_path = _uploaded_images[file_id].get("local_path")
    if tmp_path and os.path.exists(tmp_path):
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
    
    del _uploaded_images[file_id]
    
    return {"status": "ok", "message": "图片已删除"}
