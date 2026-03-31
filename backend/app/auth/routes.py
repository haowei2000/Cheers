"""认证模块：用户注册、登录、角色管理."""
import logging
import random
import re
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, status
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.jwt_utils import create_access_token, decode_access_token
from app.db.models import EmailCode, User
from app.db.session import async_session_factory, get_session

logger = logging.getLogger("app.auth")

router = APIRouter(prefix="/api/auth", tags=["认证"])

# 密码加密上下文
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# 角色定义
ROLE_SYSTEM_ADMIN = "system_admin"
ROLE_SPACE_ADMIN = "space_admin"
ROLE_CHANNEL_ADMIN = "channel_admin"
ROLE_MEMBER = "member"
ROLE_GUEST = "guest"

ROLES = [ROLE_SYSTEM_ADMIN, ROLE_SPACE_ADMIN, ROLE_CHANNEL_ADMIN, ROLE_MEMBER, ROLE_GUEST]

# 角色权限映射
ROLE_PERMISSIONS = {
    ROLE_SYSTEM_ADMIN: {
        "user_management": False,
        "space_management": False,
        "channel_management": False,
        "bot_config": False,
        "system_settings": True,
    },
    ROLE_SPACE_ADMIN: {
        "user_management": False,
        "space_management": True,
        "channel_management": True,
        "bot_config": True,
        "system_settings": False,
    },
    ROLE_CHANNEL_ADMIN: {
        "user_management": False,
        "space_management": False,
        "channel_management": True,
        "bot_config": False,
        "system_settings": False,
    },
    ROLE_MEMBER: {
        "user_management": False,
        "space_management": False,
        "channel_management": False,
        "bot_config": False,
        "system_settings": False,
    },
    ROLE_GUEST: {
        "user_management": False,
        "space_management": False,
        "channel_management": False,
        "bot_config": False,
        "system_settings": False,
    },
}


def validate_password(password: str) -> None:
    """校验密码强度：至少8位，包含字母和数字。"""
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="密码不符合要求：至少 8 位")
    if not re.search(r"[A-Za-z]", password):
        raise HTTPException(status_code=400, detail="密码不符合要求：需包含字母")
    if not re.search(r"\d", password):
        raise HTTPException(status_code=400, detail="密码不符合要求：需包含数字")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


# 权限字典（permission -> 拥有该权限的角色列表）
PERMISSIONS: dict[str, list[str]] = {
    perm: [role for role, perms in ROLE_PERMISSIONS.items() if perms.get(perm)]
    for perm in ["user_management", "space_management", "channel_management", "bot_config", "system_settings"]
}


async def _resolve_user_from_token(token: str, db: AsyncSession) -> Optional[User]:
    user_id: str | None = None
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token 已过期，请重新登录")
    except jwt.InvalidTokenError:
        logger.warning("JWT 解码失败，尝试 UUID 回退（旧版兼容，请更新客户端）")
        user_id = token

    if not user_id:
        return None
    result = await db.execute(select(User).where(User.user_id == user_id))
    return result.scalar_one_or_none()


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    token = authorization.removeprefix("Bearer ").strip()
    user = await _resolve_user_from_token(token, db)
    if not user:
        raise HTTPException(status_code=401, detail="无效 Token")
    return user


async def try_get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> Optional[User]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    try:
        return await _resolve_user_from_token(token, db)
    except HTTPException:
        return None


def require_permission(permission: str):
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        allowed = PERMISSIONS.get(permission, [])
        if current_user.role not in allowed:
            raise HTTPException(status_code=403, detail="权限不足")
        return current_user
    return _check


# ============ OTP helpers ============

_OTP_VALID_PURPOSES = {"register", "reset_password", "change_password"}
_OTP_COOLDOWN_SECONDS = 60      # 同一邮箱同一用途最短间隔
_OTP_EXPIRE_MINUTES = 10


def _gen_code() -> str:
    return "".join(random.choices(string.digits, k=6))


