# -*- coding: utf-8 -*-
"""认证相关数据模型。"""

from typing import Optional, Dict, Any
from pydantic import BaseModel


class UserLogin(BaseModel):
    """用户登录请求 — username 字段同时支持 username 或 email"""
    username: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserInfo(BaseModel):
    """当前用户信息（含 SaaS 字段）"""
    id: int
    username: str
    email: Optional[str] = None
    is_active: bool = True
    plan: str = "trial"
    trial_ends_at: Optional[str] = None
    role: str = "user"
    status: str = "active"
    last_login_at: Optional[str] = None
    login_count: int = 0
    mp_auth_uin: Optional[str] = None
    mp_auth_at: Optional[str] = None


class UserCreate(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    """新用户注册：默认必须带 invite_code（受 setting allow_self_register 影响）"""
    email: str
    password: str
    username: Optional[str] = None
    invite_code: Optional[str] = None


class AdminUpdateUserRequest(BaseModel):
    """管理员修改用户：只传要改的字段。"""
    plan: Optional[str] = None
    is_active: Optional[bool] = None
    role: Optional[str] = None
    trial_ends_at: Optional[str] = None
    max_monitor_posts: Optional[int] = None
    status: Optional[str] = None              # active / disabled / deleted
    disabled_reason: Optional[str] = None
    quota_override: Optional[Dict[str, int]] = None  # 覆盖 plan 的额度，{"monitor_posts": 1000, ...}
    email: Optional[str] = None
    # P16: AI 模型权限白名单（JSON 数组的 ai_models.id；None 不动，[] 全禁，[1,3] 只允许指定）
    allowed_text_model_ids: Optional[list[int]] = None
    allowed_image_model_ids: Optional[list[int]] = None


class AdminCreateUserRequest(BaseModel):
    """管理员创建用户（无需邮箱验证 / 跳过试用引导）"""
    email: str
    password: str
    username: Optional[str] = None
    role: Optional[str] = "user"
    plan: Optional[str] = "team"
    max_monitor_posts: Optional[int] = 200


class ResetPasswordRequest(BaseModel):
    """admin 强制重置：可指定新密码，不指定则系统生成 12 位随机。"""
    new_password: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class CreateInviteRequest(BaseModel):
    plan: Optional[str] = "trial"
    max_uses: Optional[int] = 1
    expires_in_days: Optional[int] = 30
    note: Optional[str] = ""
