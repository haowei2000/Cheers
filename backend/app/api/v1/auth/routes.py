"""Auth API routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.builtin_defaults import seed_workspace_defaults
from app.core.dependencies import get_current_user, get_session
from app.core.localization import locale_from_headers
from app.core.responses import APIResponse
from app.db.models import User
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])

_DEFAULT_ADMIN_DISPLAY_NAMES = {"System Administrator", "系统管理员"}


def _localized_admin_display_name(locale: str | None) -> str:
    if settings.admin_display_name in _DEFAULT_ADMIN_DISPLAY_NAMES:
        return seed_workspace_defaults(locale)["admin_display_name"]
    return settings.admin_display_name


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
    def from_user(cls, user: User, locale: str | None = None) -> "UserOut":
        display_name = user.display_name
        if (
            user.role == "system_admin"
            and user.username == settings.admin_username
            and (not display_name or display_name in _DEFAULT_ADMIN_DISPLAY_NAMES or display_name == settings.admin_display_name)
        ):
            display_name = _localized_admin_display_name(locale)
        return cls(
            user_id=user.user_id,
            username=user.username,
            display_name=display_name,
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


# ---- Routes ----

@router.post("/send-code", response_model=APIResponse[None])
async def send_verification_code(
    body: SendCodeBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    code = await svc.send_verification_code(body.email, body.purpose)
    from app.services.auth.email_service import send_verification_code as _send
    try:
        await _send(body.email.strip().lower(), code, body.purpose)
    except Exception:
        from app.core.exceptions import AppError
        raise AppError("验证码发送失败，请稍后重试")
    return APIResponse.ok(None, message="验证码已发送")


@router.post("/register", response_model=APIResponse[UserOut])
async def register(
    body: RegisterBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.register(
        username=body.username,
        password=body.password,
        display_name=body.display_name,
        email=body.email,
    )
    return APIResponse.ok(UserOut.from_user(user, locale_from_headers(request.headers)))


@router.post("/login", response_model=APIResponse[LoginOut])
async def login(
    body: LoginBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user, token = await svc.login(body.username, body.password)
    return APIResponse.ok(LoginOut(
        access_token=token,
        user=UserOut.from_user(user, locale_from_headers(request.headers)),
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


@router.get("/users/me", response_model=APIResponse[UserOut])
async def get_me(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> APIResponse:
    return APIResponse.ok(UserOut.from_user(current_user, locale_from_headers(request.headers)))


@router.put("/users/me", response_model=APIResponse[UserOut])
async def update_profile(
    body: UpdateProfileBody,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AuthService(session)
    user = await svc.update_profile(
        current_user,
        display_name=body.display_name,
        bio=body.bio,
        avatar_url=body.avatar_url,
        avatar_url_provided="avatar_url" in body.model_fields_set,
    )
    return APIResponse.ok(UserOut.from_user(user, locale_from_headers(request.headers)))


@router.put("/users/me/password", response_model=APIResponse[None])
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


@router.delete("/users/me", response_model=APIResponse[None])
async def delete_my_account(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    try:
        from app.api.v1.avatars.routes import _get_avatar_storage
        from app.services.avatar_service import AvatarService

        await AvatarService(session, _get_avatar_storage()).delete_user_avatar(current_user)
    except Exception:
        # Account deactivation must not be blocked by an already-missing avatar
        # object or by deployments without avatar storage enabled.
        pass
    await AuthService(session).deactivate_account(current_user)
    return APIResponse.ok(None, message="账号已停用")

