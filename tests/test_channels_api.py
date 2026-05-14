"""ChatCore 频道 API 测试（TDD）."""
from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AgentNexusSession,
    AgentNexusSessionBinding,
    AgentTask,
    BotAccount,
    BotRun,
    Channel,
    ChannelMembership,
    ChannelProfile,
    ChannelUnreadCount,
    HistoryPage,
    MemoryEntry,
    Message,
    TodoItem,
    User,
    Workspace,
)
from app.db.seed import _ensure_builtin_bot_memberships
from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID
from app.services.channel_service import ChannelService


@pytest.mark.asyncio
async def test_list_channels_empty(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/channels 无频道时返回空列表."""
    resp = await client.get("/api/v1/channels")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["data"] == []


@pytest.mark.asyncio
async def test_create_channel(client: AsyncClient, db_session: AsyncSession) -> None:
    """POST /api/channels 创建频道，需 workspace_id、name."""
    # 先创建 workspace
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000001", name="Default")
    db_session.add(ws)
    await db_session.commit()

    resp = await client.post(
        "/api/v1/channels",
        json={"workspace_id": "a0000000-0000-0000-0000-000000000001", "name": "general", "type": "public"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    ch = data["data"]
    assert "channel_id" in ch
    assert ch["name"] == "general"
    assert ch["type"] == "public"
    assert ch["workspace_id"] == "a0000000-0000-0000-0000-000000000001"


@pytest.mark.asyncio
async def test_create_dm_channel_does_not_auto_add_builtin_bots(db_session: AsyncSession) -> None:
    """DM 私聊不自动添加 Helper。"""
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000010", name="DM Workspace")
    creator = User(
        user_id="a0000000-0000-0000-0000-000000000010",
        username="dm_admin",
        password_hash="x",
        role="system_admin",
    )
    db_session.add_all([ws, creator])
    await db_session.flush()

    svc = ChannelService(db_session)
    ch = await svc.create(
        workspace_id=ws.workspace_id,
        name="dm:user-a:user-b",
        type="dm",
        creator=creator,
    )

    rows = (await db_session.execute(
        text("select member_id from channel_memberships where channel_id = :channel_id"),
        {"channel_id": ch.channel_id},
    )).all()
    member_ids = {row[0] for row in rows}
    assert HELPER_BOT_ID not in member_ids


@pytest.mark.asyncio
async def test_builtin_membership_sync_skips_dm_channels(db_session: AsyncSession) -> None:
    """启动补齐只处理普通频道，并清理误注入 DM 的内置 Bot。"""
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000011", name="Sync Workspace")
    public = Channel(
        channel_id="b0000000-0000-0000-0000-000000000011",
        workspace_id=ws.workspace_id,
        name="general",
        type="public",
    )
    user_dm = Channel(
        channel_id="b0000000-0000-0000-0000-000000000012",
        workspace_id=ws.workspace_id,
        name="dm:user-a:user-b",
        type="dm",
    )
    helper_dm = Channel(
        channel_id="b0000000-0000-0000-0000-000000000013",
        workspace_id=ws.workspace_id,
        name=f"dm:{':'.join(sorted(['user-a', HELPER_BOT_ID]))}",
        type="dm",
    )
    db_session.add_all([ws, public, user_dm, helper_dm])
    for channel_id, member_id in (
        (user_dm.channel_id, HELPER_BOT_ID),
        (helper_dm.channel_id, HELPER_BOT_ID),
    ):
        db_session.add(
            ChannelMembership(
                channel_id=channel_id,
                member_id=member_id,
                member_type="bot",
            )
        )

    await _ensure_builtin_bot_memberships(db_session)
    await db_session.flush()

    rows = (await db_session.execute(
        text("select channel_id, member_id from channel_memberships")
    )).all()
    members_by_channel: dict[str, set[str]] = {}
    for channel_id, member_id in rows:
        members_by_channel.setdefault(channel_id, set()).add(member_id)

    assert HELPER_BOT_ID in members_by_channel[public.channel_id]
    assert HELPER_BOT_ID not in members_by_channel.get(user_dm.channel_id, set())
    assert HELPER_BOT_ID in members_by_channel[helper_dm.channel_id]


@pytest.mark.asyncio
async def test_list_channels_returns_created(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET /api/channels 返回已创建频道."""
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000002", name="W2")
    db_session.add(ws)
    ch = Channel(
        channel_id="b0000000-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="random",
        type="public",
    )
    db_session.add(ch)
    # Add test user as channel member so list_for_user returns the channel
    membership = ChannelMembership(
        channel_id="b0000000-0000-0000-0000-000000000001",
        member_id="a0000000-0000-0000-0000-000000000099",
        member_type="user",
    )
    db_session.add(membership)
    await db_session.commit()

    resp = await client.get("/api/v1/channels")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    items = data["data"]
    assert len(items) >= 1
    names = [c["name"] for c in items]
    assert "random" in names


@pytest.mark.asyncio
async def test_unread_counts_for_uses_grouped_counts(db_session: AsyncSession) -> None:
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000020", name="Unread Workspace")
    user = User(
        user_id="a0000000-0000-0000-0000-000000000020",
        username="unread-user",
        password_hash="x",
    )
    ch1 = Channel(channel_id="b0000000-0000-0000-0000-000000000020", workspace_id=ws.workspace_id, name="c1")
    ch2 = Channel(channel_id="b0000000-0000-0000-0000-000000000021", workspace_id=ws.workspace_id, name="c2")
    ch3 = Channel(channel_id="b0000000-0000-0000-0000-000000000022", workspace_id=ws.workspace_id, name="c3")
    now = datetime.utcnow()
    db_session.add_all([
        ws,
        user,
        ch1,
        ch2,
        ch3,
        ChannelMembership(
            channel_id=ch1.channel_id,
            member_id=user.user_id,
            member_type="user",
            last_read_at=now - timedelta(minutes=5),
        ),
        ChannelMembership(channel_id=ch2.channel_id, member_id=user.user_id, member_type="user"),
        Message(
            channel_id=ch1.channel_id,
            sender_id="other",
            sender_type="user",
            content="old",
            created_at=now - timedelta(minutes=10),
        ),
        Message(
            channel_id=ch1.channel_id,
            sender_id="other",
            sender_type="user",
            content="new",
            created_at=now,
        ),
        Message(
            channel_id=ch1.channel_id,
            sender_id=user.user_id,
            sender_type="user",
            content="mine",
            created_at=now,
        ),
        Message(
            channel_id=ch2.channel_id,
            sender_id="bot-1",
            sender_type="bot",
            content="bot",
            created_at=now,
        ),
        Message(
            channel_id=ch3.channel_id,
            sender_id="other",
            sender_type="user",
            content="not a member",
            created_at=now,
        ),
    ])
    await db_session.flush()

    counts = await ChannelService(db_session).unread_counts_for(
        user.user_id,
        [ch1.channel_id, ch2.channel_id, ch3.channel_id],
    )

    assert counts == {ch1.channel_id: 1, ch2.channel_id: 1, ch3.channel_id: 0}
    cached = (
        await db_session.execute(
            select(ChannelUnreadCount).where(ChannelUnreadCount.user_id == user.user_id)
        )
    ).scalars().all()
    assert {row.channel_id: row.unread_count for row in cached} == {
        ch1.channel_id: 1,
        ch2.channel_id: 1,
    }


@pytest.mark.asyncio
async def test_unread_count_cache_increment_and_mark_read(db_session: AsyncSession) -> None:
    ws = Workspace(workspace_id="a0000000-0000-0000-0000-000000000023", name="Unread Cache Workspace")
    user = User(
        user_id="a0000000-0000-0000-0000-000000000023",
        username="unread-cache-user",
        password_hash="x",
    )
    ch = Channel(channel_id="b0000000-0000-0000-0000-000000000023", workspace_id=ws.workspace_id, name="cache")
    db_session.add_all([
        ws,
        user,
        ch,
        ChannelMembership(channel_id=ch.channel_id, member_id=user.user_id, member_type="user"),
    ])
    await db_session.flush()

    from app.services.unread_count_service import increment_unread_counts

    await increment_unread_counts(
        db_session,
        channel_id=ch.channel_id,
        user_ids=[user.user_id, user.user_id],
    )
    counts = await ChannelService(db_session).unread_counts_for(user.user_id, [ch.channel_id])
    assert counts == {ch.channel_id: 1}

    marked_at = await ChannelService(db_session).mark_read(ch.channel_id, user.user_id)
    assert marked_at is not None
    counts = await ChannelService(db_session).unread_counts_for(user.user_id, [ch.channel_id])
    assert counts == {ch.channel_id: 0}


@pytest.mark.asyncio
async def test_delete_channel_cleans_session_bindings_and_related_rows(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """DELETE /channels/{id} also removes channel-scoped FK dependents."""
    test_user_id = "a0000000-0000-0000-0000-000000000099"
    ws = Workspace(
        workspace_id="delete-channel-ws-0001",
        name="Delete Channel Workspace",
    )
    ch = Channel(
        channel_id="delete-channel-ch-0001",
        workspace_id=ws.workspace_id,
        name="delete-me",
        type="public",
    )
    bot = BotAccount(
        bot_id="delete-channel-bot-0001",
        username="delete_channel_bot",
        display_name="DeleteChannelBot",
    )
    agent_session = AgentNexusSession(
        session_id="delete-channel-session-0001",
        bot_id=bot.bot_id,
        provider="generic",
        provider_account_id="acct-delete-channel",
        provider_agent_id="agent-main",
        provider_session_key="provider:generic:account:acct-delete-channel:session:delete-channel-session-0001",
        current_scope_type="channel",
        current_scope_id=ch.channel_id,
    )
    binding = AgentNexusSessionBinding(
        binding_id="delete-channel-binding-0001",
        session_id=agent_session.session_id,
        bot_id=bot.bot_id,
        provider="generic",
        provider_account_id=agent_session.provider_account_id,
        provider_agent_id=agent_session.provider_agent_id,
        scope_type="channel",
        scope_id=ch.channel_id,
        channel_id=ch.channel_id,
        role="primary",
    )
    scope_only_session = AgentNexusSession(
        session_id="delete-channel-session-0002",
        bot_id=bot.bot_id,
        provider="generic",
        provider_account_id="acct-delete-channel-scope-only",
        provider_agent_id="agent-main",
        provider_session_key="provider:generic:account:acct-delete-channel-scope-only:session:delete-channel-session-0002",
        current_scope_type="channel",
        current_scope_id=ch.channel_id,
    )
    scope_only_binding = AgentNexusSessionBinding(
        binding_id="delete-channel-binding-0002",
        session_id=scope_only_session.session_id,
        bot_id=bot.bot_id,
        provider="generic",
        provider_account_id=scope_only_session.provider_account_id,
        provider_agent_id=scope_only_session.provider_agent_id,
        scope_type="channel",
        scope_id=ch.channel_id,
        channel_id=None,
        role="primary",
    )
    db_session.add_all([ws, ch, bot])
    await db_session.flush()
    db_session.add_all([agent_session, scope_only_session])
    await db_session.flush()
    db_session.add_all(
        [
            binding,
            scope_only_binding,
            ChannelMembership(
                channel_id=ch.channel_id,
                member_id=test_user_id,
                member_type="user",
                role="owner",
            ),
            ChannelProfile(
                channel_id=ch.channel_id,
                user_id=test_user_id,
                nickname="deleter",
            ),
            TodoItem(
                todo_id="delete-channel-todo-0001",
                channel_id=ch.channel_id,
                creator_id=test_user_id,
                creator_type="user",
                content="cleanup",
            ),
            HistoryPage(
                page_id="delete-channel-history-0001",
                channel_id=ch.channel_id,
                page_number=1,
                started_at=datetime.utcnow(),
                ended_at=datetime.utcnow(),
                first_msg_id="msg-first",
                last_msg_id="msg-last",
                summary="summary",
                raw_content="raw",
                message_count=1,
            ),
            MemoryEntry(
                entry_id="delete-channel-memory-0001",
                channel_id=ch.channel_id,
                layer="ANCHOR",
                title="anchor",
                content="memory",
                sort_order=1,
            ),
            AgentTask(
                task_id="delete-channel-task-0001",
                channel_id=ch.channel_id,
                bot_id=bot.bot_id,
                trigger_msg_id="trigger-msg",
            ),
            BotRun(
                bot_run_id="delete-channel-run-0001",
                task_id="delete-channel-task-0001",
                channel_id=ch.channel_id,
                trigger_msg_id="trigger-msg",
                bot_id=bot.bot_id,
                placeholder_msg_id="placeholder-msg",
            ),
        ]
    )
    await db_session.commit()

    resp = await client.delete(f"/api/v1/channels/{ch.channel_id}")

    assert resp.status_code == 200
    db_session.expire_all()
    assert await db_session.get(Channel, ch.channel_id) is None
    assert await db_session.get(AgentNexusSession, agent_session.session_id) is None
    assert await db_session.get(AgentNexusSessionBinding, binding.binding_id) is None
    assert await db_session.get(AgentNexusSession, scope_only_session.session_id) is None
    assert await db_session.get(AgentNexusSessionBinding, scope_only_binding.binding_id) is None

    profile = await db_session.execute(
        select(ChannelProfile).where(
            ChannelProfile.channel_id == ch.channel_id,
            ChannelProfile.user_id == test_user_id,
        )
    )
    assert profile.scalar_one_or_none() is None
    assert await db_session.get(TodoItem, "delete-channel-todo-0001") is None
    assert await db_session.get(MemoryEntry, "delete-channel-memory-0001") is None
    assert await db_session.get(AgentTask, "delete-channel-task-0001") is None
    assert await db_session.get(BotRun, "delete-channel-run-0001") is None
    assert await db_session.get(HistoryPage, "delete-channel-history-0001") is None
