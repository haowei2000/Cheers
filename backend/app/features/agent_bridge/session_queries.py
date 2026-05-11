"""Read helpers for Agent Bridge session visibility APIs."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import AgentNexusSession, AgentNexusSessionBinding
from app.features.agent_bridge.session_map import SESSION_STATUS_CLOSED


def _dt(value) -> str | None:
    return value.isoformat() if value else None


def serialize_session(session_row: AgentNexusSession) -> dict[str, Any]:
    bot = session_row.bot
    bindings = sorted(
        list(session_row.bindings or []),
        key=lambda b: (b.detached_at is not None, b.scope_type, b.role, b.scope_id),
    )
    return {
        "session_id": session_row.session_id,
        "bot_id": session_row.bot_id,
        "bot_username": bot.username if bot else None,
        "bot_display_name": bot.display_name if bot else None,
        "provider": session_row.provider,
        "provider_account_id": session_row.provider_account_id,
        "provider_agent_id": session_row.provider_agent_id,
        "provider_session_key": session_row.provider_session_key,
        "provider_session_id": session_row.provider_session_id,
        "current_scope_type": session_row.current_scope_type,
        "current_scope_id": session_row.current_scope_id,
        "status": session_row.status,
        "metadata": session_row.session_metadata or {},
        "last_used_at": _dt(session_row.last_used_at),
        "created_at": _dt(session_row.created_at),
        "updated_at": _dt(session_row.updated_at),
        "bindings": [
            {
                "binding_id": b.binding_id,
                "scope_type": b.scope_type,
                "scope_id": b.scope_id,
                "role": b.role,
                "channel_id": b.channel_id,
                "topic_id": b.topic_id,
                "dm_id": b.dm_id,
                "task_id": b.task_id,
                "created_at": _dt(b.created_at),
                "detached_at": _dt(b.detached_at),
            }
            for b in bindings
        ],
    }


async def list_sessions_for_bot(
    db: AsyncSession,
    *,
    bot_id: str,
    include_closed: bool = True,
) -> list[AgentNexusSession]:
    conditions = [AgentNexusSession.bot_id == bot_id]
    if not include_closed:
        conditions.append(AgentNexusSession.status != SESSION_STATUS_CLOSED)
    result = await db.execute(
        select(AgentNexusSession)
        .where(*conditions)
        .options(
            selectinload(AgentNexusSession.bindings),
            selectinload(AgentNexusSession.bot),
        )
        .order_by(AgentNexusSession.last_used_at.desc(), AgentNexusSession.created_at.desc())
    )
    return list(result.scalars().all())


async def list_active_sessions_for_bot(
    db: AsyncSession,
    *,
    bot_id: str,
) -> list[AgentNexusSession]:
    return await list_sessions_for_bot(db, bot_id=bot_id, include_closed=False)


async def list_active_sessions_for_scope(
    db: AsyncSession,
    *,
    scope_type: str,
    scope_id: str,
    channel_id: str | None = None,
    bot_id: str | None = None,
) -> list[AgentNexusSession]:
    conditions = [
        AgentNexusSessionBinding.scope_type == scope_type,
        AgentNexusSessionBinding.scope_id == scope_id,
        AgentNexusSessionBinding.detached_at.is_(None),
        AgentNexusSession.status != SESSION_STATUS_CLOSED,
    ]
    if channel_id:
        conditions.append(AgentNexusSessionBinding.channel_id == channel_id)
    if bot_id:
        conditions.append(AgentNexusSession.bot_id == bot_id)
    result = await db.execute(
        select(AgentNexusSession)
        .join(AgentNexusSessionBinding, AgentNexusSessionBinding.session_id == AgentNexusSession.session_id)
        .where(*conditions)
        .options(
            selectinload(AgentNexusSession.bindings),
            selectinload(AgentNexusSession.bot),
        )
        .order_by(AgentNexusSession.last_used_at.desc(), AgentNexusSession.created_at.desc())
    )
    return list(result.scalars().unique().all())
