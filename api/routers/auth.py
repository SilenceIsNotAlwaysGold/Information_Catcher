# -*- coding: utf-8 -*-
"""
认证路由模块

提供用户认证相关的API端点：
- POST /auth/login - 用户登录
- GET /auth/me - 获取当前用户信息
- POST /auth/logout - 用户登出
"""

from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from ..schemas.auth import (
    UserLogin, Token, UserInfo,
    RegisterRequest, AdminUpdateUserRequest,
)
from ..services.auth_service import (
    authenticate_user,
    create_access_token,
    verify_token,
    get_user_by_id,
    register_user,
    list_users,
    update_user_admin,
)

router = APIRouter(prefix="/auth", tags=["认证"])

# Bearer Token 安全方案
security = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict:
    """
    获取当前登录用户
    
    从请求头中提取Token并验证，返回用户信息
    用于需要认证的接口依赖注入
    """
    if not credentials:
        raise HTTPException(
            status_code=401,
            detail="未提供认证凭据",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    token = credentials.credentials
    payload = verify_token(token)
    
    if not payload:
        raise HTTPException(
            status_code=401,
            detail="Token无效或已过期",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    user = get_user_by_id(payload.get("user_id"))
    if not user:
        raise HTTPException(
            status_code=401,
            detail="用户不存在",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    return user


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict | None:
    """
    可选获取当前用户
    
    不强制要求认证，用于部分公开接口
    """
    if not credentials:
        return None
    
    try:
        return await get_current_user(credentials)
    except HTTPException:
        return None


@router.post("/login", response_model=Token, summary="用户登录")
async def login(request: UserLogin):
    """
    用户登录接口
    
    - **username**: 用户名
    - **password**: 密码
    
    返回JWT访问令牌
    """
    print(f"[Auth] 登录请求: username={request.username}")
    user = authenticate_user(request.username, request.password)
    
    if not user:
        print(f"[Auth] 登录失败: 用户名或密码错误")
        raise HTTPException(
            status_code=401,
            detail="用户名或密码错误"
        )
    
    # 生成Token (含 role，方便前端判断是否管理员)
    access_token = create_access_token(
        data={
            "user_id": user["id"],
            "username": user["username"],
            "role": user.get("role", "user"),
        }
    )
    return Token(access_token=access_token, token_type="bearer")


@router.post("/register", response_model=Token, summary="新用户注册")
async def register(request: RegisterRequest):
    """注册新用户，自动开 7 天试用，返回 token 直接登录。"""
    if not request.email.strip() or not request.password:
        raise HTTPException(status_code=400, detail="邮箱和密码不能为空")
    if "@" not in request.email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if len(request.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    user = register_user(request.email.strip().lower(), request.password, request.username)
    if not user:
        raise HTTPException(status_code=400, detail="该邮箱或用户名已被注册")
    token = create_access_token(
        data={"user_id": user["id"], "username": user["username"], "role": user["role"]}
    )
    return Token(access_token=token, token_type="bearer")


# ── 管理员路由 ───────────────────────────────────────────────────────────────

async def get_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return current_user


@router.get("/admin/users", summary="管理员：用户列表")
async def admin_list_users(_: dict = Depends(get_admin_user)):
    return {"users": list_users()}


@router.patch("/admin/users/{user_id}", summary="管理员：更新用户")
async def admin_update_user(
    user_id: int,
    req: AdminUpdateUserRequest,
    _: dict = Depends(get_admin_user),
):
    payload = req.model_dump(exclude_none=True)
    # bool → 0/1
    if "is_active" in payload and isinstance(payload["is_active"], bool):
        payload["is_active"] = 1 if payload["is_active"] else 0
    update_user_admin(user_id, **payload)
    return {"ok": True}


@router.get("/me", response_model=UserInfo, summary="获取当前用户")
async def get_me(current_user: dict = Depends(get_current_user)):
    """
    获取当前登录用户信息
    
    需要Bearer Token认证
    """
    return UserInfo(**current_user)


@router.post("/logout", summary="用户登出")
async def logout(current_user: dict = Depends(get_current_user)):
    """
    用户登出
    
    客户端应删除本地存储的Token
    """
    return {"message": "登出成功"}
