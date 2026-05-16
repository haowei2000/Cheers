"""Membership module."""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Channel, ChannelMembership
from app.features.agent_bridge.registry import bot_session_registry

logger = logging.getLogger("app.features.agent_bridge.membership")


async def load_memberships(session: AsyncSession, bot_id: str) -> list[dict]:
    """Load memberships."""
    rows = (await session.execute(
        select(Channel, ChannelMembership)
        .join(ChannelMembership, ChannelMembership.channel_id == Channel.channel_id)
        .where(
            ChannelMembership.member_id == bot_id,
            ChannelMembership.member_type == "bot",
        )
    )).all()
    out: list[dict] = []
    for ch, m in rows:
        out.append({
            "channel_id": ch.channel_id,
            "channel_name": ch.name,
            "channel_type": ch.type,
            "workspace_id": ch.workspace_id,
            "joined_at": m.joined_at.isoformat() if m.joined_at else None,
        })
    return out


async def emit_channel_joined(
    session: AsyncSession, *, bot_id: str, channel_id: str, invited_by: str | None,
) -> None:
    """Emit channel joined."""
    bot = (await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )).scalar_one_or_none()
    if bot is None or (bot.binding_type or "http") != "agent_bridge":
        return
    ch = (await session.execute(select(Channel).where(Channel.channel_id == channel_id))).scalar_one_or_none()
    if ch is None:
        return
    await bot_session_registry.dispatch_control(bot_id, {
        "type": "channel_joined",
        "channel": {
            "channel_id": ch.channel_id,
            "channel_name": ch.name,
            "channel_type": ch.type,
            "workspace_id": ch.workspace_id,
        },
        "invited_by": invited_by,
    })


async def emit_channel_left(
    session: AsyncSession, *, bot_id: str, channel_id: str, reason: str,
) -> None:
    """Emit channel left."""
    bot = (await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )).scalar_one_or_none()
    if bot is None or (bot.binding_type or "http") != "agent_bridge":
        return
    await bot_session_registry.dispatch_control(bot_id, {
        "type": "channel_left",
        "channel_id": channel_id,
        "reason": reason,
    })
