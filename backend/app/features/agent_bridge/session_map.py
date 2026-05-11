"""Stable AgentNexus session mapping for provider WebSocket bots.

provider's ``sessionId`` is the current transcript id and may change after a
reset or idle rollover. AgentNexus therefore owns a durable session UUID and
maps channel / DM / topic / task scopes to one provider ``sessionKey``.
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

SESSION_STATUS_ACTIVE = "active"
SESSION_STATUS_TASK_OWNED = "task_owned"
SESSION_STATUS_CLOSED = "closed"

_SAFE_SEGMENT_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


@dataclass(frozen=True)
class SessionResolution:
    """Result sent to the plugin so it can run provider with a stable key."""

    session_id: str
    provider: str
    provider_session_key: str
    provider_account_id: str
    provider_agent_id: str
    primary_scope_type: str
    primary_scope_id: str
    task_scope_id: str | None = None

    def to_event_payload(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.session_id,
            "provider": self.provider,
            "provider_session_key": self.provider_session_key,
            "provider_account_id": self.provider_account_id,
            "provider_agent_id": self.provider_agent_id,
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


def provider_agent_id_for(bot: BotAccount) -> str:
    config = dict(getattr(bot, "binding_config", None) or {})
    return _safe_segment(
        _binding_value(config, "agent_id", "provider_agent_id", default="main"),
        "main",
    )


def provider_for(bot: BotAccount) -> str:
    config = dict(getattr(bot, "binding_config", None) or {})
    configured = _binding_value(
        config,
        "bridge_provider",
        "provider",
        default=getattr(bot, "bridge_provider", None) or "generic",
    )
    return _safe_segment(configured, "generic")


def provider_account_id_for(bot: BotAccount) -> str:
    config = dict(getattr(bot, "binding_config", None) or {})
    return _safe_segment(
        _binding_value(
            config,
            "account_id",
            "provider_account_id",
            default=getattr(bot, "bot_id", "") or "bot",
        ),
        getattr(bot, "bot_id", "") or "bot",
    )


def build_provider_session_key(
    *,
    provider_agent_id: str,
    provider_account_id: str,
    session_id: str,
) -> str:
    return (
        f"agent:{_safe_segment(provider_agent_id, 'main')}"
        f":agentnexus:account:{_safe_segment(provider_account_id, 'account')}"
        f":session:{_safe_segment(session_id, 'session')}"
    )


def _topic_id_from_trigger(trigger_message: dict[str, Any]) -> str | None:
    if trigger_message.get("msg_type") == SCOPE_TOPIC:
        msg_id = trigger_message.get("msg_id")
        if isinstance(msg_id, str) and msg_id:
            return msg_id

    topic_chain = trigger_message.get("topic_chain")
    if isinstance(topic_chain, list) and topic_chain:
        first = topic_chain[0]
        if isinstance(first, dict):
            if first.get("msg_type") != SCOPE_TOPIC:
                return None
            msg_id = first.get("msg_id")
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
    provider session identity should not depend on that backing channel row.
    A duplicate/recreated DM channel for the same user and bot must still land
    in the same provider conversation.
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
    provider: str,
    provider_agent_id: str,
    provider_account_id: str,
    scope_type: str,
    scope_id: str,
) -> AgentNexusSessionBinding | None:
    result = await db.execute(
        select(AgentNexusSessionBinding).where(
            AgentNexusSessionBinding.bot_id == bot_id,
            AgentNexusSessionBinding.provider == provider,
            AgentNexusSessionBinding.provider_agent_id == provider_agent_id,
            AgentNexusSessionBinding.provider_account_id == provider_account_id,
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


async def _find_primary_bindings_for_session(
    db: AsyncSession,
    *,
    session_id: str,
) -> list[AgentNexusSessionBinding]:
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
    return bindings


async def _find_primary_binding_for_session(
    db: AsyncSession,
    *,
    session_id: str,
) -> AgentNexusSessionBinding | None:
    bindings = await _find_primary_bindings_for_session(db, session_id=session_id)
    return bindings[0] if bindings else None


def _session_metadata(session_row: AgentNexusSession) -> dict[str, Any]:
    metadata = getattr(session_row, "session_metadata", None)
    return dict(metadata) if isinstance(metadata, dict) else {}


def _new_session_row(
    *,
    bot_id: str,
    provider: str,
    provider_agent_id: str,
    provider_account_id: str,
    scope_type: str,
    scope_id: str,
    now: datetime,
    metadata: dict[str, Any] | None = None,
) -> AgentNexusSession:
    session_id = gen_uuid()
    return AgentNexusSession(
        session_id=session_id,
        bot_id=bot_id,
        provider=provider,
        provider_agent_id=provider_agent_id,
        provider_account_id=provider_account_id,
        provider_session_key=build_provider_session_key(
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            session_id=session_id,
        ),
        current_scope_type=scope_type,
        current_scope_id=scope_id,
        status=SESSION_STATUS_ACTIVE,
        session_metadata=metadata,
        last_used_at=now,
    )


async def _rotate_primary_binding_to_new_session(
    db: AsyncSession,
    *,
    binding: AgentNexusSessionBinding,
    bot_id: str,
    provider: str,
    provider_agent_id: str,
    provider_account_id: str,
    now: datetime,
    reason: str,
) -> AgentNexusSession:
    """Move an existing parent scope binding onto a fresh clean session.

    We update the binding in place instead of detaching + inserting a new row
    because the current database constraints are not partial on detached_at.
    The task-owned session keeps its task binding and parent information in
    metadata, while the channel/topic/dm scope immediately points at a clean
    provider session for future normal messages.
    """
    metadata = {
        "rotated_from_session_id": binding.session_id,
        "rotation_reason": reason,
        "rotated_at": now.isoformat(),
    }
    new_session = _new_session_row(
        bot_id=bot_id,
        provider=provider,
        provider_agent_id=provider_agent_id,
        provider_account_id=provider_account_id,
        scope_type=binding.scope_type,
        scope_id=binding.scope_id,
        now=now,
        metadata=metadata,
    )
    db.add(new_session)
    await db.flush()
    binding.session_id = new_session.session_id
    binding.role = "primary"
    binding.detached_at = None
    await db.flush()
    return new_session


async def _ensure_binding(
    db: AsyncSession,
    *,
    session_row: AgentNexusSession,
    bot_id: str,
    provider: str,
    provider_agent_id: str,
    provider_account_id: str,
    scope_type: str,
    scope_id: str,
    channel_id: str | None,
    role: str,
) -> AgentNexusSessionBinding:
    binding_channel_id = None if scope_type == SCOPE_DM else channel_id
    existing = await _find_binding_by_scope(
        db,
        bot_id=bot_id,
        provider=provider,
        provider_agent_id=provider_agent_id,
        provider_account_id=provider_account_id,
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
                provider=provider,
                provider_agent_id=provider_agent_id,
                provider_account_id=provider_account_id,
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
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
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

    The primary binding is DM > promoted topic > channel. Ordinary channel
    replies carry topic_chain for prompt context, but stay on the channel
    session until the parent message has actually become a topic. DMs are a
    first-class scope alongside topic/task, so a DM turn never creates a task
    alias. For non-DM scopes, ``task_id`` starts as an alias to the dispatch
    session. If the placeholder later becomes a visible background task,
    ``adopt_session_for_task`` promotes that alias to the task primary session
    and rotates the parent scope onto a new clean session.
    """
    channel = await _load_channel(db, channel_id, channel)
    provider = provider_for(bot)
    provider_agent_id = provider_agent_id_for(bot)
    provider_account_id = provider_account_id_for(bot)
    now = datetime.utcnow()
    scope_type, scope_id = _primary_scope(
        bot_id=bot.bot_id,
        channel=channel,
        channel_id=channel_id,
        trigger_message=trigger_message,
    )
    dm_scope = scope_type == SCOPE_DM

    session_row = None
    found_via_task = False
    created_session = False
    if task_id and not dm_scope:
        task_binding = await _find_binding_by_scope(
            db,
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
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
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            scope_type=scope_type,
            scope_id=scope_id,
        )
        if primary_binding is None and scope_type == SCOPE_DM and scope_id != channel_id:
            # Before DM sessions were promoted to first-class user-bot scopes,
            # they were keyed by the backing Channel row id. Reuse that session
            # once and bind the new identity scope to it, so existing Bot DMs do
            # not lose provider context after deploy.
            primary_binding = await _find_binding_by_scope(
                db,
                bot_id=bot.bot_id,
                provider=provider,
                provider_agent_id=provider_agent_id,
                provider_account_id=provider_account_id,
                scope_type=scope_type,
                scope_id=channel_id,
            )
        if primary_binding is not None:
            session_row = await _load_session_for_binding(db, primary_binding)
            if session_row.status == SESSION_STATUS_TASK_OWNED:
                session_row = await _rotate_primary_binding_to_new_session(
                    db,
                    binding=primary_binding,
                    bot_id=bot.bot_id,
                    provider=provider,
                    provider_agent_id=provider_agent_id,
                    provider_account_id=provider_account_id,
                    now=now,
                    reason="parent_scope_reentered_after_task_adoption",
                )
    if session_row is None:
        session_row = _new_session_row(
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            scope_type=scope_type,
            scope_id=scope_id,
            now=now,
        )
        db.add(session_row)
        await db.flush()
        created_session = True

    # A task alias is a more specific route than its parent channel. When a
    # task-originated turn no longer carries topic context, keep the task's
    # existing session instead of trying to bind the whole channel to it.
    skip_primary_binding = (
        found_via_task
        and scope_type != SCOPE_TASK
        and session_row.status == SESSION_STATUS_TASK_OWNED
    ) or (found_via_task and scope_type == SCOPE_CHANNEL)
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
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
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
    if task_id and not dm_scope:
        task_binding = await _ensure_binding(
            db,
            session_row=session_row,
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
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
        provider=provider,
        provider_session_key=session_row.provider_session_key,
        provider_account_id=provider_account_id,
        provider_agent_id=provider_agent_id,
        primary_scope_type=reported_scope_type,
        primary_scope_id=reported_scope_id,
        task_scope_id=None if dm_scope else task_id,
    )


