"""Agent Bridge stable session mapping tests."""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentNexusSession, AgentNexusSessionBinding, BotAccount, Channel, Message, Workspace
from app.features.agent_bridge.session_map import (
    SCOPE_CHANNEL,
    SCOPE_DM,
    SCOPE_TASK,
    SCOPE_TOPIC,
    SESSION_STATUS_CLOSED,
    SESSION_STATUS_TASK_OWNED,
    adopt_session_for_task,
    build_provider_session_key,
    resolve_dispatch_session,
)
from app.features.bot_runtime.pipeline.bot.topic_context import gather_topic_context


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
        binding_type="agent_bridge",
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
    assert second.provider_session_key == first.provider_session_key
    assert first.primary_scope_type == SCOPE_CHANNEL
    assert f"account:acct-chan-001:session:{first.session_id}" in first.provider_session_key

    bindings = await _bindings(db_session, first.session_id)
    assert {(b.scope_type, b.scope_id, b.role) for b in bindings} == {
        (SCOPE_CHANNEL, channel.channel_id, "primary"),
        (SCOPE_TASK, "task-chan-001", "alias"),
        (SCOPE_TASK, "task-chan-002", "alias"),
    }


@pytest.mark.asyncio
async def test_bot_dm_scope_uses_user_bot_identity_not_channel_id(db_session: AsyncSession) -> None:
    bot, first_dm = await _seed_bot_channel(db_session, suffix="dm-001", channel_type="dm")
    second_dm = Channel(
        channel_id="sess-map-ch-dm-001-duplicate",
        workspace_id=first_dm.workspace_id,
        name="duplicate-dm-backing-channel",
        type="dm",
    )
    db_session.add(second_dm)
    await db_session.flush()

    user_id = "sess-map-user-dm-001"
    first = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=first_dm.channel_id,
        trigger_message={"user": user_id, "text": "first dm turn"},
        task_id="task-dm-001",
        channel=first_dm,
    )
    second = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=second_dm.channel_id,
        trigger_message={"user": user_id, "text": "same user same bot in another dm row"},
        task_id="task-dm-002",
        channel=second_dm,
    )

    assert second.session_id == first.session_id
    assert second.provider_session_key == first.provider_session_key
    assert first.primary_scope_type == SCOPE_DM
    assert first.primary_scope_id == f"user:{user_id}:bot:{bot.bot_id}"

    bindings = await _bindings(db_session, first.session_id)
    assert {(b.scope_type, b.scope_id, b.role) for b in bindings} == {
        (SCOPE_DM, f"user:{user_id}:bot:{bot.bot_id}", "primary"),
        (SCOPE_TASK, "task-dm-001", "alias"),
        (SCOPE_TASK, "task-dm-002", "alias"),
    }
    dm_binding = next(b for b in bindings if b.scope_type == SCOPE_DM)
    assert dm_binding.channel_id is None
    assert dm_binding.dm_id is None


@pytest.mark.asyncio
async def test_bot_dm_reply_topic_context_does_not_split_session(db_session: AsyncSession) -> None:
    bot, dm = await _seed_bot_channel(db_session, suffix="dm-topic-001", channel_type="dm")
    user_id = "sess-map-user-dm-topic-001"

    first = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=dm.channel_id,
        trigger_message={"user": user_id, "text": "top-level dm"},
        task_id="task-dm-topic-001",
        channel=dm,
    )
    reply = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=dm.channel_id,
        trigger_message={
            "user": user_id,
            "text": "reply inside dm",
            "topic_chain": [{"msg_id": "dm-topic-root-001"}],
        },
        task_id="task-dm-topic-002",
        channel=dm,
    )

    assert reply.session_id == first.session_id
    assert reply.provider_session_key == first.provider_session_key
    assert reply.primary_scope_type == SCOPE_DM
    assert reply.primary_scope_id == f"user:{user_id}:bot:{bot.bot_id}"

    bindings = await _bindings(db_session, first.session_id)
    assert (SCOPE_TOPIC, "dm-topic-root-001") not in {
        (b.scope_type, b.scope_id) for b in bindings
    }


