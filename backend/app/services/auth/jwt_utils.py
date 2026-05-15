"""JWT 工具函数：创建和验证 access token。"""
import logging
import secrets
from datetime import UTC, datetime, timedelta

import jwt

logger = logging.getLogger("app.services.auth.jwt_utils")

# Import settings lazily to avoid cycles and allow runtime overrides in tests.
_runtime_secret: str | None = None


def _get_secret() -> str:
    """返回 JWT 签名密钥；若未配置则自动生成随机密钥（进程内有效）。"""
    global _runtime_secret
    from app.config import settings  # Lazy import.
    key = (settings.jwt_secret_key or "").strip()
    if key:
        return key
    if _runtime_secret is None:
        _runtime_secret = secrets.token_urlsafe(64)
        logger.warning(
            "JWT_SECRET_KEY 未配置，已自动生成临时密钥（重启后失效，所有旧 token 将作废）。"
            "请在 .env 中设置 JWT_SECRET_KEY。"
        )
    return _runtime_secret


def create_access_token(user_id: str, role: str) -> str:
    """创建 JWT access token."""
    from app.config import settings
    expire = datetime.now(UTC) + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    payload = {
        "sub": user_id,
        "role": role,
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, _get_secret(), algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """解码并验证 JWT token，返回 payload dict。

    Raises:
        jwt.ExpiredSignatureError: token 已过期
        jwt.InvalidTokenError: token 无效
    """
    from app.config import settings
    return jwt.decode(token, _get_secret(), algorithms=[settings.jwt_algorithm])
