"""Contextual search API tests."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.db.models import (
    AgentTask,
    BotAccount,
    Channel,
    ChannelMembership,
    FileRecord,
    FileScopeLink,
    Friendship,
    Message,
    TodoItem,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.db.session import get_session as get_session_db
from app.main import app


async def _request_as(
    db_session: AsyncSession,
    user: User,
    method: str,
    path: str,
) -> Response:
    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    async def override_get_current_user() -> User:
        return user

    app.dependency_overrides[get_session_core] = override_get_session
    app.dependency_overrides[get_session_db] = override_get_session
    app.dependency_overrides[get_current_user] = override_get_current_user
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            return await ac.request(method, path)
    finally:
        app.dependency_overrides.clear()


def _user(user_id: str, username: str, role: str = "member") -> User:
    return User(user_id=user_id, username=username, password_hash="x", role=role)


@pytest.mark.asyncio
async def test_add_friend_context_returns_only_non_friend_users(db_session: AsyncSession) -> None:
    alice = _user("sr-alice", "sr_alice")
    bob = _user("sr-bob", "sr_friend_bob")
    charlie = _user("sr-charlie", "sr_friend_charlie")
    db_session.add_all([
        alice,
        bob,
        charlie,
        Friendship(user_id=alice.user_id, friend_id=bob.user_id, status="accepted"),
    ])
    await db_session.flush()

    resp = await _request_as(db_session, alice, "GET", "/api/v1/search?q=sr_friend&context=add_friend")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert [u["user_id"] for u in data["users"]] == [charlie.user_id]
    assert data["channels"] == []
    assert data["bots"] == []
    assert data["todos"] == []
    assert data["tasks"] == []
    assert data["messages"] == []


@pytest.mark.asyncio
async def test_dm_start_context_returns_only_authorized_people_and_bots(db_session: AsyncSession) -> None:
    alice = _user("sr-dm-alice", "sr_dm_alice")
    friend = _user("sr-dm-friend", "sr_dm_friend")
    blocked = _user("sr-dm-blocked", "sr_dm_blocked")
    stranger = _user("sr-dm-stranger", "sr_dm_stranger")
    owned_bot = BotAccount(
        bot_id="sr-dm-owned-bot",
        username="sr_dm_owned_bot",
        created_by=alice.user_id,
        scope="private",
    )
    friend_bot = BotAccount(
        bot_id="sr-dm-friend-bot",
        username="sr_dm_friend_bot",
        created_by=friend.user_id,
        scope="friend",
    )
    everyone_bot = BotAccount(
        bot_id="sr-dm-everyone-bot",
        username="sr_dm_everyone_bot",
        created_by=stranger.user_id,
        scope="everyone",
    )
    hidden_bot = BotAccount(
        bot_id="sr-dm-hidden-bot",
        username="sr_dm_hidden_bot",
        created_by=stranger.user_id,
        scope="private",
    )
    db_session.add_all([
        alice,
        friend,
        blocked,
        stranger,
        Friendship(user_id=alice.user_id, friend_id=friend.user_id, status="accepted"),
        Friendship(user_id=alice.user_id, friend_id=blocked.user_id, status="blocked"),
        owned_bot,
        friend_bot,
        everyone_bot,
        hidden_bot,
    ])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        alice,
        "GET",
        "/api/v1/search?q=sr_dm&context=dm_start&types=users,bots&limit=20",
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert [u["user_id"] for u in data["users"]] == [friend.user_id]
    assert {b["bot_id"] for b in data["bots"]} == {
        owned_bot.bot_id,
        friend_bot.bot_id,
        everyone_bot.bot_id,
    }


@pytest.mark.asyncio
async def test_workspace_invite_context_excludes_workspace_members(db_session: AsyncSession) -> None:
    owner = _user("sr-ws-owner", "sr_ws_owner")
    member = _user("sr-ws-member", "sr_ws_candidate_member")
    outsider = _user("sr-ws-outsider", "sr_ws_candidate_outsider")
    ws = Workspace(workspace_id="sr-ws", name="Search Workspace")
    db_session.add_all([
        owner,
        member,
        outsider,
        ws,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=owner.user_id, role="owner"),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=member.user_id, role="member"),
    ])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        owner,
        "GET",
        f"/api/v1/search?q=sr_ws_candidate&context=workspace_invite&workspace_id={ws.workspace_id}",
    )
    missing_scope = await _request_as(
        db_session,
        owner,
        "GET",
        "/api/v1/search?q=sr_ws_candidate&context=workspace_invite",
    )

    assert resp.status_code == 200
    assert [u["user_id"] for u in resp.json()["data"]["users"]] == [outsider.user_id]
    assert missing_scope.status_code == 400


@pytest.mark.asyncio
async def test_workspace_invite_context_requires_workspace_manager(db_session: AsyncSession) -> None:
    owner = _user("sr-ws-auth-owner", "sr_ws_auth_owner")
    member = _user("sr-ws-auth-member", "sr_ws_auth_member")
    candidate = _user("sr-ws-auth-candidate", "sr_ws_auth_candidate")
    ws = Workspace(workspace_id="sr-ws-auth", name="Search Workspace Auth")
    db_session.add_all([
        owner,
        member,
        candidate,
        ws,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=owner.user_id, role="owner"),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=member.user_id, role="member"),
    ])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        member,
        "GET",
        f"/api/v1/search?q=sr_ws_auth_candidate&context=workspace_invite&workspace_id={ws.workspace_id}",
    )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_channel_contexts_exclude_existing_members_and_keep_bot_scope(db_session: AsyncSession) -> None:
    owner = _user("sr-ch-owner", "sr_ch_owner")
    stranger = _user("sr-ch-stranger", "sr_ch_stranger")
    existing_user = _user("sr-ch-member", "sr_channel_pick_member")
    outsider = _user("sr-ch-outsider", "sr_channel_pick_outsider")
    ws = Workspace(workspace_id="sr-ch-ws", name="Search Channel Workspace")
    ch = Channel(
        channel_id="sr-ch",
        workspace_id=ws.workspace_id,
        name="search-channel",
        type="public",
        allow_member_invites=True,
        allow_bot_adds=True,
    )
    existing_bot = BotAccount(
        bot_id="sr-bot-existing",
        username="sr_channel_bot_existing",
        created_by=owner.user_id,
        scope="everyone",
    )
    friend_only_bot = BotAccount(
        bot_id="sr-bot-friend",
        username="sr_channel_bot_friend",
        created_by=owner.user_id,
        scope="friend",
    )
    everyone_bot = BotAccount(
        bot_id="sr-bot-everyone",
        username="sr_channel_bot_everyone",
        created_by=owner.user_id,
        scope="everyone",
    )
    db_session.add_all([
        owner,
        stranger,
        existing_user,
        outsider,
        ws,
        ch,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=stranger.user_id),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=existing_user.user_id),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=outsider.user_id),
        ChannelMembership(channel_id=ch.channel_id, member_id=stranger.user_id, member_type="user"),
        ChannelMembership(channel_id=ch.channel_id, member_id=existing_user.user_id, member_type="user"),
        ChannelMembership(channel_id=ch.channel_id, member_id=existing_bot.bot_id, member_type="bot"),
        existing_bot,
        friend_only_bot,
        everyone_bot,
    ])
    await db_session.flush()

    user_resp = await _request_as(
        db_session,
        stranger,
        "GET",
        f"/api/v1/search?q=sr_channel_pick&context=channel_invite_user&channel_id={ch.channel_id}",
    )
    bot_resp = await _request_as(
        db_session,
        stranger,
        "GET",
        f"/api/v1/search?q=sr_channel_bot&context=channel_invite_bot&channel_id={ch.channel_id}",
    )

    assert user_resp.status_code == 200
    assert [u["user_id"] for u in user_resp.json()["data"]["users"]] == [outsider.user_id]
    bot_ids = {b["bot_id"] for b in bot_resp.json()["data"]["bots"]}
    assert bot_ids == {everyone_bot.bot_id}


@pytest.mark.asyncio
async def test_channel_invite_context_respects_invite_permissions(db_session: AsyncSession) -> None:
    owner = _user("sr-ch-auth-owner", "sr_ch_auth_owner")
    caller = _user("sr-ch-auth-caller", "sr_ch_auth_caller")
    candidate = _user("sr-ch-auth-candidate", "sr_ch_auth_candidate")
    ws = Workspace(workspace_id="sr-ch-auth-ws", name="Search Channel Auth Workspace")
    ch = Channel(
        channel_id="sr-ch-auth",
        workspace_id=ws.workspace_id,
        name="auth-channel",
        type="public",
        allow_member_invites=False,
        allow_bot_adds=False,
    )
    bot = BotAccount(
        bot_id="sr-ch-auth-bot",
        username="sr_ch_auth_candidate_bot",
        created_by=owner.user_id,
        scope="everyone",
    )
    db_session.add_all([
        owner,
        caller,
        candidate,
        ws,
        ch,
        bot,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=caller.user_id),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=candidate.user_id),
        ChannelMembership(channel_id=ch.channel_id, member_id=caller.user_id, member_type="user"),
    ])
    await db_session.flush()

    bot_resp = await _request_as(
        db_session,
        caller,
        "GET",
        f"/api/v1/search?q=sr_ch_auth_candidate&context=channel_invite_bot&channel_id={ch.channel_id}",
    )
    assert bot_resp.status_code == 403

    ch.allow_member_invites = True
    await db_session.flush()
    mixed_resp = await _request_as(
        db_session,
        caller,
        "GET",
        f"/api/v1/search?q=sr_ch_auth_candidate&context=channel_invite&channel_id={ch.channel_id}&limit=20",
    )

    assert mixed_resp.status_code == 200
    data = mixed_resp.json()["data"]
    assert [u["user_id"] for u in data["users"]] == [candidate.user_id]
    assert data["bots"] == []


@pytest.mark.asyncio
async def test_global_nav_does_not_leak_channel_scoped_rows(db_session: AsyncSession) -> None:
    user = _user("sr-global-user", "sr_global_user")
    bot = BotAccount(bot_id="sr-global-bot", username="sr_global_bot", created_by=user.user_id, scope="private")
    visible_ws = Workspace(workspace_id="sr-global-ws", name="needle workspace")
    hidden_ws = Workspace(workspace_id="sr-hidden-ws", name="needle hidden workspace")
    visible_ch = Channel(channel_id="sr-visible-ch", workspace_id=visible_ws.workspace_id, name="needle channel", type="public")
    hidden_ch = Channel(channel_id="sr-hidden-ch", workspace_id=hidden_ws.workspace_id, name="needle hidden channel", type="public")
    visible_msg = Message(
        msg_id="sr-visible-msg",
        channel_id=visible_ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle visible message",
    )
    secret_msg = Message(
        msg_id="sr-secret-msg",
        channel_id=visible_ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle secret message",
        is_secret=True,
    )
    hidden_msg = Message(
        msg_id="sr-hidden-msg",
        channel_id=hidden_ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle hidden message",
    )
    visible_todo = TodoItem(
        todo_id="sr-visible-todo",
        channel_id=visible_ch.channel_id,
        creator_id=user.user_id,
        creator_type="user",
        content="needle visible todo",
    )
    hidden_todo = TodoItem(
        todo_id="sr-hidden-todo",
        channel_id=hidden_ch.channel_id,
        creator_id=user.user_id,
        creator_type="user",
        content="needle hidden todo",
    )
    visible_task = AgentTask(
        task_id="sr-visible-task",
        channel_id=visible_ch.channel_id,
        bot_id=bot.bot_id,
        trigger_msg_id=visible_msg.msg_id,
        response_msg_id=None,
    )
    hidden_task = AgentTask(
        task_id="sr-hidden-task",
        channel_id=hidden_ch.channel_id,
        bot_id=bot.bot_id,
        trigger_msg_id=hidden_msg.msg_id,
        response_msg_id=None,
    )
    db_session.add_all([
        user,
        bot,
        visible_ws,
        hidden_ws,
        visible_ch,
        hidden_ch,
        WorkspaceMembership(workspace_id=visible_ws.workspace_id, user_id=user.user_id),
        ChannelMembership(channel_id=visible_ch.channel_id, member_id=user.user_id, member_type="user"),
        visible_msg,
        secret_msg,
        hidden_msg,
        visible_todo,
        hidden_todo,
        visible_task,
        hidden_task,
    ])
    await db_session.flush()

    resp = await _request_as(db_session, user, "GET", "/api/v1/search?q=needle&context=global_nav&limit=20")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {w["workspace_id"] for w in data["workspaces"]} == {visible_ws.workspace_id}
    assert {c["channel_id"] for c in data["channels"]} == {visible_ch.channel_id}
    assert {m["msg_id"] for m in data["messages"]} == {visible_msg.msg_id}
    assert {t["todo_id"] for t in data["todos"]} == {visible_todo.todo_id}
    assert {t["task_id"] for t in data["tasks"]} == {visible_task.task_id}


@pytest.mark.asyncio
async def test_global_nav_file_search_respects_membership_and_scopes(db_session: AsyncSession) -> None:
    user = _user("sr-file-user", "sr_file_user")
    visible_ws = Workspace(workspace_id="sr-file-visible-ws", name="Visible File Workspace")
    other_ws = Workspace(workspace_id="sr-file-other-ws", name="Other File Workspace")
    visible_ch = Channel(
        channel_id="sr-file-visible-ch",
        workspace_id=visible_ws.workspace_id,
        name="file-visible",
        type="public",
    )
    second_ch = Channel(
        channel_id="sr-file-second-ch",
        workspace_id=visible_ws.workspace_id,
        name="file-second",
        type="public",
    )
    hidden_ch = Channel(
        channel_id="sr-file-hidden-ch",
        workspace_id=other_ws.workspace_id,
        name="file-hidden",
        type="public",
    )
    first_file = FileRecord(
        file_id="sr-file-visible",
        channel_id=visible_ch.channel_id,
        uploader_id=user.user_id,
        original_path="/tmp/sr-file-visible.pdf",
        original_filename="needle-plan.pdf",
        content_type="application/pdf",
        size_bytes=100,
        status="ready",
        summary_3lines="visible file summary",
    )
    second_file = FileRecord(
        file_id="sr-file-second",
        channel_id=None,
        workspace_id=visible_ws.workspace_id,
        uploader_id=user.user_id,
        original_path="/tmp/sr-file-second.docx",
        original_filename="second-file.docx",
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size_bytes=200,
        status="ready",
        summary_3lines="needle appears in the second channel summary",
    )
    hidden_file = FileRecord(
        file_id="sr-file-hidden",
        channel_id=hidden_ch.channel_id,
        uploader_id="sr-file-hidden-uploader",
        original_path="/tmp/sr-file-hidden.pdf",
        original_filename="needle-hidden.pdf",
        content_type="application/pdf",
        size_bytes=300,
        status="ready",
        summary_3lines="hidden file summary",
    )
    db_session.add_all([
        user,
        visible_ws,
        other_ws,
        visible_ch,
        second_ch,
        hidden_ch,
        WorkspaceMembership(workspace_id=visible_ws.workspace_id, user_id=user.user_id),
        ChannelMembership(channel_id=visible_ch.channel_id, member_id=user.user_id, member_type="user"),
        ChannelMembership(channel_id=second_ch.channel_id, member_id=user.user_id, member_type="user"),
        first_file,
        second_file,
        hidden_file,
        FileScopeLink(
            file_id=second_file.file_id,
            scope_type="channel",
            scope_id=second_ch.channel_id,
            workspace_id=visible_ws.workspace_id,
            created_by=user.user_id,
        ),
    ])
    await db_session.flush()

    global_resp = await _request_as(
        db_session,
        user,
        "GET",
        "/api/v1/search?q=needle&context=global_nav&types=files&limit=20",
    )
    channel_resp = await _request_as(
        db_session,
        user,
        "GET",
        f"/api/v1/search?q=needle&context=file_lookup&channel_id={second_ch.channel_id}&limit=20",
    )

    assert global_resp.status_code == 200
    assert {f["file_id"] for f in global_resp.json()["data"]["files"]} == {
        first_file.file_id,
        second_file.file_id,
    }
    assert channel_resp.status_code == 200
    assert [f["file_id"] for f in channel_resp.json()["data"]["files"]] == [second_file.file_id]


@pytest.mark.asyncio
async def test_search_types_filter_returns_only_requested_groups(db_session: AsyncSession) -> None:
    user = _user("sr-types-user", "sr_types_user")
    ws = Workspace(workspace_id="sr-types-ws", name="Types Workspace")
    ch = Channel(channel_id="sr-types-ch", workspace_id=ws.workspace_id, name="types-channel", type="public")
    msg = Message(
        msg_id="sr-types-msg",
        channel_id=ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle message",
    )
    file = FileRecord(
        file_id="sr-types-file",
        channel_id=ch.channel_id,
        uploader_id=user.user_id,
        original_path="/tmp/sr-types-file.pdf",
        original_filename="needle-file.pdf",
        content_type="application/pdf",
        size_bytes=123,
        status="ready",
    )
    db_session.add_all([
        user,
        ws,
        ch,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=user.user_id),
        ChannelMembership(channel_id=ch.channel_id, member_id=user.user_id, member_type="user"),
        msg,
        file,
    ])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        user,
        "GET",
        "/api/v1/search?q=needle&context=global_nav&types=files&limit=20",
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert [f["file_id"] for f in data["files"]] == [file.file_id]
    assert data["messages"] == []
    assert data["channels"] == []
    assert data["users"] == []


@pytest.mark.asyncio
async def test_channel_invite_context_returns_users_and_bots(db_session: AsyncSession) -> None:
    owner = _user("sr-mixed-owner", "sr_mixed_owner")
    caller = _user("sr-mixed-caller", "sr_mixed_caller")
    candidate = _user("sr-mixed-candidate", "sr_mixed_candidate")
    ws = Workspace(workspace_id="sr-mixed-ws", name="Mixed Invite Workspace")
    ch = Channel(
        channel_id="sr-mixed-ch",
        workspace_id=ws.workspace_id,
        name="mixed-channel",
        type="public",
        allow_member_invites=True,
        allow_bot_adds=True,
    )
    bot = BotAccount(
        bot_id="sr-mixed-bot",
        username="sr_mixed_candidate_bot",
        created_by=owner.user_id,
        scope="everyone",
    )
    db_session.add_all([
        owner,
        caller,
        candidate,
        ws,
        ch,
        bot,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=caller.user_id),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=candidate.user_id),
        ChannelMembership(channel_id=ch.channel_id, member_id=caller.user_id, member_type="user"),
    ])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        caller,
        "GET",
        f"/api/v1/search?q=sr_mixed_candidate&context=channel_invite&channel_id={ch.channel_id}",
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert [u["user_id"] for u in data["users"]] == [candidate.user_id]
    assert [b["bot_id"] for b in data["bots"]] == [bot.bot_id]


@pytest.mark.asyncio
async def test_global_nav_message_search_can_be_channel_scoped(db_session: AsyncSession) -> None:
    user = _user("sr-channel-scope-user", "sr_channel_scope_user")
    ws = Workspace(workspace_id="sr-channel-scope-ws", name="Channel Scope Workspace")
    first_ch = Channel(
        channel_id="sr-channel-scope-a",
        workspace_id=ws.workspace_id,
        name="scope-a",
        type="public",
    )
    second_ch = Channel(
        channel_id="sr-channel-scope-b",
        workspace_id=ws.workspace_id,
        name="scope-b",
        type="public",
    )
    first_msg = Message(
        msg_id="sr-channel-scope-msg-a",
        channel_id=first_ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle scoped first channel",
    )
    second_msg = Message(
        msg_id="sr-channel-scope-msg-b",
        channel_id=second_ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle scoped second channel",
    )
    db_session.add_all([
        user,
        ws,
        first_ch,
        second_ch,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=user.user_id),
        ChannelMembership(channel_id=first_ch.channel_id, member_id=user.user_id, member_type="user"),
        ChannelMembership(channel_id=second_ch.channel_id, member_id=user.user_id, member_type="user"),
        first_msg,
        second_msg,
    ])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        user,
        "GET",
        f"/api/v1/search?q=needle&context=global_nav&channel_id={second_ch.channel_id}&limit=20",
    )

    assert resp.status_code == 200
    assert {m["msg_id"] for m in resp.json()["data"]["messages"]} == {second_msg.msg_id}


@pytest.mark.asyncio
async def test_task_monitor_context_allows_system_admin_to_search_all_tasks(db_session: AsyncSession) -> None:
    admin = _user("sr-admin", "sr_admin", role="system_admin")
    user = _user("sr-task-user", "sr_task_user")
    bot = BotAccount(bot_id="sr-task-bot", username="sr_task_bot", created_by=user.user_id, scope="private")
    ws = Workspace(workspace_id="sr-task-ws", name="Task Workspace")
    ch = Channel(channel_id="sr-task-ch", workspace_id=ws.workspace_id, name="Task Channel", type="public")
    msg = Message(
        msg_id="sr-task-msg",
        channel_id=ch.channel_id,
        sender_id=user.user_id,
        sender_type="user",
        content="needle admin task",
    )
    task = AgentTask(
        task_id="sr-admin-task",
        channel_id=ch.channel_id,
        bot_id=bot.bot_id,
        trigger_msg_id=msg.msg_id,
    )
    db_session.add_all([admin, user, bot, ws, ch, msg, task])
    await db_session.flush()

    resp = await _request_as(db_session, admin, "GET", "/api/v1/search?q=needle&context=task_monitor")

    assert resp.status_code == 200
    assert [t["task_id"] for t in resp.json()["data"]["tasks"]] == [task.task_id]
