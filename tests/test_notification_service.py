"""Tests for unified system-DM notifications."""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import Channel, ChannelMembership, ChannelUnreadCount, Message, User, Workspace
from app.services.notification_service import (
    NOTIFICATION_CHANNEL_PURPOSE,
    NOTIFICATION_MSG_TYPE,
    NOTIFICATION_SYSTEM_ID,
    NotificationService,
)


def _user(user_id: str, username: str, display_name: str | None = None) -> User:
    return User(
        user_id=user_id,
        username=username,
        display_name=display_name,
        password_hash="x",
    )


@pytest.mark.asyncio
async def test_mention_fanout_creates_unified_notification_dm(
    db_session: AsyncSession,
    db_engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.notification_service as notification_mod

    alice = _user("mention-alice-001", "mention_alice_001", "Alice")
    bob = _user("mention-bob-001", "mention_bob_001", "Bob")
    workspace = Workspace(workspace_id="mention-ws-001", name="Mention Workspace")
    channel = Channel(channel_id="mention-channel-001", workspace_id=workspace.workspace_id, name="general")
    db_session.add_all([
        alice,
        bob,
        workspace,
        channel,
        ChannelMembership(channel_id=channel.channel_id, member_id=alice.user_id, member_type="user"),
        ChannelMembership(channel_id=channel.channel_id, member_id=bob.user_id, member_type="user"),
    ])
    await db_session.flush()
    msg = Message(
        channel_id=channel.channel_id,
        sender_id=alice.user_id,
        sender_type="user",
        content=f"please check this @{bob.username}",
    )
    db_session.add(msg)
    await db_session.commit()

    class Broker:
        def __init__(self) -> None:
            self.channel_frames: list[tuple[str, dict]] = []
            self.user_frames: list[tuple[str, dict]] = []

        async def publish_channel(self, channel_id: str, message: dict) -> None:
            self.channel_frames.append((channel_id, message))

        async def publish_user(self, user_id: str, message: dict) -> None:
            self.user_frames.append((user_id, message))

    broker = Broker()
    original_factory = notification_mod.async_session_factory
    notification_mod.async_session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
    )
    monkeypatch.setattr(notification_mod, "get_realtime_broker", lambda: broker)
    try:
        await NotificationService.fanout_mentions_for_message_id(msg.msg_id)
    finally:
        notification_mod.async_session_factory = original_factory

    notice_channel = (
        await db_session.execute(
            select(Channel)
            .join(ChannelMembership, ChannelMembership.channel_id == Channel.channel_id)
            .where(
                Channel.purpose == NOTIFICATION_CHANNEL_PURPOSE,
                ChannelMembership.member_id == bob.user_id,
                ChannelMembership.member_type == "user",
            )
        )
    ).scalar_one()
    system_member = await db_session.get(
        ChannelMembership,
        {"channel_id": notice_channel.channel_id, "member_id": NOTIFICATION_SYSTEM_ID},
    )
    assert system_member is not None

    notice_msg = (
        await db_session.execute(
            select(Message).where(
                Message.channel_id == notice_channel.channel_id,
                Message.msg_type == NOTIFICATION_MSG_TYPE,
            )
        )
    ).scalar_one()
    assert notice_msg.content_data["kind"] == "mention_notification"
    assert notice_msg.content_data["source_msg_id"] == msg.msg_id
    unread = await db_session.get(
        ChannelUnreadCount,
        {"channel_id": notice_channel.channel_id, "user_id": bob.user_id},
    )
    assert unread is not None and unread.unread_count == 1
    assert len(broker.channel_frames) == 1
    assert broker.channel_frames[0][0] == notice_channel.channel_id
    assert broker.channel_frames[0][1]["type"] == "message"
    assert broker.channel_frames[0][1]["data"]["msg_id"] == notice_msg.msg_id
    assert broker.user_frames[0][0] == bob.user_id
    assert broker.user_frames[0][1]["type"] == "channel_new_message"
