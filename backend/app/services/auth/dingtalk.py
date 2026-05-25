"""DingTalk delegated login service."""
from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError
from app.db.models import AuthExternalIdentity, User
from app.services.auth.jwt_utils import create_access_token, create_service_token, decode_service_token
from app.services.auth.password_utils import hash_password

PROVIDER = "dingtalk"
STATE_TOKEN_TYPE = "dingtalk_oauth_state"
LOGIN_TICKET_TYPE = "dingtalk_login_ticket"
WEB_SCOPE = "openid corpid Contact.User.Read"
IN_APP_RPC_SCOPE = "Contact.User.Read"
SPA_CALLBACK_PATH = "/auth/dingtalk/callback"


def parse_allowed_corp_ids(value: str | None = None) -> list[str]:
    raw = settings.dingtalk_allowed_corp_ids if value is None else value
    return [item.strip() for item in (raw or "").replace("\n", ",").split(",") if item.strip()]


def _relative_path(value: str | None) -> str:
    candidate = (value or "/").strip() or "/"
    if not candidate.startswith("/") or candidate.startswith("//") or "\\" in candidate:
        raise BadRequestError("redirect_path must be a relative path")
    return candidate


def _service_enabled() -> bool:
    return bool(
        settings.dingtalk_login_enabled
        and settings.dingtalk_client_id.strip()
        and settings.dingtalk_client_secret.strip()
        and parse_allowed_corp_ids()
    )


def provider_metadata() -> dict[str, Any]:
    allowed = parse_allowed_corp_ids()
    default_corp_id = settings.dingtalk_default_corp_id.strip()
    if default_corp_id and default_corp_id not in allowed:
        default_corp_id = ""
    return {
        "provider": PROVIDER,
        "display_name": "DingTalk",
        "enabled": _service_enabled(),
        "web_authorize_url": "/api/v1/auth/dingtalk/authorize",
        "client_id": settings.dingtalk_client_id.strip() if settings.dingtalk_login_enabled else "",
        "allowed_corp_ids": allowed if settings.dingtalk_login_enabled else [],
        "default_corp_id": default_corp_id,
        "in_app_enabled": _service_enabled() and bool(default_corp_id or len(allowed) == 1),
        "rpc_scope": IN_APP_RPC_SCOPE,
        "field_scope": "",
    }


