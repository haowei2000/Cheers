"""Permission guard tests for channel/workspace scoped reads."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.core.exceptions import ForbiddenError
from app.db.models import (
    BotAccount,
    Channel,
    ChannelMembership,
    PromptTemplate,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.db.session import get_session as get_session_db
from app.main import app
from app.services.channel_service import ChannelService
from app.services.workspace_service import WorkspaceService


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


@pytest.mark.asyncio
async def test_channel_member_guard_rejects_non_member(db_session: AsyncSession) -> None:
    user = User(
        user_id="u-perm-001",
        username="perm_user_001",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-001", name="Perm WS")
    ch = Channel(
        channel_id="c-perm-001",
        workspace_id=ws.workspace_id,
        name="private-channel",
        type="private",
    )
    db_session.add_all([user, ws, ch])
    await db_session.commit()

    with pytest.raises(ForbiddenError):
        await ChannelService(db_session).require_channel_member(ch.channel_id, user)


@pytest.mark.asyncio
async def test_workspace_member_guard_rejects_non_member(db_session: AsyncSession) -> None:
    user = User(
        user_id="u-perm-002",
        username="perm_user_002",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-002", name="Perm WS 2")
    db_session.add_all([user, ws])
    await db_session.commit()

    with pytest.raises(ForbiddenError):
        await WorkspaceService(db_session).list_members_with_details(ws.workspace_id, user)


@pytest.mark.asyncio
async def test_channel_admin_guard_rejects_plain_member(db_session: AsyncSession) -> None:
    admin = User(user_id="u-perm-admin", username="perm_admin", password_hash="x", role="member")
    member = User(user_id="u-perm-member", username="perm_member", password_hash="x", role="member")
    ws = Workspace(workspace_id="w-perm-admin", name="Perm WS Admin")
    ch = Channel(channel_id="c-perm-admin", workspace_id=ws.workspace_id, name="guarded", type="public")
    db_session.add_all([
        admin,
        member,
        ws,
        ch,
        ChannelMembership(channel_id=ch.channel_id, member_id=admin.user_id, member_type="user", role="admin"),
        ChannelMembership(channel_id=ch.channel_id, member_id=member.user_id, member_type="user", role="member"),
    ])
    await db_session.commit()

    await ChannelService(db_session).require_channel_admin(ch.channel_id, admin)
    with pytest.raises(ForbiddenError):
        await ChannelService(db_session).require_channel_admin(ch.channel_id, member)


@pytest.mark.asyncio
async def test_channel_settings_and_memory_writes_require_channel_admin(db_session: AsyncSession) -> None:
    admin = User(user_id="u-perm-api-admin", username="perm_api_admin", password_hash="x", role="member")
    member = User(user_id="u-perm-api-member", username="perm_api_member", password_hash="x", role="member")
    ws = Workspace(workspace_id="w-perm-api", name="Perm API WS")
    ch = Channel(channel_id="c-perm-api", workspace_id=ws.workspace_id, name="api-guarded", type="public")
    db_session.add_all([
        admin,
        member,
        ws,
        ch,
        ChannelMembership(channel_id=ch.channel_id, member_id=admin.user_id, member_type="user", role="admin"),
        ChannelMembership(channel_id=ch.channel_id, member_id=member.user_id, member_type="user", role="member"),
    ])
    await db_session.commit()

    denied_settings = await _request_as(
        db_session,
        member,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/settings",
        json={"auto_assist": True, "type": "private"},
    )
    assert denied_settings.status_code == 403

    allowed_settings = await _request_as(
        db_session,
        admin,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/settings",
        json={"auto_assist": True, "type": "private"},
    )
    assert allowed_settings.status_code == 200
    allowed_channel = allowed_settings.json()["data"]
    assert allowed_channel["auto_assist"] is True
    assert allowed_channel["type"] == "private"

    denied_memory = await _request_as(
        db_session,
        member,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/memory/",
        json={"layer": "ANCHOR", "content": "member write"},
    )
    assert denied_memory.status_code == 403

    allowed_memory = await _request_as(
        db_session,
        admin,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/memory/",
        json={"layer": "ANCHOR", "content": "admin write"},
    )
    assert allowed_memory.status_code == 200


@pytest.mark.asyncio
async def test_workspace_channel_list_hides_private_and_dm_from_regular_members(
    db_session: AsyncSession,
) -> None:
    member = User(user_id="u-perm-list-member", username="perm_list_member", password_hash="x", role="member")
    ws_admin = User(user_id="u-perm-list-admin", username="perm_list_admin", password_hash="x", role="member")
    ws = Workspace(workspace_id="w-perm-list", name="Perm List WS")
    public = Channel(channel_id="c-perm-list-public", workspace_id=ws.workspace_id, name="public", type="public")
    hidden_private = Channel(
        channel_id="c-perm-list-hidden",
        workspace_id=ws.workspace_id,
        name="hidden-private",
        type="private",
    )
    joined_private = Channel(
        channel_id="c-perm-list-joined",
        workspace_id=ws.workspace_id,
        name="joined-private",
        type="private",
    )
    dm = Channel(channel_id="c-perm-list-dm", workspace_id=ws.workspace_id, name="dm", type="dm")
    db_session.add_all([
        member,
        ws_admin,
        ws,
        public,
        hidden_private,
        joined_private,
        dm,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=member.user_id, role="member"),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=ws_admin.user_id, role="admin"),
        ChannelMembership(channel_id=joined_private.channel_id, member_id=member.user_id, member_type="user"),
    ])
    await db_session.commit()

    regular_resp = await _request_as(db_session, member, "GET", f"/api/v1/workspaces/{ws.workspace_id}/channels")
    assert regular_resp.status_code == 200
    regular_names = {item["name"] for item in regular_resp.json()["data"]}
    assert regular_names == {"public", "joined-private"}

    admin_resp = await _request_as(db_session, ws_admin, "GET", f"/api/v1/workspaces/{ws.workspace_id}/channels")
    assert admin_resp.status_code == 200
    admin_names = {item["name"] for item in admin_resp.json()["data"]}
    assert admin_names == {"public", "hidden-private", "joined-private"}


@pytest.mark.asyncio
async def test_workspace_admin_can_read_private_channel_settings_without_membership(
    db_session: AsyncSession,
) -> None:
    workspace_admin = User(
        user_id="u-perm-private-ws-admin",
        username="perm_private_ws_admin",
        password_hash="x",
        role="member",
    )
    regular_member = User(
        user_id="u-perm-private-regular",
        username="perm_private_regular",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-private-settings", name="Private Settings WS")
    ch = Channel(
        channel_id="c-perm-private-settings",
        workspace_id=ws.workspace_id,
        name="private-settings",
        type="private",
    )
    db_session.add_all([
        workspace_admin,
        regular_member,
        ws,
        ch,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=workspace_admin.user_id, role="admin"),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=regular_member.user_id, role="member"),
    ])
    await db_session.commit()

    allowed = await _request_as(
        db_session,
        workspace_admin,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["permissions"]["my_role"] == "workspace_admin"

    denied = await _request_as(
        db_session,
        regular_member,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_channel_profile_requires_channel_membership(db_session: AsyncSession) -> None:
    user = User(user_id="u-perm-profile-user", username="perm_profile_user", password_hash="x", role="member")
    ws = Workspace(workspace_id="w-perm-profile", name="Profile WS")
    ch = Channel(channel_id="c-perm-profile", workspace_id=ws.workspace_id, name="profile", type="private")
    db_session.add_all([
        user,
        ws,
        ch,
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=user.user_id, role="member"),
    ])
    await db_session.commit()

    get_resp = await _request_as(db_session, user, "GET", f"/api/v1/channels/{ch.channel_id}/my-profile")
    assert get_resp.status_code == 403

    put_resp = await _request_as(
        db_session,
        user,
        "PUT",
        f"/api/v1/channels/{ch.channel_id}/my-profile",
        json={"nickname": "ghost"},
    )
    assert put_resp.status_code == 403


@pytest.mark.asyncio
async def test_member_invites_default_to_all_members_and_can_be_restricted(db_session: AsyncSession) -> None:
    admin = User(user_id="u-perm-member-admin", username="perm_member_admin", password_hash="x", role="member")
    member = User(user_id="u-perm-member-user", username="perm_member_user", password_hash="x", role="member")
    target = User(user_id="u-perm-member-target", username="perm_member_target", password_hash="x", role="member")
    restricted_target = User(
        user_id="u-perm-member-restricted-target",
        username="perm_member_restricted_target",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-member", name="Perm Member WS")
    ch = Channel(channel_id="c-perm-member", workspace_id=ws.workspace_id, name="member-guarded", type="public")
    db_session.add_all([
        admin,
        member,
        target,
        restricted_target,
        ws,
        ch,
        ChannelMembership(channel_id=ch.channel_id, member_id=admin.user_id, member_type="user", role="admin"),
        ChannelMembership(channel_id=ch.channel_id, member_id=member.user_id, member_type="user", role="member"),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=target.user_id, role="member"),
        WorkspaceMembership(workspace_id=ws.workspace_id, user_id=restricted_target.user_id, role="member"),
    ])
    await db_session.commit()

    settings = await _request_as(
        db_session,
        member,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert settings.status_code == 200
    assert settings.json()["data"]["permissions"]["can_invite_members"] is True

    allowed_member = await _request_as(
        db_session,
        member,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": target.user_id, "member_type": "user"},
    )
    assert allowed_member.status_code == 200
    assert allowed_member.json()["data"]["role"] == "member"

    ch.allow_member_invites = False
    await db_session.flush()

    restricted_settings = await _request_as(
        db_session,
        member,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert restricted_settings.status_code == 200
    assert restricted_settings.json()["data"]["permissions"]["can_invite_members"] is False

    denied = await _request_as(
        db_session,
        member,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": restricted_target.user_id, "member_type": "user"},
    )
    assert denied.status_code == 403

    allowed = await _request_as(
        db_session,
        admin,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": restricted_target.user_id, "member_type": "user"},
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["role"] == "member"


@pytest.mark.asyncio
async def test_dm_rejects_member_and_bot_adds(db_session: AsyncSession) -> None:
    owner = User(
        user_id="u-perm-dm-owner",
        username="perm_dm_owner",
        password_hash="x",
        role="system_admin",
    )
    peer = User(
        user_id="u-perm-dm-peer",
        username="perm_dm_peer",
        password_hash="x",
        role="member",
    )
    target = User(
        user_id="u-perm-dm-target",
        username="perm_dm_target",
        password_hash="x",
        role="member",
    )
    bot = BotAccount(
        bot_id="bot-perm-dm-target",
        username="perm_dm_target_bot",
        display_name="DM Target Bot",
        scope="everyone",
    )
    ws = Workspace(workspace_id="w-perm-dm", name="Perm DM WS")
    dm = Channel(
        channel_id="c-perm-dm",
        workspace_id=ws.workspace_id,
        name="dm:u-perm-dm-owner:u-perm-dm-peer",
        type="dm",
        allow_member_invites=True,
        allow_bot_adds=True,
    )
    db_session.add_all([
        owner,
        peer,
        target,
        bot,
        ws,
        dm,
        ChannelMembership(channel_id=dm.channel_id, member_id=owner.user_id, member_type="user"),
        ChannelMembership(channel_id=dm.channel_id, member_id=peer.user_id, member_type="user"),
    ])
    await db_session.commit()

    settings = await _request_as(
        db_session,
        owner,
        "GET",
        f"/api/v1/channels/{dm.channel_id}/settings",
    )
    assert settings.status_code == 200
    assert settings.json()["data"]["permissions"]["can_invite_members"] is False
    assert settings.json()["data"]["permissions"]["can_add_bots"] is False

    add_user = await _request_as(
        db_session,
        owner,
        "POST",
        f"/api/v1/channels/{dm.channel_id}/members",
        json={"member_id": target.user_id, "member_type": "user"},
    )
    assert add_user.status_code == 400
    assert "私信" in add_user.json()["detail"]

    add_bot = await _request_as(
        db_session,
        owner,
        "POST",
        f"/api/v1/channels/{dm.channel_id}/members",
        json={"member_id": bot.bot_id, "member_type": "bot"},
    )
    assert add_bot.status_code == 400
    assert "私信" in add_bot.json()["detail"]

    invite_by_name = await _request_as(
        db_session,
        owner,
        "POST",
        f"/api/v1/channels/{dm.channel_id}/invite",
        json={"identifier": target.username},
    )
    assert invite_by_name.status_code == 400
    assert "私信" in invite_by_name.json()["detail"]

    friends_to_invite = await _request_as(
        db_session,
        owner,
        "GET",
        f"/api/v1/channels/{dm.channel_id}/friends-to-invite",
    )
    assert friends_to_invite.status_code == 400
    assert "私信" in friends_to_invite.json()["detail"]


@pytest.mark.asyncio
async def test_bot_adds_default_to_all_members_and_can_be_restricted(db_session: AsyncSession) -> None:
    admin = User(user_id="u-perm-bot-admin", username="perm_bot_admin", password_hash="x", role="member")
    member = User(user_id="u-perm-bot-member", username="perm_bot_member", password_hash="x", role="member")
    ws = Workspace(workspace_id="w-perm-bot-add", name="Perm Bot Add WS")
    ch = Channel(channel_id="c-perm-bot-add", workspace_id=ws.workspace_id, name="bot-add", type="public")
    allowed_bot = BotAccount(
        bot_id="bot-perm-add-allowed",
        username="perm_add_allowed_bot",
        display_name="Allowed Bot",
        created_by=admin.user_id,
        scope="everyone",
    )
    restricted_bot = BotAccount(
        bot_id="bot-perm-add-restricted",
        username="perm_add_restricted_bot",
        display_name="Restricted Bot",
        created_by=admin.user_id,
        scope="everyone",
    )
    db_session.add_all([
        admin,
        member,
        ws,
        ch,
        allowed_bot,
        restricted_bot,
        ChannelMembership(channel_id=ch.channel_id, member_id=admin.user_id, member_type="user", role="admin"),
        ChannelMembership(channel_id=ch.channel_id, member_id=member.user_id, member_type="user", role="member"),
    ])
    await db_session.commit()

    settings = await _request_as(
        db_session,
        member,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert settings.status_code == 200
    assert settings.json()["data"]["permissions"]["can_add_bots"] is True

    allowed_member = await _request_as(
        db_session,
        member,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": allowed_bot.bot_id, "member_type": "bot"},
    )
    assert allowed_member.status_code == 200

    ch.allow_bot_adds = False
    await db_session.flush()

    restricted_settings = await _request_as(
        db_session,
        member,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert restricted_settings.status_code == 200
    assert restricted_settings.json()["data"]["permissions"]["can_add_bots"] is False

    denied = await _request_as(
        db_session,
        member,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": restricted_bot.bot_id, "member_type": "bot"},
    )
    assert denied.status_code == 403

    allowed_admin = await _request_as(
        db_session,
        admin,
        "POST",
        f"/api/v1/channels/{ch.channel_id}/members",
        json={"member_id": restricted_bot.bot_id, "member_type": "bot"},
    )
    assert allowed_admin.status_code == 200


@pytest.mark.asyncio
async def test_bot_channel_template_override_belongs_to_inviter(db_session: AsyncSession) -> None:
    bot_owner = User(user_id="u-perm-bot-owner", username="perm_bot_owner", password_hash="x", role="member")
    inviter = User(user_id="u-perm-bot-inviter", username="perm_bot_inviter", password_hash="x", role="member")
    channel_admin = User(
        user_id="u-perm-channel-admin",
        username="perm_channel_admin",
        password_hash="x",
        role="member",
    )
    ws = Workspace(workspace_id="w-perm-bot-template", name="Perm Bot Template WS")
    ch = Channel(
        channel_id="c-perm-bot-template",
        workspace_id=ws.workspace_id,
        name="bot-template-guarded",
        type="public",
    )
    bot = BotAccount(
        bot_id="bot-perm-template",
        username="perm_template_bot",
        display_name="Template Bot",
        created_by=bot_owner.user_id,
    )
    template = PromptTemplate(
        template_id="tpl-perm-bot-inviter",
        name="perm-bot-inviter-template",
        system_prompt="inviter system",
        user_template="{{message}}",
        created_by=inviter.user_id,
    )
    db_session.add_all([
        bot_owner,
        inviter,
        channel_admin,
        ws,
        ch,
        bot,
        ChannelMembership(channel_id=ch.channel_id, member_id=bot_owner.user_id, member_type="user", role="member"),
        ChannelMembership(channel_id=ch.channel_id, member_id=inviter.user_id, member_type="user", role="member"),
        ChannelMembership(channel_id=ch.channel_id, member_id=channel_admin.user_id, member_type="user", role="admin"),
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
            added_by=inviter.user_id,
        ),
    ])
    await db_session.flush()
    db_session.add(template)
    await db_session.commit()

    owner_settings = await _request_as(
        db_session,
        bot_owner,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert owner_settings.status_code == 200
    owner_bot_member = next(
        item for item in owner_settings.json()["data"]["members"] if item["member_id"] == bot.bot_id
    )
    assert owner_bot_member["can_manage_template"] is False

    inviter_settings = await _request_as(
        db_session,
        inviter,
        "GET",
        f"/api/v1/channels/{ch.channel_id}/settings",
    )
    assert inviter_settings.status_code == 200
    inviter_bot_member = next(
        item for item in inviter_settings.json()["data"]["members"] if item["member_id"] == bot.bot_id
    )
    assert inviter_bot_member["can_manage_template"] is True
    assert inviter_bot_member["inviter"]["user_id"] == inviter.user_id

    denied = await _request_as(
        db_session,
        channel_admin,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": template.template_id},
    )
    assert denied.status_code == 403

    denied_owner = await _request_as(
        db_session,
        bot_owner,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": template.template_id},
    )
    assert denied_owner.status_code == 403

    allowed = await _request_as(
        db_session,
        inviter,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": template.template_id},
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["template_id"] == template.template_id
