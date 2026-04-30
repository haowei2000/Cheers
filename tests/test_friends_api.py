"""好友管理 API 测试."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.db.models import Channel, ChannelMembership, Friendship, User, Workspace, WorkspaceMembership
from app.db.session import get_session as get_session_db
from app.main import app


async def _request_as(
    db_session: AsyncSession,
    user: User | None,
    method: str,
    path: str,
    *,
    json: dict | None = None,
    db_engine=None,
) -> Response:
    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    app.dependency_overrides[get_session_core] = override_get_session
    app.dependency_overrides[get_session_db] = override_get_session
    if user is not None:
        async def override_get_current_user() -> User:
            return user

        app.dependency_overrides[get_current_user] = override_get_current_user

    original_factory = None
    if db_engine is not None:
        import app.api.v1.messages.routes as messages_mod

        original_factory = messages_mod.async_session_factory
        messages_mod.async_session_factory = async_sessionmaker(
            db_engine, class_=AsyncSession, expire_on_commit=False, autocommit=False, autoflush=False
        )

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            return await ac.request(method, path, json=json)
    finally:
        if original_factory is not None:
            messages_mod.async_session_factory = original_factory
        app.dependency_overrides.clear()


def _user(user_id: str, username: str, role: str = "member") -> User:
    return User(user_id=user_id, username=username, password_hash="x", role=role)


@pytest.mark.asyncio
async def test_friend_request_accept_creates_and_updates_personal_notice(
    db_session: AsyncSession,
) -> None:
    alice = _user("friend-alice-001", "friend_alice_001")
    bob = _user("friend-bob-001", "friend_bob_001")
    db_session.add_all([alice, bob])
    await db_session.commit()

    create = await _request_as(
        db_session,
        alice,
        "POST",
        "/api/v1/friends/requests",
        json={"friend_identifier": bob.username},
    )
    assert create.status_code == 200
    friendship_id = create.json()["data"]["friendship_id"]
    assert create.json()["data"]["status"] == "pending"

    incoming = await _request_as(db_session, bob, "GET", "/api/v1/friends/requests?box=incoming")
    assert incoming.status_code == 200
    assert [r["friendship_id"] for r in incoming.json()["data"]] == [friendship_id]

    dms = await _request_as(db_session, bob, "GET", "/api/v1/dms")
    assert dms.status_code == 200
    notice = dms.json()["data"][0]
    assert notice["counterparty"]["member_type"] == "system"

    messages = await _request_as(
        db_session,
        bob,
        "GET",
        f"/api/v1/channels/{notice['channel_id']}/messages",
    )
    assert messages.status_code == 200
    msg = messages.json()["data"][0]
    assert msg["msg_type"] == "friend_request"
    assert msg["content_data"]["status"] == "pending"

    accept = await _request_as(
        db_session,
        bob,
        "POST",
        f"/api/v1/friends/requests/{friendship_id}/accept",
    )
    assert accept.status_code == 200
    assert accept.json()["data"]["status"] == "accepted"

    bob_friends = await _request_as(db_session, bob, "GET", "/api/v1/friends")
    assert [f["user_id"] for f in bob_friends.json()["data"]] == [alice.user_id]

    updated_messages = await _request_as(
        db_session,
        bob,
        "GET",
        f"/api/v1/channels/{notice['channel_id']}/messages",
    )
    assert updated_messages.json()["data"][0]["content_data"]["status"] == "accepted"


@pytest.mark.asyncio
async def test_duplicate_and_reverse_request_requires_explicit_accept(db_session: AsyncSession) -> None:
    alice = _user("friend-alice-002", "friend_alice_002")
    bob = _user("friend-bob-002", "friend_bob_002")
    db_session.add_all([alice, bob])
    await db_session.commit()

    first = await _request_as(
        db_session, alice, "POST", "/api/v1/friends/requests", json={"friend_identifier": bob.user_id}
    )
    assert first.status_code == 200

    duplicate = await _request_as(
        db_session, alice, "POST", "/api/v1/friends/requests", json={"friend_identifier": bob.user_id}
    )
    assert duplicate.status_code == 400

    reverse = await _request_as(
        db_session, bob, "POST", "/api/v1/friends/requests", json={"friend_identifier": alice.user_id}
    )
    assert reverse.status_code == 400

    accept = await _request_as(
        db_session,
        bob,
        "POST",
        f"/api/v1/friends/requests/{first.json()['data']['friendship_id']}/accept",
    )
    assert accept.status_code == 200
    assert accept.json()["data"]["status"] == "accepted"


@pytest.mark.asyncio
async def test_reject_cancel_block_and_unblock(db_session: AsyncSession) -> None:
    alice = _user("friend-alice-003", "friend_alice_003")
    bob = _user("friend-bob-003", "friend_bob_003")
    db_session.add_all([alice, bob])
    await db_session.commit()

    req = await _request_as(
        db_session, alice, "POST", "/api/v1/friends/requests", json={"friend_identifier": bob.user_id}
    )
    friendship_id = req.json()["data"]["friendship_id"]
    reject = await _request_as(db_session, bob, "POST", f"/api/v1/friends/requests/{friendship_id}/reject")
    assert reject.status_code == 200
    assert reject.json()["data"]["status"] == "rejected"

    resend = await _request_as(
        db_session, alice, "POST", "/api/v1/friends/requests", json={"friend_identifier": bob.user_id}
    )
    assert resend.status_code == 200
    cancel = await _request_as(
        db_session, alice, "DELETE", f"/api/v1/friends/requests/{resend.json()['data']['friendship_id']}"
    )
    assert cancel.status_code == 200

    blocked = await _request_as(
        db_session, alice, "POST", "/api/v1/friends/blocked", json={"friend_identifier": bob.user_id}
    )
    assert blocked.status_code == 200
    blocked_list = await _request_as(db_session, alice, "GET", "/api/v1/friends/blocked/list")
    assert [item["user_id"] for item in blocked_list.json()["data"]] == [bob.user_id]

    denied = await _request_as(
        db_session, bob, "POST", "/api/v1/friends/requests", json={"friend_identifier": alice.user_id}
    )
    assert denied.status_code == 403

    unblocked = await _request_as(db_session, alice, "DELETE", f"/api/v1/friends/blocked/{bob.user_id}")
    assert unblocked.status_code == 200
    after = await _request_as(db_session, alice, "GET", "/api/v1/friends/blocked/list")
    assert after.json()["data"] == []


@pytest.mark.asyncio
async def test_auth_and_spoofing_guards(db_session: AsyncSession) -> None:
    alice = _user("friend-alice-004", "friend_alice_004")
    bob = _user("friend-bob-004", "friend_bob_004")
    db_session.add_all([alice, bob])
    await db_session.commit()

    unauth = await _request_as(db_session, None, "GET", "/api/v1/friends")
    assert unauth.status_code == 401

    spoof = await _request_as(
        db_session,
        alice,
        "POST",
        "/api/v1/friends",
        json={"user_id": bob.user_id, "friend_identifier": alice.user_id},
    )
    assert spoof.status_code == 403

    legacy_other = await _request_as(db_session, alice, "GET", f"/api/v1/friends/{bob.user_id}")
    assert legacy_other.status_code == 403


@pytest.mark.asyncio
async def test_dm_requires_accepted_friendship_and_send_guard(
    db_session: AsyncSession,
    db_engine,
) -> None:
    alice = _user("friend-alice-005", "friend_alice_005")
    bob = _user("friend-bob-005", "friend_bob_005")
    ws = Workspace(workspace_id="friend-ws-005", name="Friend WS", kind="personal")
    dm = Channel(channel_id="friend-dm-005", workspace_id=ws.workspace_id, name="dm-test", type="dm")
    db_session.add_all([
        alice,
        bob,
        ws,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=alice.user_id, role="owner"),
        dm,
        ChannelMembership(channel_id=dm.channel_id, member_id=alice.user_id, member_type="user"),
        ChannelMembership(channel_id=dm.channel_id, member_id=bob.user_id, member_type="user"),
    ])
    await db_session.commit()

    denied_upsert = await _request_as(
        db_session,
        alice,
        "POST",
        "/api/v1/dms",
        json={"workspace_id": ws.workspace_id, "member_id": bob.user_id, "member_type": "user"},
    )
    assert denied_upsert.status_code == 403

    denied_send = await _request_as(
        db_session,
        alice,
        "POST",
        f"/api/v1/channels/{dm.channel_id}/messages",
        json={"content": "hi", "sender_id": alice.user_id, "sender_type": "user"},
        db_engine=db_engine,
    )
    assert denied_send.status_code == 403

    db_session.add(Friendship(user_id=alice.user_id, friend_id=bob.user_id, status="accepted"))
    await db_session.commit()

    allowed_send = await _request_as(
        db_session,
        alice,
        "POST",
        f"/api/v1/channels/{dm.channel_id}/messages",
        json={"content": "hi", "sender_id": alice.user_id, "sender_type": "user"},
        db_engine=db_engine,
    )
    assert allowed_send.status_code == 200


@pytest.mark.asyncio
async def test_channel_admin_can_invite_non_friend_by_identifier(db_session: AsyncSession) -> None:
    admin = _user("friend-admin-006", "friend_admin_006")
    target = _user("friend-target-006", "friend_target_006")
    ws = Workspace(workspace_id="friend-ws-006", name="Friend WS")
    ch = Channel(channel_id="friend-channel-006", workspace_id=ws.workspace_id, name="project", type="public")
    db_session.add_all([
        admin,
        target,
        ws,
        ch,
        ChannelMembership(channel_id=ch.channel_id, member_id=admin.user_id, member_type="user", role="admin"),
    ])
    await db_session.commit()

    invite = await _request_as(
        db_session,
        admin,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/invite",
        json={"identifier": target.username},
    )
    assert invite.status_code == 200
    assert invite.json()["data"]["user_id"] == target.user_id
