"""Auth 业务逻辑层."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ConflictError, NotFoundError, UnauthorizedError
from app.db.models import EmailCode, User
from app.repositories.user_repo import UserRepository
from app.services.auth.jwt_utils import create_access_token
from app.services.auth.password_utils import hash_password as _hash_password
from app.services.auth.password_utils import verify_password as _verify_password

_OTP_COOLDOWN_SECONDS = 60
_OTP_EXPIRE_MINUTES = 10
_OTP_VALID_PURPOSES = {"register", "reset_password", "change_password"}


def _validate_password(password: str) -> None:
    if len(password) < 8:
        raise BadRequestError("密码不符合要求：至少 8 位")
    if not re.search(r"[A-Za-z]", password):
        raise BadRequestError("密码不符合要求：需包含字母")
    if not re.search(r"\d", password):
        raise BadRequestError("密码不符合要求：需包含数字")


class AuthService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.user_repo = UserRepository(session)

    # ---- Registration / Login ----

    async def send_verification_code(self, email: str, purpose: str) -> str:
        """生成验证码并存储，返回明文（调用方负责发送邮件）。"""
        if purpose not in _OTP_VALID_PURPOSES:
            raise BadRequestError("无效的 purpose")
        email = email.strip().lower()
        if not email or "@" not in email:
            raise BadRequestError("邮箱格式不正确")

        existing = await self.user_repo.get_by_email(email)
        if purpose == "register" and existing:
            raise ConflictError("该邮箱已被注册")
        if purpose in ("reset_password", "change_password") and not existing:
            raise NotFoundError("该邮箱未注册")

        now = datetime.now(timezone.utc)
        cooldown_threshold = now - timedelta(seconds=_OTP_COOLDOWN_SECONDS)
        recent = await self.session.execute(
            select(EmailCode).where(
                EmailCode.email == email,
                EmailCode.purpose == purpose,
                EmailCode.created_at >= cooldown_threshold,
            )
        )
        if recent.scalar_one_or_none():
            raise BadRequestError(f"请 {_OTP_COOLDOWN_SECONDS} 秒后再发送")

        import random
        import string
        code = "".join(random.choices(string.digits, k=6))
        entry = EmailCode(
            email=email,
            code=code,
            purpose=purpose,
            expires_at=now + timedelta(minutes=_OTP_EXPIRE_MINUTES),
        )
        self.session.add(entry)
        await self.session.flush()
        return code

    async def _verify_code(self, email: str, purpose: str, code: str) -> None:
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(EmailCode).where(
                EmailCode.email == email,
                EmailCode.purpose == purpose,
                EmailCode.code == code,
                EmailCode.used.is_(False),
                EmailCode.expires_at > now,
            ).order_by(EmailCode.created_at.desc()).limit(1)
        )
        entry = result.scalar_one_or_none()
        if not entry:
            raise BadRequestError("验证码无效或已过期")
        entry.used = True
        await self.session.flush()

    async def register(
        self,
        username: str,
        password: str,
        display_name: Optional[str] = None,
        email: Optional[str] = None,
    ) -> User:
        """直接注册（无需验证码，用于开发/内部用途）."""
        username = username.strip()
        if not username:
            raise BadRequestError("用户名不能为空")
        _validate_password(password)
        if await self.user_repo.get_by_username(username):
            raise ConflictError(f"用户名 '{username}' 已被注册")
        if email:
            if await self.user_repo.get_by_email(email):
                raise ConflictError("该邮箱已被注册")
        return await self.user_repo.create(
            username=username,
            password_hash=_hash_password(password),
            display_name=display_name or username,
            email=email,
        )

    async def login(self, username: str, password: str) -> tuple[User, str]:
        """用用户名或邮箱登录，返回 (user, access_token)."""
        from sqlalchemy import or_
        result = await self.session.execute(
            select(User).where(
                or_(User.username == username, User.email == username.strip().lower())
            )
        )
        user = result.scalar_one_or_none()
        if not user or not _verify_password(password, user.password_hash):
            raise UnauthorizedError("用户名/邮箱或密码错误")
        token = create_access_token(user.user_id, user.role)
        return user, token

    async def forgot_password(self, email: str, code: str, new_password: str) -> None:
        """通过邮箱验证码重置密码."""
        email = email.strip().lower()
        _validate_password(new_password)
        await self._verify_code(email, "reset_password", code)
        user = await self.user_repo.get_by_email(email)
        if not user:
            raise NotFoundError("用户不存在")
        await self.user_repo.update(user, password_hash=_hash_password(new_password))

    async def change_password(
        self,
        user: User,
        new_password: str,
        current_password: Optional[str] = None,
        email_code: Optional[str] = None,
    ) -> None:
        if not current_password and not email_code:
            raise BadRequestError("需提供当前密码或邮箱验证码")
        _validate_password(new_password)
        if email_code:
            if not user.email:
                raise BadRequestError("账号未绑定邮箱，无法使用邮箱验证")
            await self._verify_code(user.email, "change_password", email_code)
        else:
            if not _verify_password(current_password, user.password_hash):
                raise UnauthorizedError("当前密码不正确")
        await self.user_repo.update(user, password_hash=_hash_password(new_password))

    async def update_profile(
        self,
        user: User,
        display_name: Optional[str] = None,
        bio: Optional[str] = None,
        avatar_url: Optional[str] = None,
        avatar_url_provided: bool = False,
    ) -> User:
        updates: dict = {}
        if display_name is not None:
            updates["display_name"] = display_name.strip()
        if bio is not None:
            updates["bio"] = bio
        if avatar_url_provided:
            updates["avatar_url"] = avatar_url
        if updates:
            target = await self.user_repo.get_by_id(user.user_id) or user
            return await self.user_repo.update(target, **updates)
        return user
