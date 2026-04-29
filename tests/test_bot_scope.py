"""Bot scope visibility and usage guards."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.db.models import (
    BotAccount,
    Channel,
    ChannelMembership,
    Friendship,
    User,
    Workspace,
)
from app.db.session import get_session as get_session_db
from app.main import app


async def _request_as(
    db_session: AsyncSession,
    user: User,
    method: str,
    path: str,
    *,
    json: dict | None = None,
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
            return await ac.request(method, path, json=json)
    finally:
        app.dependency_overrides.clear()


async def _seed_scope_data(db_session: AsyncSession, suffix: str) -> dict[str, object]:
    owner = User(user_id=f"scope-owner-{suffix}", username=f"scope_owner_{suffix}", password_hash="x")
    friend = User(user_id=f"scope-friend-{suffix}", username=f"scope_friend_{suffix}", password_hash="x")
    stranger = User(user_id=f"scope-stranger-{suffix}", username=f"scope_stranger_{suffix}", password_hash="x")
    ws = Workspace(workspace_id=f"scope-ws-{suffix}", name="Scope Workspace")
    ch = Channel(
        channel_id=f"scope-channel-{suffix}",
        workspace_id=ws.workspace_id,
        name="scope-channel",
        type="public",
    )
    private_bot = BotAccount(
        bot_id=f"scope-bot-private-{suffix}",
        username=f"scope_private_bot_{suffix}",
        display_name="Scope Private",
        created_by=owner.user_id,
        scope="private",
    )
    friend_bot = BotAccount(
        bot_id=f"scope-bot-friend-{suffix}",
        username=f"scope_friend_bot_{suffix}",
        display_name="Scope Friend",
        created_by=owner.user_id,
        scope="friend",
    )
    everyone_bot = BotAccount(
        bot_id=f"scope-bot-everyone-{suffix}",
        username=f"scope_everyone_bot_{suffix}",
        display_name="Scope Everyone",
        created_by=owner.user_id,
        scope="everyone",
    )
    db_session.add_all(
        [
            owner,
            friend,
            stranger,
            ws,
            ch,
            Friendship(user_id=owner.user_id, friend_id=friend.user_id, status="accepted"),
            ChannelMembership(channel_id=ch.channel_id, member_id=stranger.user_id, member_type="user"),
            private_bot,
            friend_bot,
            everyone_bot,
        ]
    )
    await db_session.flush()
    return {
        "owner": owner,
        "friend": friend,
        "stranger": stranger,
        "channel": ch,
        "private_bot": private_bot,
        "friend_bot": friend_bot,
        "everyone_bot": everyone_bot,
    }


def _ids(resp: Response) -> set[str]:
    return {item["bot_id"] for item in resp.json()["data"]}


@pytest.mark.asyncio
async def test_bot_scope_filters_bot_list_and_search(db_session: AsyncSession) -> None:
    data = await _seed_scope_data(db_session, "list")
    owner = data["owner"]
    friend = data["friend"]
    stranger = data["stranger"]
    private_bot = data["private_bot"]
    friend_bot = data["friend_bot"]
    everyone_bot = data["everyone_bot"]

    owner_list = await _request_as(db_session, owner, "GET", "/api/v1/bots")
    friend_list = await _request_as(db_session, friend, "GET", "/api/v1/bots")
    stranger_list = await _request_as(db_session, stranger, "GET", "/api/v1/bots")

    assert owner_list.status_code == 200
    assert _ids(owner_list) >= {private_bot.bot_id, friend_bot.bot_id, everyone_bot.bot_id}
    assert _ids(friend_list) >= {friend_bot.bot_id, everyone_bot.bot_id}
    assert private_bot.bot_id not in _ids(friend_list)
    assert _ids(stranger_list) >= {everyone_bot.bot_id}
    assert friend_bot.bot_id not in _ids(stranger_list)

    listed = next(item for item in owner_list.json()["data"] if item["bot_id"] == friend_bot.bot_id)
    assert listed["scope"] == "friend"
    assert "is_public" not in listed
    assert listed["owner"]["user_id"] == owner.user_id
    assert listed["can_manage"] is True

    search = await _request_as(db_session, stranger, "GET", "/api/v1/search?q=scope")
    assert search.status_code == 200
    search_bot_ids = {item["bot_id"] for item in search.json()["data"]["bots"]}
    assert everyone_bot.bot_id in search_bot_ids
    assert friend_bot.bot_id not in search_bot_ids
    assert private_bot.bot_id not in search_bot_ids


@pytest.mark.asyncio
async def test_bot_scope_guards_dm_and_channel_invites(db_session: AsyncSession) -> None:
    data = await _seed_scope_data(db_session, "guard")
    friend = data["friend"]
    stranger = data["stranger"]
    ch = data["channel"]
    friend_bot = data["friend_bot"]
    everyone_bot = data["everyone_bot"]

    denied_dm = await _request_as(
        db_session,
        stranger,
        "POST",
        "/api/v1/dms",
        json={"workspace_id": "ignored", "member_id": friend_bot.bot_id, "member_type": "bot"},
    )
    assert denied_dm.status_code == 403

    allowed_dm = await _request_as(
        db_session,
        stranger,
        "POST",
        "/api/v1/dms",
        json={"workspace_id": "ignored", "member_id": everyone_bot.bot_id, "member_type": "bot"},
    )
    assert allowed_dm.status_code == 200

    friend_dm = await _request_as(
        db_session,
        friend,
        "POST",
        "/api/v1/dms",
        json={"workspace_id": "ignored", "member_id": friend_bot.bot_id, "member_type": "bot"},
    )
    assert friend_dm.status_code == 200
    existing_channel_id = friend_dm.json()["data"]["channel_id"]
    friend_bot.scope = "private"
    await db_session.flush()

    existing_dm = await _request_as(
        db_session,
        friend,
        "POST",
        "/api/v1/dms",
        json={"workspace_id": "ignored", "member_id": friend_bot.bot_id, "member_type": "bot"},
    )
    assert existing_dm.status_code == 200
    assert existing_dm.json()["data"]["channel_id"] == existing_channel_id

    denied_invite = await _request_as(
        db_session,
        stranger,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": friend_bot.bot_id, "member_type": "bot"},
    )
    assert denied_invite.status_code == 403

    allowed_invite = await _request_as(
        db_session,
        stranger,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": everyone_bot.bot_id, "member_type": "bot"},
    )
    assert allowed_invite.status_code == 200

    existing_membership = await _request_as(
        db_session,
        stranger,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": everyone_bot.bot_id, "member_type": "bot"},
    )
    assert existing_membership.status_code == 200


@pytest.mark.asyncio
async def test_visible_non_owner_cannot_edit_bot(db_session: AsyncSession) -> None:
    data = await _seed_scope_data(db_session, "edit")
    stranger = data["stranger"]
    everyone_bot = data["everyone_bot"]

    resp = await _request_as(
        db_session,
        stranger,
        "PUT",
        f"/api/v1/bots/{everyone_bot.bot_id}",
        json={"display_name": "Nope", "scope": "private"},
    )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_owner_can_update_bot_scope(db_session: AsyncSession) -> None:
    data = await _seed_scope_data(db_session, "owner-update")
    owner = data["owner"]
    friend_bot = data["friend_bot"]

    resp = await _request_as(
        db_session,
        owner,
        "PUT",
        f"/api/v1/bots/{friend_bot.bot_id}",
        json={"scope": "everyone"},
    )

    assert resp.status_code == 200
    payload = resp.json()["data"]
    assert payload["scope"] == "everyone"
    assert "is_public" not in payload