async def refresh_dm_session_scope(
    db: AsyncSession,
    *,
    bot: BotAccount,
    channel_id: str,
    user_id: str,
    channel: Channel | None = None,
) -> SessionResolution:
    """Rotate one user-bot DM scope onto a fresh provider session.

    This powers the explicit "refresh session" action in the DM header. The DM
    binding stays as the durable AgentNexus scope; only the provider session key
    changes for future turns.
    """
    channel = await _load_channel(db, channel_id, channel)
    if channel is None or channel.type != "dm":
        raise ValueError("refresh_dm_session_scope requires a dm channel")

    provider = provider_for(bot)
    provider_agent_id = provider_agent_id_for(bot)
    provider_account_id = provider_account_id_for(bot)
    now = datetime.utcnow()
    scope_id = _dm_scope_id(
        bot_id=bot.bot_id,
        channel_id=channel_id,
        trigger_message={"user": user_id},
    )

    binding = await _find_binding_by_scope(
        db,
        bot_id=bot.bot_id,
        provider=provider,
        provider_agent_id=provider_agent_id,
        provider_account_id=provider_account_id,
        scope_type=SCOPE_DM,
        scope_id=scope_id,
    )
    if binding is None and scope_id != channel_id:
        binding = await _find_binding_by_scope(
            db,
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            scope_type=SCOPE_DM,
            scope_id=channel_id,
        )

    if binding is not None:
        old_session = await _load_session_for_binding(db, binding)
        session_row = await _rotate_primary_binding_to_new_session(
            db,
            binding=binding,
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            now=now,
            reason="dm_manual_refresh",
        )
        if old_session.session_id != session_row.session_id:
            old_metadata = _session_metadata(old_session)
            old_metadata.update({
                "closed_reason": "dm_manual_refresh",
                "closed_at": now.isoformat(),
                "replaced_by_session_id": session_row.session_id,
            })
            old_session.session_metadata = old_metadata
            old_session.status = SESSION_STATUS_CLOSED
    else:
        session_row = _new_session_row(
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            scope_type=SCOPE_DM,
            scope_id=scope_id,
            now=now,
            metadata={
                "created_reason": "dm_manual_refresh",
                "created_at": now.isoformat(),
            },
        )
        db.add(session_row)
        await db.flush()

    primary_binding = await _ensure_binding(
        db,
        session_row=session_row,
        bot_id=bot.bot_id,
        provider=provider,
        provider_agent_id=provider_agent_id,
        provider_account_id=provider_account_id,
        scope_type=SCOPE_DM,
        scope_id=scope_id,
        channel_id=channel_id,
        role="primary",
    )
    if primary_binding.session_id != session_row.session_id:
        session_row = await _load_session_for_binding(db, primary_binding)

    session_row.status = SESSION_STATUS_ACTIVE
    session_row.current_scope_type = SCOPE_DM
    session_row.current_scope_id = scope_id
    session_row.last_used_at = now
    await db.flush()

    return SessionResolution(
        session_id=session_row.session_id,
        provider=provider,
        provider_session_key=session_row.provider_session_key,
        provider_account_id=provider_account_id,
        provider_agent_id=provider_agent_id,
        primary_scope_type=SCOPE_DM,
        primary_scope_id=scope_id,
        task_scope_id=None,
    )


