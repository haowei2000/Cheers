"""Auth v1 路由."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session, require_permission
from app.core.responses import APIResponse
from app.db.models import User
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])

# 角色与权限定义（与旧 auth/routes.py 保持一致）
ROLES = [
    {
        "name": "system_admin",
        "display_name": "系统管理员",
        "description": "系统级管理：全局 LLM 设置、策略配置、系统健康度检查",
        "permissions": {"user_management": False, "space_management": False, "channel_management": False, "bot_config": False, "system_settings": True},
    },
    {
        "name": "space_admin",
        "display_name": "空间管理员",
        "description": "本空间内：成员管理、频道创建、Bot配置",
        "permissions": {"user_management": False, "space_management": True, "channel_management": True, "bot_config": True, "system_settings": False},
    },
    {
        "name": "channel_admin",
        "display_name": "频道管理员",
        "description": "本频道内：成员管理、频道信息编辑、置顶消息",
        "permissions": {"user_management": False, "space_management": False, "channel_management": True, "bot_config": False, "system_settings": False},
    },
    {
        "name": "member",
        "display_name": "成员",
        "description": "发送消息、上传文件、@Bot",
        "permissions": {"user_management": False, "space_management": False, "channel_management": False, "bot_config": False, "system_settings": False},
    },
    {
        "name": "guest",
        "display_name": "访客",
        "description": "仅查看公开频道（不可发言）",
        "permissions": {"user_management": False, "space_management": False, "channel_management": False, "bot_config": False, "system_settings": False},
    },
]

VALID_ROLES = [r["name"] for r in ROLES]


class UserOut(BaseModel):
    model_config = {"from_attributes": True}
    user_id: str
    username: str
    display_name: str | None = None
    email: str | None = None
    role: str
    avatar_url: str | None = None
    bio: str | None = None
    created_at: str | None = None

    @classmethod
    def from_user(cls, user: User) -> "UserOut":
        return cls(
            user_id=user.user_id,
            username=user.username,
            display_name=user.display_name,
            email=user.email,
            role=user.role,
            avatar_url=user.avatar_url,
            bio=getattr(user, "bio", None),
            created_at=user.created_at.isoformat() if user.created_at else None,
        )


class LoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
    expires_in: int | None = None


# ---- Request bodies ----

class SendCodeBody(BaseModel):
    email: str
    purpose: str


class RegisterWithCodeBody(BaseModel):
    username: str
    email: str
    password: str
    code: str
    display_name: str | None = None


class RegisterBody(BaseModel):
    username: str
    password: str
    display_name: str | None = None
    email: str | None = None


class LoginBody(BaseModel):
    username: str
    password: str


class ForgotPasswordBody(BaseModel):
    email: str
    code: str
    new_password: str


class ChangePasswordBody(BaseModel):
    new_password: str
    current_password: str | None = None
    email_code: str | None = None


class UpdateProfileBody(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    avatar_url: str | None = None


class UpdateRoleBody(BaseModel):
    role: str


# ---- Routes ----

@router.post("/send-code", response_model=APIResponse[None])
async def send_verification_code(
    body: SendCodeBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    code = await svc.send_verification_code(body.email, body.purpose)
    from app.auth.email_service import send_verification_code as _send
    try:
        await _send(body.email.strip().lower(), code, body.purpose)
    except Exception:
        from app.core.exceptions import AppError
        raise AppError("验证码发送失败，请稍后重试")
    return APIResponse.ok(None, message="验证码已发送")


@router.post("/register-with-code", response_model=APIResponse[UserOut])
async def register_with_code(
    body: RegisterWithCodeBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.register_with_code(
        username=body.username,
        email=body.email,
        password=body.password,
        code=body.code,
        display_name=body.display_name,
    )
    return APIResponse.ok(UserOut.from_user(user))


@router.post("/register", response_model=APIResponse[UserOut])
async def register(
    body: RegisterBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.register(
        username=body.username,
        password=body.password,
        display_name=body.display_name,
        email=body.email,
    )
    return APIResponse.ok(UserOut.from_user(user))


@router.post("/login", response_model=APIResponse[LoginOut])
async def login(
    body: LoginBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.config import settings
    svc = AuthService(session)
    user, token = await svc.login(body.username, body.password)
    return APIResponse.ok(LoginOut(
        access_token=token,
        user=UserOut.from_user(user),
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    ))


@router.post("/forgot-password", response_model=APIResponse[None])
async def forgot_password(
    body: ForgotPasswordBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    await svc.forgot_password(body.email, body.code, body.new_password)
    return APIResponse.ok(None, message="密码已重置，请重新登录")


@router.get("/me", response_model=APIResponse[UserOut])
async def get_me(
    current_user: User = Depends(get_current_user),
) -> APIResponse:
    return APIResponse.ok(UserOut.from_user(current_user))


@router.patch("/me", response_model=APIResponse[UserOut])
async def update_profile(
    body: UpdateProfileBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.update_profile(
        current_user,
        display_name=body.display_name,
        bio=body.bio,
        avatar_url=body.avatar_url,
    )
    return APIResponse.ok(UserOut.from_user(user))


@router.put("/users/me", response_model=APIResponse[UserOut])
async def update_profile_put(
    body: UpdateProfileBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.update_profile(
        current_user,
        display_name=body.display_name,
        bio=body.bio,
        avatar_url=body.avatar_url,
    )
    return APIResponse.ok(UserOut.from_user(user))


@router.get("/users/me", response_model=APIResponse[UserOut])
async def get_me_legacy(
    current_user: User = Depends(get_current_user),
) -> APIResponse:
    return APIResponse.ok(UserOut.from_user(current_user))


@router.post("/change-password", response_model=APIResponse[None])
async def change_password(
    body: ChangePasswordBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    await svc.change_password(
        current_user,
        new_password=body.new_password,
        current_password=body.current_password,
        email_code=body.email_code,
    )
    return APIResponse.ok(None, message="密码已更新")


@router.put("/users/me/password", response_model=APIResponse[None])
async def change_password_put(
    body: ChangePasswordBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    await svc.change_password(
        current_user,
        new_password=body.new_password,
        current_password=body.current_password,
        email_code=body.email_code,
    )
    return APIResponse.ok(None, message="密码已更新")


@router.get("/roles", response_model=APIResponse[list[dict]])
async def list_roles() -> APIResponse:
    return APIResponse.ok(ROLES)


@router.get("/users", response_model=APIResponse[list[UserOut]])
async def list_users(
    _: User = Depends(require_permission("user_management")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    users = await svc.list_users()
    return APIResponse.ok([UserOut.from_user(u) for u in users])


@router.put("/users/{user_id}/role", response_model=APIResponse[UserOut])
async def update_user_role(
    user_id: str,
    body: UpdateRoleBody,
    _: User = Depends(require_permission("user_management")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.update_role(user_id, body.role, VALID_ROLES)
    return APIResponse.ok(UserOut.from_user(user))


@router.delete("/users/{user_id}", response_model=APIResponse[None])
async def delete_user(
    user_id: str,
    _: User = Depends(require_permission("user_management")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    await svc.delete_user(user_id)
    return APIResponse.ok(None, message="用户已删除")


@router.post("/users/reset-password/{user_id}", response_model=APIResponse[dict])
async def reset_password_admin(
    user_id: str,
    _: User = Depends(require_permission("user_management")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    temp_pw = await svc.reset_password_admin(user_id)
    return APIResponse.ok({"temporary_password": temp_pw}, message="密码已重置")
