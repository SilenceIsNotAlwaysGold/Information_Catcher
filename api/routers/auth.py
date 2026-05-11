# -*- coding: utf-8 -*-
"""认证路由：登录 / 注册 / me / admin 用户管理。

SaaS 升级：
- login 检查 status，更新 last_login + 写 audit
- register 必须带 invite_code（受 setting `allow_self_register` 控制；admin 创建无需）
- get_current_user 检查 status + token_revoked_at
- admin 端点：list（带用量）/ create / update / delete / reset_password / revoke_tokens
- 用户端：me / change-password / mp-auth
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from ..schemas.auth import (
    UserLogin, Token, UserInfo,
    RegisterRequest, AdminUpdateUserRequest, AdminCreateUserRequest,
    ResetPasswordRequest, ChangePasswordRequest, CreateInviteRequest,
)
from ..services.auth_service import (
    authenticate_user,
    create_access_token,
    verify_token,
    get_user_by_id,
    register_user,
    list_users,
    update_user_admin,
    update_login_stats,
    soft_delete_user,
    reset_user_password,
    revoke_user_tokens,
    change_password,
)
from ..services import audit_service, invite_service, monitor_db, quota_service

router = APIRouter(prefix="/auth", tags=["认证"])
security = HTTPBearer(auto_error=False)


def _client_meta(request: Optional[Request]) -> tuple[str, str]:
    if not request:
        return "", ""
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else ""
    )
    ua = request.headers.get("user-agent", "")[:300]
    return ip, ua


# ── 当前用户依赖 ────────────────────────────────────────────────────────────

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="未提供认证凭据",
                            headers={"WWW-Authenticate": "Bearer"})

    payload = verify_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=401, detail="Token 无效或已过期",
                            headers={"WWW-Authenticate": "Bearer"})

    user = get_user_by_id(payload.get("user_id"))
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")

    # 状态检查
    status = user.get("status") or "active"
    if status != "active":
        if status == "disabled":
            reason = user.get("disabled_reason") or ""
            raise HTTPException(
                status_code=403,
                detail=f"账号已被禁用{('：' + reason) if reason else ''}",
            )
        raise HTTPException(status_code=403, detail="账号不可用")

    # token 强制下线检查：iat 早于 token_revoked_at 即失效
    revoked_at = user.get("token_revoked_at")
    iat = payload.get("iat")
    if revoked_at and iat:
        try:
            iat_dt = datetime.fromisoformat(iat) if isinstance(iat, str) else None
            rev_dt = datetime.fromisoformat(revoked_at)
            if iat_dt and iat_dt < rev_dt:
                raise HTTPException(status_code=401, detail="登录态已被管理员撤销，请重新登录")
        except HTTPException:
            raise
        except Exception:
            pass

    return user


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict | None:
    if not credentials:
        return None
    try:
        return await get_current_user(credentials)
    except HTTPException:
        return None


async def get_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    if (current_user.get("role") or "user") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return current_user


# ── 登录 / 注册 / 登出 ──────────────────────────────────────────────────────

def _issue_token(user: dict) -> Token:
    """登录成功后签发 token。带 iat 字段，方便强制下线判断。"""
    issued_at = datetime.utcnow().isoformat()
    access_token = create_access_token(data={
        "user_id": user["id"],
        "username": user["username"],
        "role": user.get("role", "user"),
        "iat": issued_at,
    })
    return Token(access_token=access_token, token_type="bearer")


@router.post("/login", response_model=Token, summary="用户登录")
async def login(request_body: UserLogin, request: Request):
    ip, ua = _client_meta(request)
    user = authenticate_user(request_body.username, request_body.password)

    if not user:
        await audit_service.log(
            actor_username=request_body.username[:64],
            action="login.failed",
            metadata={"reason": "invalid_credentials"},
            ip=ip, user_agent=ua,
        )
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if user.get("_disabled"):
        await audit_service.log(
            actor_id=user.get("id"),
            actor_username=user.get("username", ""),
            action="login.failed",
            metadata={"reason": "account_disabled", "status": user.get("status")},
            ip=ip, user_agent=ua,
        )
        reason = user.get("disabled_reason") or ""
        msg = f"账号已被禁用{('：' + reason) if reason else ''}"
        if user.get("status") == "deleted":
            msg = "账号已被删除，请联系管理员"
        raise HTTPException(status_code=403, detail=msg)

    update_login_stats(user["id"])
    await audit_service.log(
        actor=user, action="login.success",
        ip=ip, user_agent=ua,
    )
    return _issue_token(user)


@router.post("/register", response_model=Token, summary="新用户注册")
async def register(request_body: RegisterRequest, request: Request):
    """注册新用户。

    流程：
    1. 检查 setting `allow_self_register`：若为 false，必须带 `invite_code`。
       未设置时默认开启自助注册（向后兼容）。
    2. 带了 invite_code → 校验 + 消费，注册时 plan 用邀请码指定值。
    3. 未带 invite_code（且开放自助）→ 走 trial 默认。
    """
    ip, ua = _client_meta(request)
    email = (request_body.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if not request_body.password or len(request_body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")

    allow_self = (await monitor_db.get_setting("allow_self_register", "1")).strip()
    self_register_enabled = allow_self in ("1", "true", "yes")
    invite_code = (request_body.invite_code or "").strip().upper()

    invited_plan = None
    invite_record = None
    if invite_code:
        invite_record = await invite_service.consume(invite_code)
        if not invite_record:
            raise HTTPException(status_code=400, detail="邀请码无效或已用完 / 过期")
        invited_plan = invite_record.get("plan") or "trial"
    elif not self_register_enabled:
        raise HTTPException(status_code=403, detail="自助注册已关闭，请联系管理员获取邀请码")

    user = register_user(email, request_body.password, request_body.username)
    if not user:
        # 邀请码已 +1，但注册失败 → 不能撤回（防止滥用），管理员可手动 +max_uses
        raise HTTPException(status_code=400, detail="该邮箱或用户名已被注册")

    if invited_plan:
        update_user_admin(user["id"], plan=invited_plan)
        user["plan"] = invited_plan

    await audit_service.log(
        actor=user, action="register.success",
        metadata={
            "email": email,
            "invite_code": invite_code or None,
            "plan": invited_plan or user.get("plan"),
        },
        ip=ip, user_agent=ua,
    )

    update_login_stats(user["id"])
    return _issue_token(user)


@router.post("/logout", summary="用户登出")
async def logout(request: Request, current_user: dict = Depends(get_current_user)):
    ip, ua = _client_meta(request)
    await audit_service.log(actor=current_user, action="logout", ip=ip, user_agent=ua)
    return {"message": "登出成功"}


# ── 当前用户 ────────────────────────────────────────────────────────────────

@router.get("/me", response_model=UserInfo, summary="获取当前用户")
async def get_me(current_user: dict = Depends(get_current_user)):
    return UserInfo(**current_user)


@router.get("/me/usage", summary="当前用户的套餐 + 用量")
async def get_my_usage(current_user: dict = Depends(get_current_user)):
    return await quota_service.get_usage_summary(current_user)


@router.post("/me/change-password", summary="用户自己改密码")
async def my_change_password(
    req: ChangePasswordRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    if not req.old_password or not req.new_password:
        raise HTTPException(status_code=400, detail="原密码和新密码都必填")
    ok, err = change_password(current_user["id"], req.old_password, req.new_password)
    if not ok:
        raise HTTPException(status_code=400, detail=err)
    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="user.password_change.self",
        ip=ip, user_agent=ua,
    )
    return {"ok": True}


# ── 公众号凭证（用户自己改） ─────────────────────────────────────────────────

from pydantic import BaseModel as _BM


class UpdateMpAuthRequest(_BM):
    uin: Optional[str] = None
    key: Optional[str] = None
    pass_ticket: Optional[str] = None
    appmsg_token: Optional[str] = None


@router.put("/me/mp-auth", summary="更新公众号客户端凭证")
async def update_my_mp_auth(
    req: UpdateMpAuthRequest,
    current_user: dict = Depends(get_current_user),
):
    from ..services.auth_service import update_user_mp_auth
    update_user_mp_auth(
        current_user["id"],
        uin=req.uin, key=req.key,
        pass_ticket=req.pass_ticket, appmsg_token=req.appmsg_token,
    )
    return {"ok": True}


# ── 管理员路由 ───────────────────────────────────────────────────────────────

@router.get("/admin/users", summary="管理员：用户列表（带用量）")
async def admin_list_users(
    include_deleted: bool = Query(False),
    with_usage: bool = Query(True),
    current_user: dict = Depends(get_admin_user),
):
    rows = list_users(include_deleted=include_deleted)
    if with_usage:
        for r in rows:
            try:
                # 透传 quota_override_json 给 quota_service
                r["usage"] = await quota_service.get_usage_summary(r)
            except Exception:
                r["usage"] = None
    return {"users": rows}


@router.post("/admin/users", summary="管理员：创建用户")
async def admin_create_user(
    req: AdminCreateUserRequest,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if not req.password or len(req.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    user = register_user(email, req.password, req.username)
    if not user:
        raise HTTPException(status_code=400, detail="该邮箱或用户名已被注册")

    update_kwargs: dict = {"trial_ends_at": None}  # admin 创建的不走试用
    if req.role and req.role != "user":
        update_kwargs["role"] = req.role
    if req.plan:
        update_kwargs["plan"] = req.plan
    if req.max_monitor_posts is not None:
        update_kwargs["max_monitor_posts"] = req.max_monitor_posts
    update_user_admin(user["id"], **update_kwargs)

    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="user.create",
        target_type="user", target_id=user["id"],
        metadata={"email": email, "role": req.role, "plan": req.plan},
        ip=ip, user_agent=ua,
    )
    return {"ok": True, "id": user["id"]}


@router.patch("/admin/users/{user_id}", summary="管理员：更新用户")
async def admin_update_user(
    user_id: int,
    req: AdminUpdateUserRequest,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    if user_id == current_user["id"] and (req.status in ("disabled", "deleted")
                                          or req.is_active is False
                                          or req.role == "user"):
        raise HTTPException(
            status_code=400,
            detail="不能禁用 / 删除 / 降级自己的账号",
        )

    payload = req.model_dump(exclude_none=True)
    quota_override = payload.pop("quota_override", None)
    if quota_override is not None:
        # 空字典 → 清空（恢复到 plan 默认）
        payload["quota_override_json"] = (
            json.dumps(quota_override, ensure_ascii=False) if quota_override else ""
        )
    # 模型白名单：list[int] → JSON 字符串入库；None 不动；[] = 清空白名单（默认允许所有）
    for key in ("allowed_text_model_ids", "allowed_image_model_ids"):
        if key in payload and payload[key] is not None:
            payload[key] = json.dumps(payload[key]) if payload[key] else ""
    if "is_active" in payload and isinstance(payload["is_active"], bool):
        payload["is_active"] = 1 if payload["is_active"] else 0
    update_user_admin(user_id, **payload)

    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="user.update",
        target_type="user", target_id=user_id,
        metadata=payload,
        ip=ip, user_agent=ua,
    )
    return {"ok": True}


@router.delete("/admin/users/{user_id}", summary="管理员：软删除用户")
async def admin_delete_user(
    user_id: int,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")
    ok = soft_delete_user(user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="user.delete",
        target_type="user", target_id=user_id,
        ip=ip, user_agent=ua,
    )
    return {"ok": True}


@router.post("/admin/users/{user_id}/reset-password", summary="管理员：强制重置密码")
async def admin_reset_password(
    user_id: int,
    req: ResetPasswordRequest,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    new_password = (req.new_password or "").strip() or _gen_random_password()
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="新密码至少 6 位")
    ok = reset_user_password(user_id, new_password)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="user.password_reset",
        target_type="user", target_id=user_id,
        ip=ip, user_agent=ua,
    )
    return {"ok": True, "new_password": new_password}


@router.post("/admin/users/{user_id}/revoke-tokens", summary="管理员：强制下线")
async def admin_revoke_tokens(
    user_id: int,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    if user_id == current_user["id"]:
        raise HTTPException(status_code=400, detail="不能强制下线自己")
    ok = revoke_user_tokens(user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="用户不存在")
    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="user.revoke_tokens",
        target_type="user", target_id=user_id,
        ip=ip, user_agent=ua,
    )
    return {"ok": True}


# ── 邀请码：admin CRUD ──────────────────────────────────────────────────────

@router.get("/admin/invites", summary="管理员：邀请码列表")
async def admin_list_invites(_: dict = Depends(get_admin_user)):
    return {"invites": await invite_service.list_all(limit=200)}


@router.post("/admin/invites", summary="管理员：生成邀请码")
async def admin_create_invite(
    req: CreateInviteRequest,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    rec = await invite_service.create(
        created_by=current_user["id"],
        plan=req.plan or "trial",
        max_uses=int(req.max_uses or 1),
        expires_in_days=req.expires_in_days,
        note=req.note or "",
    )
    ip, ua = _client_meta(request)
    await audit_service.log(
        actor=current_user, action="invite.create",
        target_type="invite", target_id=rec["code"],
        metadata=rec,
        ip=ip, user_agent=ua,
    )
    return rec


@router.delete("/admin/invites/{code}", summary="管理员：删除邀请码")
async def admin_delete_invite(
    code: str,
    request: Request,
    current_user: dict = Depends(get_admin_user),
):
    ok = await invite_service.delete(code)
    ip, ua = _client_meta(request)
    if ok:
        await audit_service.log(
            actor=current_user, action="invite.delete",
            target_type="invite", target_id=code,
            ip=ip, user_agent=ua,
        )
    return {"ok": ok}


# ── 审计日志：admin 查询 ────────────────────────────────────────────────────

@router.get("/admin/audit", summary="管理员：审计日志")
async def admin_audit(
    actor_id: Optional[int] = Query(None),
    action: Optional[str] = Query(None),
    target_type: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _: dict = Depends(get_admin_user),
):
    items = await audit_service.list_logs(
        actor_id=actor_id, action=action, target_type=target_type,
        since=since, limit=limit, offset=offset,
    )
    total = await audit_service.count_logs(
        actor_id=actor_id, action=action, target_type=target_type, since=since,
    )
    return {"items": items, "total": total, "limit": limit, "offset": offset}


# ── 公开：自助注册开关查询 ──────────────────────────────────────────────────

@router.get("/public/register-config", summary="注册页用：是否开放自助注册")
async def public_register_config():
    """前端注册页据此决定 invite_code 字段是否必填。"""
    allow = (await monitor_db.get_setting("allow_self_register", "1")).strip()
    return {"allow_self_register": allow in ("1", "true", "yes")}


# ── 内部 helper ─────────────────────────────────────────────────────────────

def _gen_random_password(length: int = 12) -> str:
    """生成临时密码：去歧义字符 + 至少含数字 + 字母。"""
    pool = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz"
    while True:
        pwd = "".join(secrets.choice(pool) for _ in range(length))
        if any(c.isdigit() for c in pwd) and any(c.isalpha() for c in pwd):
            return pwd