class DingTalkAuthService:
    def __init__(self, session: AsyncSession, http_client: httpx.AsyncClient | None = None) -> None:
        self.session = session
        self.http_client = http_client

    def _ensure_enabled(self) -> None:
        if not settings.dingtalk_login_enabled:
            raise ForbiddenError("DingTalk login is disabled")
        if not settings.dingtalk_client_id.strip() or not settings.dingtalk_client_secret.strip():
            raise ForbiddenError("DingTalk login is not configured")
        if not parse_allowed_corp_ids():
            raise ForbiddenError("DingTalk corp allowlist is not configured")

    def create_state(self, redirect_path: str | None) -> str:
        self._ensure_enabled()
        return create_service_token(
            {
                "typ": STATE_TOKEN_TYPE,
                "redirect_path": _relative_path(redirect_path),
            },
            expires_seconds=max(int(settings.dingtalk_state_ttl_seconds or 300), 1),
        )

    def validate_state(self, state: str | None) -> str:
        if not state:
            raise UnauthorizedError("Missing DingTalk OAuth state")
        try:
            payload = decode_service_token(state)
        except Exception as exc:
            raise UnauthorizedError("Invalid or expired DingTalk OAuth state") from exc
        if payload.get("typ") != STATE_TOKEN_TYPE:
            raise UnauthorizedError("Invalid DingTalk OAuth state")
        return _relative_path(payload.get("redirect_path"))

    def build_authorize_url(self, callback_url: str, redirect_path: str | None) -> str:
        state = self.create_state(redirect_path)
        params = {
            "client_id": settings.dingtalk_client_id.strip(),
            "redirect_uri": callback_url,
            "state": state,
            "response_type": "code",
            "prompt": "consent",
            "scope": WEB_SCOPE,
        }
        return f"{settings.dingtalk_oauth_authorize_url}?{urlencode(params, quote_via=quote)}"

    def create_login_ticket(self, user: User) -> str:
        return create_service_token(
            {
                "typ": LOGIN_TICKET_TYPE,
                "sub": user.user_id,
            },
            expires_seconds=max(int(settings.dingtalk_login_ticket_ttl_seconds or 120), 1),
        )

    async def exchange_login_ticket(self, ticket: str) -> tuple[User, str]:
        try:
            payload = decode_service_token(ticket)
        except Exception as exc:
            raise UnauthorizedError("Invalid or expired DingTalk login ticket") from exc
        if payload.get("typ") != LOGIN_TICKET_TYPE or not payload.get("sub"):
            raise UnauthorizedError("Invalid DingTalk login ticket")
        user = await self.session.get(User, payload["sub"])
        if not user:
            raise NotFoundError("User not found")
        if getattr(user, "is_deleted", False):
            raise UnauthorizedError("账号已停用")
        return user, create_access_token(user.user_id, user.role)

    async def login_with_auth_code(self, auth_code: str) -> tuple[User, str]:
        self._ensure_enabled()
        code = (auth_code or "").strip()
        if not code:
            raise BadRequestError("auth_code is required")
        token_payload = await self._exchange_auth_code(code)
        access_token = str(token_payload.get("accessToken") or "").strip()
        corp_id = str(token_payload.get("corpId") or "").strip()
        if not access_token:
            raise UnauthorizedError("DingTalk did not return an access token")
        self._validate_corp_id(corp_id)
        profile = await self._fetch_user_profile(access_token)
        user = await self._upsert_user(corp_id, profile)
        return user, create_access_token(user.user_id, user.role)

    async def _exchange_auth_code(self, auth_code: str) -> dict[str, Any]:
        if self.http_client is None:
            raise UnauthorizedError("DingTalk authorization service unavailable")
        try:
            response = await self.http_client.post(
                settings.dingtalk_oauth_token_url,
                json={
                    "clientId": settings.dingtalk_client_id.strip(),
                    "clientSecret": settings.dingtalk_client_secret.strip(),
                    "code": auth_code,
                    "refreshToken": "",
                    "grantType": "authorization_code",
                },
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise UnauthorizedError("DingTalk authorization failed") from exc
        except httpx.HTTPError as exc:
            raise UnauthorizedError("DingTalk authorization service unavailable") from exc
        data = response.json()
        if not isinstance(data, dict):
            raise UnauthorizedError("DingTalk returned an invalid token response")
        return data

    async def _fetch_user_profile(self, access_token: str) -> dict[str, Any]:
        if self.http_client is None:
            raise UnauthorizedError("DingTalk user lookup service unavailable")
        try:
            response = await self.http_client.get(
                settings.dingtalk_user_info_url,
                headers={
                    "Content-Type": "application/json",
                    "x-acs-dingtalk-access-token": access_token,
                },
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise UnauthorizedError("DingTalk user lookup failed") from exc
        except httpx.HTTPError as exc:
            raise UnauthorizedError("DingTalk user lookup service unavailable") from exc
        data = response.json()
        if not isinstance(data, dict):
            raise UnauthorizedError("DingTalk returned an invalid user response")
        return data

    def _validate_corp_id(self, corp_id: str) -> None:
        if not corp_id:
            raise BadRequestError("DingTalk corpId is required")
        if corp_id not in parse_allowed_corp_ids():
            raise ForbiddenError("DingTalk organization is not allowed")

    async def _upsert_user(self, corp_id: str, profile: dict[str, Any]) -> User:
        union_id = _profile_text_any(profile, "unionId", "unionid")
        open_id = _profile_text_any(profile, "openId", "openid")
        subject = _identity_subject(corp_id, union_id, open_id)
        existing = (
            await self.session.execute(
                select(AuthExternalIdentity).where(
                    AuthExternalIdentity.provider == PROVIDER,
                    AuthExternalIdentity.subject == subject,
                )
            )
        ).scalar_one_or_none()
        now = datetime.now(UTC)
        if existing:
            user = await self.session.get(User, existing.user_id)
            if not user:
                raise NotFoundError("Linked AgentNexus user not found")
            if getattr(user, "is_deleted", False):
                raise UnauthorizedError("账号已停用")
            self._apply_identity_snapshot(existing, corp_id, union_id, open_id, profile, now)
            if not user.avatar_url and _profile_avatar_url(profile):
                user.avatar_url = _profile_avatar_url(profile)
            self.session.add(user)
            await self.session.flush()
            return user

        display_name = _profile_display_name(profile) or "DingTalk User"
        user = User(
            username=await self._next_username(_username_base(display_name, union_id or open_id or subject)),
            password_hash=hash_password(secrets.token_urlsafe(32)),
            display_name=display_name,
            role="member",
            avatar_url=_profile_avatar_url(profile),
        )
        self.session.add(user)
        await self.session.flush()

        identity = AuthExternalIdentity(
            provider=PROVIDER,
            subject=subject,
            user_id=user.user_id,
            corp_id=corp_id,
            union_id=union_id,
            open_id=open_id,
        )
        self._apply_identity_snapshot(identity, corp_id, union_id, open_id, profile, now)
        self.session.add(identity)
        await self.session.flush()
        return user

    def _apply_identity_snapshot(
        self,
        identity: AuthExternalIdentity,
        corp_id: str,
        union_id: str | None,
        open_id: str | None,
        profile: dict[str, Any],
        now: datetime,
    ) -> None:
        identity.corp_id = corp_id
        identity.union_id = union_id
        identity.open_id = open_id
        identity.display_name = _profile_display_name(profile)
        identity.avatar_url = _profile_avatar_url(profile)
        identity.mobile = _profile_mobile(profile)
        identity.email = _profile_email(profile)
        identity.profile = profile
        identity.updated_at = now

    async def _next_username(self, base: str) -> str:
        base = base[:64].strip("_") or "dt_user"
        for index in range(100):
            suffix = "" if index == 0 else f"_{index}"
            candidate = f"{base[:64 - len(suffix)]}{suffix}"
            exists = (
                await self.session.execute(select(User.user_id).where(User.username == candidate))
            ).scalar_one_or_none()
            if not exists:
                return candidate
        raise BadRequestError("Unable to allocate DingTalk username")


def callback_url() -> str:
    return f"{settings.public_base_url.rstrip('/')}/api/v1/auth/dingtalk/callback"


def spa_callback_url(ticket: str | None = None, redirect_path: str | None = None, error: str | None = None) -> str:
    params: dict[str, str] = {}
    if ticket:
        params["ticket"] = ticket
    if redirect_path:
        params["redirect_path"] = _relative_path(redirect_path)
    if error:
        params["error"] = error
    query = f"?{urlencode(params, quote_via=quote)}" if params else ""
    return f"{SPA_CALLBACK_PATH}{query}"


def _profile_text(profile: dict[str, Any], key: str) -> str | None:
    value = profile.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _profile_text_any(profile: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = _profile_text(profile, key)
        if value:
            return value
    return None


def _profile_display_name(profile: dict[str, Any]) -> str | None:
    return _profile_text_any(profile, "nick", "name", "displayName", "display_name")


def _profile_avatar_url(profile: dict[str, Any]) -> str | None:
    return _profile_text_any(profile, "avatarUrl", "avatar", "avatar_url")


def _profile_email(profile: dict[str, Any]) -> str | None:
    email = _profile_text_any(profile, "email", "orgEmail", "org_email", "workEmail", "work_email")
    if not email or "@" not in email:
        return None
    return email.lower()


def _profile_mobile(profile: dict[str, Any]) -> str | None:
    mobile = _profile_text_any(profile, "mobile", "mobilePhone", "mobile_phone")
    if not mobile:
        return None
    return re.sub(r"[\s-]+", "", mobile) or None


def _identity_subject(corp_id: str, union_id: str | None, open_id: str | None) -> str:
    if union_id:
        return union_id
    if open_id:
        return f"{corp_id}:{open_id}"
    raise BadRequestError("DingTalk identity is missing unionId/openId")


def _username_base(display_name: str, identity_value: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_]+", "_", display_name.lower()).strip("_")
    if not name:
        name = "user"
    suffix = re.sub(r"[^A-Za-z0-9]+", "", identity_value.lower())[-8:] or "identity"
    return f"dt_{name[:32]}_{suffix}"