@pytest.mark.asyncio
async def test_bot_dm_reuses_legacy_channel_scoped_binding(db_session: AsyncSession) -> None:
    bot, dm = await _seed_bot_channel(db_session, suffix="dm-legacy-001", channel_type="dm")
    user_id = "sess-map-user-dm-legacy-001"
    legacy_session_id = "sess-map-legacy-dm-session-001"
    legacy_key = build_provider_session_key(
        provider_agent_id="agent-main",
        provider_account_id="acct-dm-legacy-001",
        session_id=legacy_session_id,
    )
    db_session.add(
        AgentNexusSession(
            session_id=legacy_session_id,
            bot_id=bot.bot_id,
            provider_agent_id="agent-main",
            provider_account_id="acct-dm-legacy-001",
            provider_session_key=legacy_key,
            current_scope_type=SCOPE_DM,
            current_scope_id=dm.channel_id,
        )
    )
    db_session.add(
        AgentNexusSessionBinding(
            session_id=legacy_session_id,
            bot_id=bot.bot_id,
            provider_agent_id="agent-main",
            provider_account_id="acct-dm-legacy-001",
            scope_type=SCOPE_DM,
            scope_id=dm.channel_id,
            channel_id=dm.channel_id,
            dm_id=dm.channel_id,
            role="primary",
        )
    )
    await db_session.flush()

    resolved = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=dm.channel_id,
        trigger_message={"user": user_id, "text": "reuse existing dm context"},
        task_id="task-dm-legacy-001",
        channel=dm,
    )

    assert resolved.session_id == legacy_session_id
    assert resolved.provider_session_key == legacy_key
    assert resolved.primary_scope_type == SCOPE_DM
    assert resolved.primary_scope_id == f"user:{user_id}:bot:{bot.bot_id}"

    bindings = await _bindings(db_session, legacy_session_id)
    assert (SCOPE_DM, dm.channel_id) in {
        (b.scope_type, b.scope_id) for b in bindings
    }
    assert (SCOPE_DM, f"user:{user_id}:bot:{bot.bot_id}") in {
        (b.scope_type, b.scope_id) for b in bindings
    }
    modern_dm_binding = next(
        b for b in bindings if b.scope_type == SCOPE_DM and b.scope_id == f"user:{user_id}:bot:{bot.bot_id}"
    )
    legacy_dm_binding = next(b for b in bindings if b.scope_type == SCOPE_DM and b.scope_id == dm.channel_id)
    assert modern_dm_binding.channel_id is None
    assert modern_dm_binding.dm_id is None
    assert legacy_dm_binding.channel_id == dm.channel_id
    assert legacy_dm_binding.dm_id == dm.channel_id


@pytest.mark.asyncio
async def test_task_alias_can_switch_back_to_channel_session(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="switch-001")

    first = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "topic task",
            "topic_chain": [{"msg_id": "topic-root-001", "msg_type": SCOPE_TOPIC}],
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
async def test_channel_reply_uses_channel_session_until_parent_is_topic(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="reply-channel-001")

    channel_session = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "plain channel turn"},
        task_id="task-reply-channel-root",
        channel=channel,
    )
    reply_session = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "ordinary reply",
            "in_reply_to_msg_id": "parent-normal-001",
            "topic_chain": [{"msg_id": "parent-normal-001", "msg_type": "normal"}],
        },
        task_id="task-reply-channel-ordinary",
        channel=channel,
    )
    topic_session = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "reply after parent promoted",
            "in_reply_to_msg_id": "parent-topic-001",
            "topic_chain": [{"msg_id": "parent-topic-001", "msg_type": SCOPE_TOPIC}],
        },
        task_id="task-reply-channel-topic",
        channel=channel,
    )

    assert reply_session.session_id == channel_session.session_id
    assert reply_session.primary_scope_type == SCOPE_CHANNEL
    assert topic_session.session_id != channel_session.session_id
    assert topic_session.primary_scope_type == SCOPE_TOPIC
    assert topic_session.primary_scope_id == "parent-topic-001"

    channel_bindings = await _bindings(db_session, channel_session.session_id)
    topic_bindings = await _bindings(db_session, topic_session.session_id)
    assert (SCOPE_TOPIC, "parent-normal-001") not in {
        (b.scope_type, b.scope_id) for b in channel_bindings
    }
    assert (SCOPE_CHANNEL, channel.channel_id) in {
        (b.scope_type, b.scope_id) for b in channel_bindings
    }
    assert (SCOPE_TOPIC, "parent-topic-001") in {
        (b.scope_type, b.scope_id) for b in topic_bindings
    }


@pytest.mark.asyncio
async def test_real_topic_context_drives_reply_session_split_after_promotion(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="reply-promote-001")
    parent = Message(
        msg_id="reply-promote-parent-001",
        channel_id=channel.channel_id,
        sender_id="reply-promote-user-001",
        sender_type="user",
        content="parent",
        msg_type="normal",
    )
    reply = Message(
        msg_id="reply-promote-reply-001",
        channel_id=channel.channel_id,
        sender_id="reply-promote-user-001",
        sender_type="user",
        content="reply",
        in_reply_to_msg_id=parent.msg_id,
        msg_type="reply",
    )
    db_session.add_all([parent, reply])
    await db_session.flush()

    channel_session = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "plain channel turn"},
        task_id="task-reply-promote-root",
        channel=channel,
    )
    ordinary_chain, _ = await gather_topic_context(reply, db_session)
    ordinary_reply = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "ordinary reply from real context",
            "in_reply_to_msg_id": parent.msg_id,
            "topic_chain": ordinary_chain,
        },
        task_id="task-reply-promote-ordinary",
        channel=channel,
    )

    parent.msg_type = SCOPE_TOPIC
    await db_session.flush()
    topic_chain, _ = await gather_topic_context(reply, db_session)
    topic_reply = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={
            "text": "topic reply from real context",
            "in_reply_to_msg_id": parent.msg_id,
            "topic_chain": topic_chain,
        },
        task_id="task-reply-promote-topic",
        channel=channel,
    )

    assert ordinary_chain[0]["msg_type"] == "normal"
    assert ordinary_reply.session_id == channel_session.session_id
    assert topic_chain[0]["msg_type"] == SCOPE_TOPIC
    assert topic_reply.session_id != channel_session.session_id
    assert topic_reply.primary_scope_type == SCOPE_TOPIC
    assert topic_reply.primary_scope_id == parent.msg_id


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
            "topic_chain": [{"msg_id": "topic-root-chan-001", "msg_type": SCOPE_TOPIC}],
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
        binding_type="agent_bridge",
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
    assert other_account.provider_session_key != first.provider_session_key
    assert "account:acct-other" in other_account.provider_session_key


