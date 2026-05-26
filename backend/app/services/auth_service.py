"""Auth service module."""
from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.exceptions import BadRequestError, ConflictError, NotFoundError, UnauthorizedError
from app.db.models import EmailCode, Friendship, KeychainItem, User
from app.repositories.user_repo import UserRepository
from app.services.auth.jwt_utils import create_access_token
from app.services.auth.password_utils import hash_password as _hash_password
from app.services.auth.password_utils import verify_password as _verify_password

_OTP_COOLDOWN_SECONDS = 60
_OTP_EXPIRE_MINUTES = 10
_OTP_VALID_PURPOSES = {"register", "reset_password", "change_password"}


def _normalize_email(email: str | None) -> str:
    return (email or "").strip().lower()


def _validate_required_email(email: str | None) -> str:
    normalized = _normalize_email(email)
    if not normalized or "@" not in normalized:
        raise BadRequestError("邮箱格式不正确")
    return normalized


def _registration_email_pattern() -> str:
    return settings.registration_email_pattern.strip()


def _validate_registration_email_pattern(email: str) -> None:
    pattern = _registration_email_pattern()
    if not pattern:
        return
    try:
        matched = re.fullmatch(pattern, email, flags=re.IGNORECASE)
    except re.error as exc:
        raise BadRequestError("注册邮箱规则配置无效，请联系管理员") from exc
    if not matched:
        raise BadRequestError("注册邮箱不符合要求")


def _prepare_registration_email(email: str | None) -> str | None:
    normalized = _normalize_email(email)
    if not normalized:
        if _registration_email_pattern():
            raise BadRequestError("注册邮箱不能为空")
        return None
    normalized = _validate_required_email(normalized)
    _validate_registration_email_pattern(normalized)
    return normalized


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
        """Send verification code."""
        if purpose not in _OTP_VALID_PURPOSES:
            raise BadRequestError("无效的 purpose")
        email = _validate_required_email(email)
        if purpose == "register":
            _validate_registration_email_pattern(email)

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
        """Register."""
        username = username.strip()
        if not username:
            raise BadRequestError("用户名不能为空")
        _validate_password(password)
        email = _prepare_registration_email(email)
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
        """Login."""
        from sqlalchemy import or_
        result = await self.session.execute(
            select(User).where(
                or_(User.username == username, User.email == username.strip().lower())
            )
        )
        user = result.scalar_one_or_none()
        if not user or getattr(user, "is_deleted", False) or not _verify_password(password, user.password_hash):
            raise UnauthorizedError("用户名/邮箱或密码错误")
        token = create_access_token(user.user_id, user.role)
        return user, token

    async def forgot_password(self, email: str, code: str, new_password: str) -> None:
        """Forgot password."""
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
            assert current_password is not None
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

    async def deactivate_account(self, user: User) -> User:
        """Deactivate an account while preserving message ownership references."""
        target = await self.user_repo.get_by_id(user.user_id) or user
        if getattr(target, "is_deleted", False):
            return target

        now = datetime.now(timezone.utc)
        if target.email:
            await self.session.execute(delete(EmailCode).where(EmailCode.email == target.email))
        await self.session.execute(delete(KeychainItem).where(KeychainItem.owner_id == target.user_id))
        await self.session.execute(
            delete(Friendship).where(
                or_(
                    Friendship.user_id == target.user_id,
                    Friendship.friend_id == target.user_id,
                )
            )
        )

        target.username = f"deleted-{target.user_id[:8]}-{int(now.timestamp())}"
        target.email = None
        target.password_hash = _hash_password(secrets.token_urlsafe(32))
        target.display_name = "Deleted user"
        target.bio = None
        target.avatar_url = None
        target.is_deleted = True
        target.deleted_at = now
        self.session.add(target)
        await self.session.flush()
        return target
