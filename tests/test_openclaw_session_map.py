"""OpenClaw stable session mapping tests."""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentNexusSessionBinding, BotAccount, Channel, Workspace
from app.services.openclaw_bridge.session_map import (
    SCOPE_CHANNEL,
    SCOPE_TASK,
    SCOPE_TOPIC,
    resolve_dispatch_session,
)


async def _seed_bot_channel(
    session: AsyncSession,
    *,
    suffix: str,
    channel_type: str = "public",
) -> tuple[BotAccount, Channel]:
    workspace = Workspace(workspace_id=f"sess-map-ws-{suffix}", name=f"Session Map {suffix}")
    channel = Channel(
        channel_id=f"sess-map-ch-{suffix}",
        workspace_id=workspace.workspace_id,
        name=f"session-map-{suffix}",
        type=channel_type,
    )
    bot = BotAccount(
        bot_id=f"sess-map-bot-{suffix}",
        username=f"sess_map_bot_{suffix.replace('-', '_')}",
        display_name="Session Bot",
        status="online",
        binding_type="websocket",
        binding_config={"account_id": f"acct-{suffix}", "agent_id": "agent-main"},
    )
    session.add_all([workspace, channel, bot])
    await session.flush()
    return bot, channel


async def _bindings(session: AsyncSession, session_id: str) -> list[AgentNexusSessionBinding]:
    result = await session.execute(
        select(AgentNexusSessionBinding)
        .where(AgentNexusSessionBinding.session_id == session_id)
        .order_by(AgentNexusSessionBinding.scope_type, AgentNexusSessionBinding.scope_id)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_channel_scope_reuses_session_and_binds_tasks(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="chan-001")

    first = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "@bot hi"},
        task_id="task-chan-001",
        channel=channel,
    )
    second = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "@bot follow up"},
        task_id="task-chan-002",
        channel=channel,
    )

    assert second.session_id == first.session_id
    assert second.openclaw_session_key == first.openclaw_session_key
    assert first.primary_scope_type == SCOPE_CHANNEL
    assert f"account:acct-chan-001:session:{first.session_id}" in first.openclaw_session_key

    bindings = await _bindings(db_session, first.session_id)
    assert {(b.scope_type, b.scope_id, b.role) for b in bindings} == {
        (SCOPE_CHANNEL, channel.channel_id, "primary"),
        (SCOPE_TASK, "task-chan-001", "alias"),
        (SCOPE_TASK, "task-chan-002", "alias"),
    }


@pytest.mark.asyncio
async def test_task_alias_can_switch_back_to_channel_session(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="switch-001")

    first = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "topic task",
            "topic_chain": [{"msg_id": "topic-root-001"}],
        },
        task_id="task-switch-001",
        channel=channel,
    )
    switched = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "continue from task view"},
        task_id="task-switch-001",
        channel=channel,
    )

    assert switched.session_id == first.session_id
    assert switched.primary_scope_type == SCOPE_TOPIC

    bindings = await _bindings(db_session, first.session_id)
    assert {(b.scope_type, b.scope_id) for b in bindings} == {
        (SCOPE_TOPIC, "topic-root-001"),
        (SCOPE_TASK, "task-switch-001"),
    }


@pytest.mark.asyncio
async def test_topic_task_session_does_not_claim_channel_scope(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="topic-chan-001")

    channel_session = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "plain channel turn"},
        task_id="task-channel-default",
        channel=channel,
    )
    topic_session = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "topic turn",
            "topic_chain": [{"msg_id": "topic-root-chan-001"}],
        },
        task_id="task-topic-001",
        channel=channel,
    )
    switched = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "continue task from channel surface"},
        task_id="task-topic-001",
        channel=channel,
    )

    assert topic_session.session_id != channel_session.session_id
    assert switched.session_id == topic_session.session_id
    assert switched.primary_scope_type == SCOPE_TOPIC

    channel_bindings = await _bindings(db_session, channel_session.session_id)
    topic_bindings = await _bindings(db_session, topic_session.session_id)
    assert (SCOPE_CHANNEL, channel.channel_id) in {
        (b.scope_type, b.scope_id) for b in channel_bindings
    }
    assert (SCOPE_CHANNEL, channel.channel_id) not in {
        (b.scope_type, b.scope_id) for b in topic_bindings
    }


@pytest.mark.asyncio
async def test_same_channel_is_isolated_by_openclaw_account(db_session: AsyncSession) -> None:
    bot_a, channel = await _seed_bot_channel(db_session, suffix="acct-001")
    bot_b = BotAccount(
        bot_id="sess-map-bot-acct-002",
        username="sess_map_bot_acct_002",
        display_name="Session Bot B",
        status="online",
        binding_type="websocket",
        binding_config={"account_id": "acct-other", "agent_id": "agent-main"},
    )
    db_session.add(bot_b)
    await db_session.flush()

    first = await resolve_dispatch_session(
        db_session,
        bot=bot_a,
        channel_id=channel.channel_id,
        trigger_message={"text": "@bot-a hi"},
        task_id="task-acct-001",
        channel=channel,
    )
    other_account = await resolve_dispatch_session(
        db_session,
        bot=bot_b,
        channel_id=channel.channel_id,
        trigger_message={"text": "@bot-b hi"},
        task_id="task-acct-002",
        channel=channel,
    )

    assert other_account.session_id != first.session_id
    assert other_account.openclaw_session_key != first.openclaw_session_key
    assert "account:acct-other" in other_account.openclaw_session_key