@pytest.mark.asyncio
async def test_background_task_adopts_session_and_rotates_channel(db_session: AsyncSession) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="adopt-001")

    original = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "start long openclaw work"},
        task_id="task-adopt-001",
        channel=channel,
    )

    adopted = await adopt_session_for_task(
        db_session,
        bot_id=bot.bot_id,
        channel_id=channel.channel_id,
        task_id="task-adopt-001",
        source_msg_id="placeholder-adopt-001",
        reason="test",
    )
    assert adopted is not None
    assert adopted.session_id == original.session_id
    assert adopted.provider_session_key == original.provider_session_key
    assert adopted.primary_scope_type == SCOPE_TASK

    task_session = await db_session.get(AgentNexusSession, original.session_id)
    assert task_session is not None
    assert task_session.status == SESSION_STATUS_TASK_OWNED
    assert task_session.current_scope_type == SCOPE_TASK
    assert task_session.current_scope_id == "task-adopt-001"
    assert task_session.session_metadata["parent_scope"]["scope_type"] == SCOPE_CHANNEL
    assert task_session.session_metadata["parent_scope"]["scope_id"] == channel.channel_id

    old_bindings = await _bindings(db_session, original.session_id)
    assert {(b.scope_type, b.scope_id, b.role) for b in old_bindings} == {
        (SCOPE_TASK, "task-adopt-001", "primary"),
    }

    normal_after_adopt = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "normal channel follow up"},
        task_id="task-channel-after-adopt",
        channel=channel,
    )
    assert normal_after_adopt.session_id != original.session_id
    assert normal_after_adopt.primary_scope_type == SCOPE_CHANNEL

    old_task_again = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "continue old task"},
        task_id="task-adopt-001",
        channel=channel,
    )
    assert old_task_again.session_id == original.session_id
    assert old_task_again.primary_scope_type == SCOPE_TASK


@pytest.mark.asyncio
async def test_session_visibility_api_lists_bot_and_scope(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="api-001")
    resolved = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "hello api"},
        task_id="task-api-001",
        channel=channel,
    )
    await db_session.flush()

    bot_resp = await client.get(f"/api/v1/bots/{bot.bot_id}/sessions")
    assert bot_resp.status_code == 200
    bot_data = bot_resp.json()["data"]
    assert [row["session_id"] for row in bot_data] == [resolved.session_id]
    assert bot_data[0]["provider_session_key"] == resolved.provider_session_key

    scope_resp = await client.get(
        "/api/v1/agent-bridge/sessions/scope",
        params={
            "scope_type": SCOPE_CHANNEL,
            "scope_id": channel.channel_id,
            "channel_id": channel.channel_id,
        },
    )
    assert scope_resp.status_code == 200
    scope_data = scope_resp.json()["data"]
    assert [row["session_id"] for row in scope_data] == [resolved.session_id]


@pytest.mark.asyncio
async def test_bot_sessions_api_includes_closed_sessions_by_default(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot, channel = await _seed_bot_channel(db_session, suffix="api-all-001")
    active = await resolve_dispatch_session(
        db_session,
        bot=bot,
        channel_id=channel.channel_id,
        trigger_message={"text": "hello api all"},
        task_id="task-api-all-active",
        channel=channel,
    )
    closed_session_id = "sess-map-api-all-closed-001"
    db_session.add(
        AgentNexusSession(
            session_id=closed_session_id,
            bot_id=bot.bot_id,
            provider_agent_id="agent-main",
            provider_account_id="acct-api-all-001",
            provider_session_key=build_provider_session_key(
                provider_agent_id="agent-main",
                provider_account_id="acct-api-all-001",
                session_id=closed_session_id,
            ),
            current_scope_type=SCOPE_CHANNEL,
            current_scope_id=channel.channel_id,
            status=SESSION_STATUS_CLOSED,
        )
    )
    await db_session.flush()

    all_resp = await client.get(f"/api/v1/bots/{bot.bot_id}/sessions")
    assert all_resp.status_code == 200
    assert {row["session_id"] for row in all_resp.json()["data"]} == {
        active.session_id,
        closed_session_id,
    }

    active_resp = await client.get(
        f"/api/v1/bots/{bot.bot_id}/sessions",
        params={"include_closed": "false"},
    )
    assert active_resp.status_code == 200
    assert [row["session_id"] for row in active_resp.json()["data"]] == [active.session_id]
