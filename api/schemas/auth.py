# -*- coding: utf-8 -*-
"""
认证相关数据模型

定义用户认证所需的请求和响应模型，包括登录请求、Token响应等。
"""

from typing import Optional
from pydantic import BaseModel


class UserLogin(BaseModel):
    """用户登录请求模型 — username 字段同时支持 username 或 email"""
    username: str
    password: str


class Token(BaseModel):
    """Token响应模型"""
    access_token: str
    token_type: str = "bearer"


class UserInfo(BaseModel):
    """用户信息模型（含 SaaS 字段）"""
    id: int
    username: str
    email: Optional[str] = None
    is_active: bool = True
    plan: str = "trial"
    trial_ends_at: Optional[str] = None
    role: str = "user"
    # 公众号客户端凭证：返回是否已设（不返回原值，避免泄露）
    mp_auth_uin: Optional[str] = None
    mp_auth_at: Optional[str] = None


class UserCreate(BaseModel):
    """创建用户请求模型"""
    username: str
    password: str


class RegisterRequest(BaseModel):
    """新用户注册请求"""
    email: str
    password: str
    username: Optional[str] = None  # 不填则用 email 作为 username


class AdminUpdateUserRequest(BaseModel):
    """管理员修改用户"""
    plan: Optional[str] = None
    is_active: Optional[bool] = None
    role: Optional[str] = None
    trial_ends_at: Optional[str] = None
    max_monitor_posts: Optional[int] = None


class AdminCreateUserRequest(BaseModel):
    """管理员创建用户（无需邮箱验证 / 跳过试用引导）"""
    email: str
    password: str
    username: Optional[str] = None        # 不填用 email 作 username
    role: Optional[str] = "user"          # user / admin
    plan: Optional[str] = "team"          # 默认 team 不限
    max_monitor_posts: Optional[int] = 200
