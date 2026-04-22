"""WebSocket Bot 凭证工具：生成 / 验证 / 按前缀检索。

Token 格式： "ocw_" + 32 字节 base64url（去 padding）≈ 43 字符。
  - 前 8 字符（"ocw_xxxx"）存为 bot_token_prefix，用于查表
  - 全 token 的 pbkdf2_sha256 哈希存为 bot_token_hash
  - 明文仅在生成/轮换时一次性返回给用户；之后 UI 只能看到前缀
"""
from __future__ import annotations

import secrets
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount
from app.services.auth.password_utils import hash_password, verify_password

_TOKEN_PREFIX = "ocw_"
_PREFIX_LEN = 8            # 索引前缀长度（含 "ocw_"）
_TOKEN_BYTES = 32          # 不含前缀的熵（≈43 chars base64url）


def generate_bot_token() -> str:
    """生成一个新明文 token。调用方负责把哈希 + 前缀写入 BotAccount。"""
    return _TOKEN_PREFIX + secrets.token_urlsafe(_TOKEN_BYTES)


def token_prefix_of(token: str) -> str:
    return token[:_PREFIX_LEN]


def apply_token_to_bot(bot: BotAccount, *, now: datetime | None = None) -> str:
    """生成新 token，写入 bot.bot_token_hash / prefix / rotated_at；返回明文。

    调用方负责 session.flush() / commit()。
    """
    token = generate_bot_token()
    bot.bot_token_hash = hash_password(token)
    bot.bot_token_prefix = token_prefix_of(token)
    bot.bot_token_rotated_at = now or datetime.utcnow()
    return token


async def resolve_bot_by_token(session: AsyncSession, token: str) -> BotAccount | None:
    """根据明文 token 找到对应的 WebSocket Bot；未匹配或非 websocket 返回 None。"""
    if not token or not token.startswith(_TOKEN_PREFIX):
        return None
    prefix = token_prefix_of(token)
    if len(prefix) != _PREFIX_LEN:
        return None
    rows = (await session.execute(
        select(BotAccount).where(
            BotAccount.bot_token_prefix == prefix,
            BotAccount.binding_type == "websocket",
        )
    )).scalars().all()
    for bot in rows:
        if bot.bot_token_hash and verify_password(token, bot.bot_token_hash):
            return bot
    return None
