"""Stable AgentNexus session mapping for OpenClaw WebSocket bots.

OpenClaw's ``sessionId`` is the current transcript id and may change after a
reset or idle rollover. AgentNexus therefore owns a durable session UUID and
maps channel / DM / topic / task scopes to one OpenClaw ``sessionKey``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AgentNexusSession,
    AgentNexusSessionBinding,
    BotAccount,
    Channel,
    gen_uuid,
)

SCOPE_CHANNEL = "channel"
SCOPE_DM = "dm"
SCOPE_TOPIC = "topic"
SCOPE_TASK = "task"

_SAFE_SEGMENT_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


@dataclass(frozen=True)
class SessionResolution:
    """Result sent to the plugin so it can run OpenClaw with a stable key."""

    session_id: str
    openclaw_session_key: str
    openclaw_account_id: str
    openclaw_agent_id: str
    primary_scope_type: str
    primary_scope_id: str
    task_scope_id: str | None = None

    def to_event_payload(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.session_id,
            "openclaw_session_key": self.openclaw_session_key,
            "openclaw_account_id": self.openclaw_account_id,
            "openclaw_agent_id": self.openclaw_agent_id,
            "primary_scope_type": self.primary_scope_type,
            "primary_scope_id": self.primary_scope_id,
        }
        if self.task_scope_id:
            data["task_scope_id"] = self.task_scope_id
        return data


def _safe_segment(value: str | None, fallback: str) -> str:
    raw = (value or "").strip() or fallback
    cleaned = _SAFE_SEGMENT_RE.sub("-", raw).strip("-")
    return cleaned or fallback


def _binding_value(config: dict[str, Any], *keys: str, default: str) -> str:
    for key in keys:
        value = config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def openclaw_agent_id_for(bot: BotAccount) -> str:
    config = dict(getattr(bot, "binding_config", None) or {})
    return _safe_segment(
        _binding_value(config, "agent_id", "openclaw_agent_id", default="main"),
        "main",
    )


def openclaw_account_id_for(bot: BotAccount) -> str:
    config = dict(getattr(bot, "binding_config", None) or {})
    return _safe_segment(
        _binding_value(
            config,
            "account_id",
            "openclaw_account_id",
            default=getattr(bot, "bot_id", "") or "bot",
        ),
        getattr(bot, "bot_id", "") or "bot",
    )


def build_openclaw_session_key(
    *,
    openclaw_agent_id: str,
    openclaw_account_id: str,
    session_id: str,
) -> str:
    return (
        f"agent:{_safe_segment(openclaw_agent_id, 'main')}"
        f":agentnexus:account:{_safe_segment(openclaw_account_id, 'account')}"
        f":session:{_safe_segment(session_id, 'session')}"
    )


def _topic_id_from_trigger(trigger_message: dict[str, Any]) -> str | None:
    topic_chain = trigger_message.get("topic_chain")
    if isinstance(topic_chain, list) and topic_chain:
        first = topic_chain[0]
        if isinstance(first, dict):
            msg_id = first.get("msg_id")
            if isinstance(msg_id, str) and msg_id:
                return msg_id
    if trigger_message.get("msg_type") == SCOPE_TOPIC:
        msg_id = trigger_message.get("msg_id")
        if isinstance(msg_id, str) and msg_id:
            return msg_id
    return None


def _dm_scope_id(
    *,
    bot_id: str,
    channel_id: str,
    trigger_message: dict[str, Any],
) -> str:
    """Stable product-level scope for a 1:1 user-bot DM.

    DMs are modeled in storage as ``Channel(type="dm")`` for message reuse, but
    OpenClaw session identity should not depend on that backing channel row.
    A duplicate/recreated DM channel for the same user and bot must still land
    in the same OpenClaw conversation.
    """
    user_id = trigger_message.get("user")
    if isinstance(user_id, str) and user_id.strip():
        return f"user:{user_id.strip()}:bot:{bot_id}"
    # Defensive fallback for malformed legacy dispatch frames. Normal Bot DM
    # dispatches always carry trigger_message["user"].
    return f"channel:{channel_id}:bot:{bot_id}"


def _primary_scope(
    *,
    bot_id: str,
    channel: Channel | None,
    channel_id: str,
    trigger_message: dict[str, Any],
) -> tuple[str, str]:
    if channel is not None and channel.type == "dm":
        return SCOPE_DM, _dm_scope_id(
            bot_id=bot_id,
            channel_id=channel_id,
            trigger_message=trigger_message,
        )
    topic_id = _topic_id_from_trigger(trigger_message)
    if topic_id:
        return SCOPE_TOPIC, topic_id
    return SCOPE_CHANNEL, channel_id


async def _load_channel(
    db: AsyncSession,
    channel_id: str,
    channel: Channel | None,
) -> Channel | None:
    if channel is not None:
        return channel
    return await db.get(Channel, channel_id)


async def _find_binding_by_scope(
    db: AsyncSession,
    *,
    bot_id: str,
    openclaw_agent_id: str,
    openclaw_account_id: str,
    scope_type: str,
    scope_id: str,
) -> AgentNexusSessionBinding | None:
    result = await db.execute(
        select(AgentNexusSessionBinding).where(
            AgentNexusSessionBinding.bot_id == bot_id,
            AgentNexusSessionBinding.openclaw_agent_id == openclaw_agent_id,
            AgentNexusSessionBinding.openclaw_account_id == openclaw_account_id,
            AgentNexusSessionBinding.scope_type == scope_type,
            AgentNexusSessionBinding.scope_id == scope_id,
            AgentNexusSessionBinding.detached_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def _load_session_for_binding(
    db: AsyncSession,
    binding: AgentNexusSessionBinding,
) -> AgentNexusSession:
    session_row = await db.get(AgentNexusSession, binding.session_id)
    if session_row is None:
        raise RuntimeError(f"session binding points to missing session_id={binding.session_id}")
    return session_row


async def _find_primary_binding_for_session(
    db: AsyncSession,
    *,
    session_id: str,
) -> AgentNexusSessionBinding | None:
    result = await db.execute(
        select(AgentNexusSessionBinding).where(
            AgentNexusSessionBinding.session_id == session_id,
            AgentNexusSessionBinding.scope_type != SCOPE_TASK,
            AgentNexusSessionBinding.detached_at.is_(None),
        )
    )
    bindings = list(result.scalars().all())
    priority = {SCOPE_TOPIC: 0, SCOPE_DM: 1, SCOPE_CHANNEL: 2}
    bindings.sort(key=lambda b: priority.get(b.scope_type, 99))
    return bindings[0] if bindings else None


async def _ensure_binding(
    db: AsyncSession,
    *,
    session_row: AgentNexusSession,
    bot_id: str,
    openclaw_agent_id: str,
    openclaw_account_id: str,
    scope_type: str,
    scope_id: str,
    channel_id: str | None,
    role: str,
) -> AgentNexusSessionBinding:
    binding_channel_id = None if scope_type == SCOPE_DM else channel_id
    existing = await _find_binding_by_scope(
        db,
        bot_id=bot_id,
        openclaw_agent_id=openclaw_agent_id,
        openclaw_account_id=openclaw_account_id,
        scope_type=scope_type,
        scope_id=scope_id,
    )
    if existing is not None:
        return existing

    try:
        async with db.begin_nested():
            binding = AgentNexusSessionBinding(
                session_id=session_row.session_id,
                bot_id=bot_id,
                openclaw_agent_id=openclaw_agent_id,
                openclaw_account_id=openclaw_account_id,
                scope_type=scope_type,
                scope_id=scope_id,
                channel_id=binding_channel_id,
                topic_id=scope_id if scope_type == SCOPE_TOPIC else None,
                dm_id=None,
                task_id=scope_id if scope_type == SCOPE_TASK else None,
                role=role,
            )
            db.add(binding)
            await db.flush()
            return binding
    except IntegrityError:
        existing = await _find_binding_by_scope(
            db,
            bot_id=bot_id,
            openclaw_agent_id=openclaw_agent_id,
            openclaw_account_id=openclaw_account_id,
            scope_type=scope_type,
            scope_id=scope_id,
        )
        if existing is not None:
            return existing
        raise


async def resolve_dispatch_session(
    db: AsyncSession,
    *,
    bot: BotAccount,
    channel_id: str,
    trigger_message: dict[str, Any],
    task_id: str | None,
    channel: Channel | None = None,
) -> SessionResolution:
    """Return the durable session mapping for one Bot dispatch.

    The primary binding is topic > DM > channel. The current task_id is also
    bound as an alias to the same session so task views can switch back to the
    channel/topic context without creating a fresh OpenClaw conversation.
    """
    channel = await _load_channel(db, channel_id, channel)
    openclaw_agent_id = openclaw_agent_id_for(bot)
    openclaw_account_id = openclaw_account_id_for(bot)
    scope_type, scope_id = _primary_scope(
        bot_id=bot.bot_id,
        channel=channel,
        channel_id=channel_id,
        trigger_message=trigger_message,
    )

    session_row = None
    found_via_task = False
    created_session = False
    if task_id:
        task_binding = await _find_binding_by_scope(
            db,
            bot_id=bot.bot_id,
            openclaw_agent_id=openclaw_agent_id,
            openclaw_account_id=openclaw_account_id,
            scope_type=SCOPE_TASK,
            scope_id=task_id,
        )
        if task_binding is not None:
            session_row = await _load_session_for_binding(db, task_binding)
            found_via_task = True
    if session_row is None:
        primary_binding = await _find_binding_by_scope(
            db,
            bot_id=bot.bot_id,
            openclaw_agent_id=openclaw_agent_id,
            openclaw_account_id=openclaw_account_id,
            scope_type=scope_type,
            scope_id=scope_id,
        )
        if primary_binding is None and scope_type == SCOPE_DM and scope_id != channel_id:
            # Before DM sessions were promoted to first-class user-bot scopes,
            # they were keyed by the backing Channel row id. Reuse that session
            # once and bind the new identity scope to it, so existing Bot DMs do
            # not lose OpenClaw context after deploy.
            primary_binding = await _find_binding_by_scope(
                db,
                bot_id=bot.bot_id,
                openclaw_agent_id=openclaw_agent_id,
                openclaw_account_id=openclaw_account_id,
                scope_type=scope_type,
                scope_id=channel_id,
            )
        if primary_binding is not None:
            session_row = await _load_session_for_binding(db, primary_binding)
    now = datetime.utcnow()
    if session_row is None:
        session_id = gen_uuid()
        session_row = AgentNexusSession(
            session_id=session_id,
            bot_id=bot.bot_id,
            openclaw_agent_id=openclaw_agent_id,
            openclaw_account_id=openclaw_account_id,
            openclaw_session_key=build_openclaw_session_key(
                openclaw_agent_id=openclaw_agent_id,
                openclaw_account_id=openclaw_account_id,
                session_id=session_id,
            ),
            current_scope_type=scope_type,
            current_scope_id=scope_id,
            last_used_at=now,
        )
        db.add(session_row)
        await db.flush()
        created_session = True

    # A task alias is a more specific route than its parent channel. When a
    # task-originated turn no longer carries topic context, keep the task's
    # existing session instead of trying to bind the whole channel to it.
    skip_primary_binding = found_via_task and scope_type == SCOPE_CHANNEL
    reported_scope_type = scope_type
    reported_scope_id = scope_id
    if skip_primary_binding:
        existing_primary = await _find_primary_binding_for_session(
            db,
            session_id=session_row.session_id,
        )
        if existing_primary is not None:
            reported_scope_type = existing_primary.scope_type
            reported_scope_id = existing_primary.scope_id
        else:
            reported_scope_type = SCOPE_TASK
            reported_scope_id = task_id or scope_id
    else:
        primary_binding = await _ensure_binding(
            db,
            session_row=session_row,
            bot_id=bot.bot_id,
            openclaw_agent_id=openclaw_agent_id,
            openclaw_account_id=openclaw_account_id,
            scope_type=scope_type,
            scope_id=scope_id,
            channel_id=channel_id,
            role="primary",
        )
        if primary_binding.session_id != session_row.session_id:
            if created_session:
                await db.delete(session_row)
                await db.flush()
            session_row = await _load_session_for_binding(db, primary_binding)
    if task_id:
        task_binding = await _ensure_binding(
            db,
            session_row=session_row,
            bot_id=bot.bot_id,
            openclaw_agent_id=openclaw_agent_id,
            openclaw_account_id=openclaw_account_id,
            scope_type=SCOPE_TASK,
            scope_id=task_id,
            channel_id=channel_id,
            role="alias",
        )
        if task_binding.session_id != session_row.session_id:
            session_row = await _load_session_for_binding(db, task_binding)
            found_via_task = True
            existing_primary = await _find_primary_binding_for_session(
                db,
                session_id=session_row.session_id,
            )
            if existing_primary is not None:
                reported_scope_type = existing_primary.scope_type
                reported_scope_id = existing_primary.scope_id
            else:
                reported_scope_type = SCOPE_TASK
                reported_scope_id = task_id

    if found_via_task and skip_primary_binding and task_id:
        session_row.current_scope_type = SCOPE_TASK
        session_row.current_scope_id = task_id
    else:
        session_row.current_scope_type = reported_scope_type
        session_row.current_scope_id = reported_scope_id
    session_row.last_used_at = now
    await db.flush()

    return SessionResolution(
        session_id=session_row.session_id,
        openclaw_session_key=session_row.openclaw_session_key,
        openclaw_account_id=openclaw_account_id,
        openclaw_agent_id=openclaw_agent_id,
        primary_scope_type=reported_scope_type,
        primary_scope_id=reported_scope_id,
        task_scope_id=task_id,
    )
