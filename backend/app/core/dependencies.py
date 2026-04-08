"""集中所有 FastAPI 依赖注入函数."""
from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Optional

import httpx
from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.db.session import async_session_factory
from app.db.models import User
from app.services.auth.jwt_utils import decode_access_token
from sqlalchemy import select


# ---------------------------------------------------------------------------
# 数据库会话
# ---------------------------------------------------------------------------

async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ---------------------------------------------------------------------------
# 用户认证
# ---------------------------------------------------------------------------

async def _resolve_user(token: str, db: AsyncSession) -> User | None:
    user_id: str | None = None
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub") if payload else None
    except Exception:
        pass
    if not user_id:
        # 旧版 UUID 直接作为 token 的兼容逻辑
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
        raise UnauthorizedError("未登录")
    token = authorization.removeprefix("Bearer ").strip()
    user = await _resolve_user(token, db)
    if not user:
        raise UnauthorizedError("无效 Token")
    return user


async def try_get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> Optional[User]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    try:
        return await _resolve_user(token, db)
    except Exception:
        return None


_ROLE_PERMISSIONS: dict[str, dict[str, bool]] = {
    "system_admin": {"user_management": False, "space_management": False, "channel_management": False, "bot_config": False, "system_settings": True},
    "space_admin":  {"user_management": False, "space_management": True,  "channel_management": True,  "bot_config": True,  "system_settings": False},
    "channel_admin":{"user_management": False, "space_management": False, "channel_management": True,  "bot_config": False, "system_settings": False},
    "member":       {"user_management": False, "space_management": False, "channel_management": False, "bot_config": False, "system_settings": False},
    "guest":        {"user_management": False, "space_management": False, "channel_management": False, "bot_config": False, "system_settings": False},
}

_PERMISSIONS: dict[str, list[str]] = {
    perm: [role for role, perms in _ROLE_PERMISSIONS.items() if perms.get(perm)]
    for perm in ["user_management", "space_management", "channel_management", "bot_config", "system_settings"]
}


def require_permission(permission: str):
    """生成一个权限检查依赖."""
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        allowed = _PERMISSIONS.get(permission, [])
        if current_user.role not in allowed:
            raise ForbiddenError("权限不足")
        return current_user

    return _check


# ---------------------------------------------------------------------------
# 基础设施服务（从 app.state 读取）
# ---------------------------------------------------------------------------

def get_http_client(request: Request) -> httpx.AsyncClient:
    """从 app.state 获取共享 HTTP 客户端."""
    client: httpx.AsyncClient | None = getattr(request.app.state, "http_client", None)
    if client is None:
        # 降级：直接从模块全局读取（兼容非 FastAPI 上下文）
        from app.http_client import get_http_client as _get
        return _get()
    return client


def get_storage(request: Request):
    """从 app.state 获取存储服务（可能为 None，如未配置）."""
    return getattr(request.app.state, "storage", None)
