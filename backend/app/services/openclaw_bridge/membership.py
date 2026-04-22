"""WebSocket Bot 的 membership 快照和成员事件派发工具。

成员事件来源于 channel_service.add_member/remove_member 的 hook（只在 binding_type='websocket'
的 bot 被加入/移除频道时派发）。快照用于 control WS 的 hello 首帧。
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Channel, ChannelMembership
from app.services.openclaw_bridge.registry import bot_session_registry

logger = logging.getLogger("app.services.openclaw_bridge.membership")


async def load_memberships(session: AsyncSession, bot_id: str) -> list[dict]:
    """查询 bot 当前所在的所有频道，返回 hello 帧里用的 memberships 列表。"""
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
    """成员加入：若该 bot 是 websocket 类型、且有活跃 control WS，则推送 channel_joined 事件。"""
    bot = (await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )).scalar_one_or_none()
    if bot is None or (bot.binding_type or "http") != "websocket":
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
    """成员移除：推送 channel_left 事件（WebSocket Bot only）。"""
    bot = (await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )).scalar_one_or_none()
    if bot is None or (bot.binding_type or "http") != "websocket":
        return
    await bot_session_registry.dispatch_control(bot_id, {
        "type": "channel_left",
        "channel_id": channel_id,
        "reason": reason,
    })