async def _issue_code(db: AsyncSession, email: str, purpose: str) -> str:
    """生成并存储验证码，返回明文验证码。限速：同邮箱+用途 60s 内不重复发。"""
    now = datetime.now(timezone.utc)
    cooldown_threshold = now - timedelta(seconds=_OTP_COOLDOWN_SECONDS)
    recent = await db.execute(
        select(EmailCode).where(
            EmailCode.email == email,
            EmailCode.purpose == purpose,
            EmailCode.created_at >= cooldown_threshold,
        )
    )
    if recent.scalar_one_or_none():
        raise HTTPException(status_code=429, detail=f"请 {_OTP_COOLDOWN_SECONDS} 秒后再发送")

    code = _gen_code()
    entry = EmailCode(
        email=email,
        code=code,
        purpose=purpose,
        expires_at=now + timedelta(minutes=_OTP_EXPIRE_MINUTES),
    )
    db.add(entry)
    await db.flush()
    return code


async def _verify_code(db: AsyncSession, email: str, purpose: str, code: str) -> None:
    """校验验证码；通过后标记为已使用。失败抛 400。"""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(EmailCode).where(
            EmailCode.email == email,
            EmailCode.purpose == purpose,
            EmailCode.code == code,
            EmailCode.used == False,
            EmailCode.expires_at > now,
        ).order_by(EmailCode.created_at.desc()).limit(1)
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=400, detail="验证码无效或已过期")
    entry.used = True
    await db.flush()


# ============ Schemas ============

class SendCodeRequest(BaseModel):
    email: str
    purpose: str  # register | reset_password | change_password


class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str
    code: str
    display_name: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    user_id: str
    username: str
    display_name: Optional[str]
    role: str
    token: str
    expires_in: int


class UserInfo(BaseModel):
    user_id: str
    username: str
    email: Optional[str] = None
    display_name: Optional[str]
    role: str
    avatar_url: Optional[str]
    created_at: str
    bio: Optional[str] = None


class UpdateProfileRequest(BaseModel):
    display_name: Optional[str] = None
    bio: Optional[str] = None


class ChangePasswordRequest(BaseModel):
    """修改密码：传 current_password（旧密码验证）或 email_code（邮箱验证），二选一。"""
    new_password: str
    current_password: Optional[str] = None
    email_code: Optional[str] = None


class ForgotPasswordRequest(BaseModel):
    email: str
    code: str
    new_password: str


class UpdateRoleRequest(BaseModel):
    user_id: str
    role: str


# ============ Routes ============

def _user_to_info(user: User) -> UserInfo:
    return UserInfo(
        user_id=user.user_id,
        username=user.username,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        avatar_url=user.avatar_url,
        created_at=user.created_at.isoformat(),
        bio=user.bio,
    )


@router.post("/send-code")
async def send_verification_code(
    req: SendCodeRequest,
    db: AsyncSession = Depends(get_session),
):
    """发送邮件验证码。

    - purpose=register：邮箱不能已注册
    - purpose=reset_password：邮箱必须已注册
    - purpose=change_password：邮箱必须已注册（由前端传入已登录用户的邮箱）
    """
    if req.purpose not in _OTP_VALID_PURPOSES:
        raise HTTPException(status_code=400, detail="无效的 purpose")

    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")

    result = await db.execute(select(User).where(User.email == email))
    existing = result.scalar_one_or_none()

    if req.purpose == "register" and existing:
        raise HTTPException(status_code=400, detail="该邮箱已被注册")
    if req.purpose in ("reset_password", "change_password") and not existing:
        raise HTTPException(status_code=404, detail="该邮箱未注册")

    code = await _issue_code(db, email, req.purpose)
    await db.commit()

    from app.auth.email_service import send_verification_code as _send
    try:
        await _send(email, code, req.purpose)
    except Exception:
        raise HTTPException(status_code=500, detail="验证码发送失败，请稍后重试")

    return {"status": "success", "message": "验证码已发送"}


@router.get("/users/me", response_model=UserInfo)
async def get_my_profile(current_user: User = Depends(get_current_user)) -> UserInfo:
    return _user_to_info(current_user)


@router.put("/users/me", response_model=UserInfo)
async def update_my_profile(
    req: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
) -> UserInfo:
    if req.display_name is not None:
        current_user.display_name = req.display_name
    if req.bio is not None:
        current_user.bio = req.bio
    await db.commit()
    await db.refresh(current_user)
    return _user_to_info(current_user)


