"""DM Bot routing tests."""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, Channel, ChannelMembership, Message, User, Workspace
from app.services.pipeline.bot import BotRunContext, IngestStage, RouteStage
from app.services.pipeline.bus import NullEventBus


async def _unused_adapter_factory(bot_id: str):  # pragma: no cover - route-only tests
    raise AssertionError(f"adapter factory should not be called: {bot_id}")


async def _run_route(session: AsyncSession, channel: Channel, msg: Message) -> BotRunContext:
    ctx = BotRunContext(
        channel_id=channel.channel_id,
        bus=NullEventBus(),
        session=session,
        trigger_msg=msg,
        adapter_factory=_unused_adapter_factory,
    )
    await IngestStage().run(ctx)
    await RouteStage().run(ctx)
    return ctx


@pytest.mark.asyncio
async def test_dm_user_message_routes_to_bot_without_mention(db_session: AsyncSession) -> None:
    ws = Workspace(workspace_id="dm-route-ws-0001", name="DM Routing")
    user = User(
        user_id="dm-route-user-0001",
        username="dm_route_user_0001",
        password_hash="x",
    )
    bot = BotAccount(
        bot_id="dm-route-bot-0001",
        username="dm_route_bot_0001",
        display_name="DM Bot",
        status="online",
    )
    ch = Channel(
        channel_id="dm-route-ch-0001",
        workspace_id=ws.workspace_id,
        name="dm:dm-route-user-0001:dm-route-bot-0001",
        type="dm",
    )
    msg = Message(
        msg_id="dm-route-msg-0001",
        channel_id=ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="你好，不带 @ 也应该发给这个 Bot",
        mention_bot_ids=[],
    )
    db_session.add_all(
        [
            ws,
            user,
            bot,
            ch,
            ChannelMembership(channel_id=ch.channel_id, member_id=user.user_id, member_type="user"),
            ChannelMembership(channel_id=ch.channel_id, member_id=bot.bot_id, member_type="bot"),
            msg,
        ]
    )
    await db_session.flush()

    ctx = await _run_route(db_session, ch, msg)

    assert ctx.target_usernames == ["dm_route_bot_0001"]


@pytest.mark.asyncio
async def test_user_dm_without_bot_does_not_route(db_session: AsyncSession) -> None:
    ws = Workspace(workspace_id="dm-route-ws-0002", name="User DM Routing")
    user = User(
        user_id="dm-route-user-0002",
        username="dm_route_user_0002",
        password_hash="x",
    )
    other = User(
        user_id="dm-route-user-0003",
        username="dm_route_user_0003",
        password_hash="x",
    )
    ch = Channel(
        channel_id="dm-route-ch-0002",
        workspace_id=ws.workspace_id,
        name="dm:dm-route-user-0002:dm-route-user-0003",
        type="dm",
    )
    msg = Message(
        msg_id="dm-route-msg-0002",
        channel_id=ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="普通用户 DM 不应该进 Bot pipeline",
        mention_bot_ids=[],
    )
    db_session.add_all(
        [
            ws,
            user,
            other,
            ch,
            ChannelMembership(channel_id=ch.channel_id, member_id=user.user_id, member_type="user"),
            ChannelMembership(channel_id=ch.channel_id, member_id=other.user_id, member_type="user"),
            msg,
        ]
    )
    await db_session.flush()

    ctx = await _run_route(db_session, ch, msg)

    assert ctx.target_usernames == []


@pytest.mark.asyncio
async def test_route_stage_respects_explicit_mention_bot_ids(db_session: AsyncSession) -> None:
    ws = Workspace(workspace_id="dm-route-ws-0003", name="Explicit Bot Mentions")
    user = User(
        user_id="dm-route-user-0004",
        username="dm_route_user_0004",
        password_hash="x",
    )
    ch = Channel(
        channel_id="dm-route-ch-0003",
        workspace_id=ws.workspace_id,
        name="public-route",
        type="public",
    )
    bot_a = BotAccount(
        bot_id="dm-route-bot-0002",
        username="dm_route_bot_a_0002",
        status="online",
    )
    bot_b = BotAccount(
        bot_id="dm-route-bot-0003",
        username="dm_route_bot_b_0003",
        status="online",
    )
    msg = Message(
        msg_id="dm-route-msg-0003",
        channel_id=ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="前端只传 mention_bot_ids 时也应该能触发目标 Bot",
        mention_bot_ids=[bot_b.bot_id],
    )
    db_session.add_all(
        [
            ws,
            user,
            ch,
            bot_a,
            bot_b,
            ChannelMembership(channel_id=ch.channel_id, member_id=user.user_id, member_type="user"),
            ChannelMembership(channel_id=ch.channel_id, member_id=bot_a.bot_id, member_type="bot"),
            ChannelMembership(channel_id=ch.channel_id, member_id=bot_b.bot_id, member_type="bot"),
            msg,
        ]
    )
    await db_session.flush()

    ctx = await _run_route(db_session, ch, msg)

    assert ctx.target_usernames == ["dm_route_bot_b_0003"]
