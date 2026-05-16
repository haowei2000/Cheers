"""Tokens module."""
from __future__ import annotations

import secrets
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount
from app.services.auth.password_utils import hash_password, verify_password

_TOKEN_PREFIX = "agb_"
_PREFIX_LEN = 8            # Indexed prefix length, including "agb_".
_TOKEN_BYTES = 32          # Entropy excluding the prefix, roughly 43 base64url chars.


def generate_bot_token() -> str:
    """Generate bot token."""
    return _TOKEN_PREFIX + secrets.token_urlsafe(_TOKEN_BYTES)


def token_prefix_of(token: str) -> str:
    return token[:_PREFIX_LEN]


def apply_token_to_bot(bot: BotAccount, *, now: datetime | None = None) -> str:
    """Apply token to bot."""
    token = generate_bot_token()
    bot.bot_token_hash = hash_password(token)
    bot.bot_token_prefix = token_prefix_of(token)
    bot.bot_token_rotated_at = now or datetime.now(timezone.utc)
    return token


async def resolve_bot_by_token(session: AsyncSession, token: str) -> BotAccount | None:
    """Resolve bot by token."""
    if not token or not token.startswith(_TOKEN_PREFIX):
        return None
    prefix = token_prefix_of(token)
    if len(prefix) != _PREFIX_LEN:
        return None
    rows = (await session.execute(
        select(BotAccount).where(
            BotAccount.bot_token_prefix == prefix,
            BotAccount.binding_type == "agent_bridge",
        )
    )).scalars().all()
    for bot in rows:
        if bot.bot_token_hash and verify_password(token, bot.bot_token_hash):
            return bot
    return None