async def adopt_session_for_task(
    db: AsyncSession,
    *,
    bot_id: str,
    task_id: str,
    channel_id: str | None = None,
    source_msg_id: str | None = None,
    reason: str = "background_task",
) -> SessionResolution | None:
    """Promote a dispatch task alias into the owner of its provider session.

    This is called only once the Agent Bridge placeholder becomes a visible
    background task. The provider session that was already running is kept for
    the task, so OpenClaw does not have to restart work. Any parent channel/topic
    binding is rotated to a fresh session for future normal messages. DM is a
    peer scope, not a task parent, so legacy DM task aliases are ignored.
    """
    bot = await db.get(BotAccount, bot_id)
    if bot is None or not task_id:
        return None
    provider = provider_for(bot)
    provider_agent_id = provider_agent_id_for(bot)
    provider_account_id = provider_account_id_for(bot)
    task_binding = await _find_binding_by_scope(
        db,
        bot_id=bot.bot_id,
        provider=provider,
        provider_agent_id=provider_agent_id,
        provider_account_id=provider_account_id,
        scope_type=SCOPE_TASK,
        scope_id=task_id,
    )
    if task_binding is None:
        return None

    session_row = await _load_session_for_binding(db, task_binding)
    now = datetime.utcnow()
    parent_bindings = await _find_primary_bindings_for_session(
        db,
        session_id=session_row.session_id,
    )
    if any(binding.scope_type == SCOPE_DM for binding in parent_bindings):
        return None
    rotated_parent_sessions: list[AgentNexusSession] = []
    parent_scopes: list[dict[str, Any]] = []
    for parent_binding in parent_bindings:
        parent_scopes.append({
            "scope_type": parent_binding.scope_type,
            "scope_id": parent_binding.scope_id,
            "channel_id": parent_binding.channel_id,
            "topic_id": parent_binding.topic_id,
            "dm_id": parent_binding.dm_id,
        })
        rotated_parent_sessions.append(await _rotate_primary_binding_to_new_session(
            db,
            binding=parent_binding,
            bot_id=bot.bot_id,
            provider=provider,
            provider_agent_id=provider_agent_id,
            provider_account_id=provider_account_id,
            now=now,
            reason=f"task_adopted:{task_id}",
        ))

    task_binding.role = "primary"
    if channel_id and not task_binding.channel_id:
        task_binding.channel_id = channel_id

    metadata = _session_metadata(session_row)
    metadata.update({
        "ownership": "task",
        "adopted_by_task_id": task_id,
        "adopted_at": now.isoformat(),
        "adoption_reason": reason,
        "source_msg_id": source_msg_id,
    })
    if parent_scopes:
        metadata["parent_scope"] = parent_scopes[0]
        metadata["parent_scopes"] = parent_scopes
    if rotated_parent_sessions:
        metadata["rotated_parent_session_id"] = rotated_parent_sessions[0].session_id
        metadata["rotated_parent_session_ids"] = [row.session_id for row in rotated_parent_sessions]

    session_row.status = SESSION_STATUS_TASK_OWNED
    session_row.session_metadata = metadata
    session_row.current_scope_type = SCOPE_TASK
    session_row.current_scope_id = task_id
    session_row.last_used_at = now
    await db.flush()

    return SessionResolution(
        session_id=session_row.session_id,
        provider=provider,
        provider_session_key=session_row.provider_session_key,
        provider_account_id=provider_account_id,
        provider_agent_id=provider_agent_id,
        primary_scope_type=SCOPE_TASK,
        primary_scope_id=task_id,
        task_scope_id=task_id,
    )