@router.put("/users/me/password")
async def change_my_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """修改密码：传 current_password 或 email_code（二选一）。"""
    if not req.current_password and not req.email_code:
        raise HTTPException(status_code=400, detail="需提供当前密码或邮箱验证码")

    validate_password(req.new_password)

    if req.email_code:
        if not current_user.email:
            raise HTTPException(status_code=400, detail="账号未绑定邮箱，无法使用邮箱验证")
        await _verify_code(db, current_user.email, "change_password", req.email_code)
    else:
        if not verify_password(req.current_password, current_user.password_hash):
            raise HTTPException(status_code=400, detail="当前密码不正确")

    current_user.password_hash = hash_password(req.new_password)
    await db.commit()
    return {"status": "success", "message": "密码已更新"}


@router.post("/register", response_model=UserInfo)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_session)):
    """用户注册（必须通过邮箱验证码）."""
    validate_password(req.password)

    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")

    # 验证码校验
    await _verify_code(db, email, "register", req.code)

    # 用户名唯一
    result = await db.execute(select(User).where(User.username == req.username))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="用户名已存在")

    # 邮箱唯一（理论上 send-code 时已判断，这里双保险）
    result = await db.execute(select(User).where(User.email == email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该邮箱已被注册")

    user = User(
        username=req.username,
        email=email,
        password_hash=hash_password(req.password),
        display_name=req.display_name or req.username,
        role=ROLE_MEMBER,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _user_to_info(user)


@router.post("/forgot-password")
async def forgot_password(
    req: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_session),
):
    """通过邮箱验证码重置密码。"""
    email = req.email.strip().lower()
    validate_password(req.new_password)

    await _verify_code(db, email, "reset_password", req.code)

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    user.password_hash = hash_password(req.new_password)
    await db.commit()
    return {"status": "success", "message": "密码已重置，请重新登录"}


@router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest, db: AsyncSession = Depends(get_session)):
    """用户登录（用户名/邮箱 + 密码）."""
    # 支持用用户名或邮箱登录
    result = await db.execute(
        select(User).where(
            (User.username == req.username) | (User.email == req.username.strip().lower())
        )
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名/邮箱或密码错误")

    from app.config import settings
    return LoginResponse(
        user_id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        token=create_access_token(user.user_id, user.role),
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    )


@router.get("/users", response_model=list[UserInfo])
async def list_users(
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(select(User))
    return [_user_to_info(u) for u in result.scalars().all()]


@router.put("/users/{user_id}/role", response_model=UserInfo)
async def update_user_role(
    user_id: str,
    req: UpdateRoleRequest,
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    if req.role not in ROLES:
        raise HTTPException(status_code=400, detail=f"无效的角色: {req.role}")
    result = await db.execute(select(User).where(User.user_id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    user.role = req.role
    await db.commit()
    await db.refresh(user)
    return _user_to_info(user)


@router.get("/roles")
async def list_roles():
    return {
        "roles": [
            {
                "name": "system_admin",
                "display_name": "系统管理员",
                "description": "系统级管理：全局 LLM 设置、策略配置、系统健康度检查",
                "permissions": ROLE_PERMISSIONS[ROLE_SYSTEM_ADMIN],
            },
            {
                "name": "space_admin",
                "display_name": "空间管理员",
                "description": "本空间内：成员管理、频道创建、Bot配置",
                "permissions": ROLE_PERMISSIONS[ROLE_SPACE_ADMIN],
            },
            {
                "name": "channel_admin",
                "display_name": "频道管理员",
                "description": "本频道内：成员管理、频道信息编辑、置顶消息",
                "permissions": ROLE_PERMISSIONS[ROLE_CHANNEL_ADMIN],
            },
            {
                "name": "member",
                "display_name": "成员",
                "description": "发送消息、上传文件、@Bot",
                "permissions": ROLE_PERMISSIONS[ROLE_MEMBER],
            },
            {
                "name": "guest",
                "display_name": "访客",
                "description": "仅查看公开频道（不可发言）",
                "permissions": ROLE_PERMISSIONS[ROLE_GUEST],
            },
        ]
    }


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    result = await db.execute(select(User).where(User.user_id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    await db.delete(user)
    await db.commit()
    return {"status": "success", "message": "用户已删除"}


@router.post("/users/reset-password/{user_id}")
async def reset_password_admin(
    user_id: str,
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    """管理员重置用户密码（生成临时密码）."""
    result = await db.execute(select(User).where(User.user_id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    temp_pw = secrets.token_urlsafe(12)
    user.password_hash = hash_password(temp_pw)
    await db.commit()
    return {"status": "success", "message": "密码已重置", "temporary_password": temp_pw}
