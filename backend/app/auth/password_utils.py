"""密码哈希工具（模块级单例，避免重复初始化 CryptContext）."""
from passlib.context import CryptContext

_ctx = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def hash_password(password: str) -> str:
    return _ctx.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return _ctx.verify(plain, hashed)
