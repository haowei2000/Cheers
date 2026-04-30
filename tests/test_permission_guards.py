"""Permission guard tests for channel/workspace scoped reads."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.core.exceptions import ForbiddenError
from app.db.models import BotAccount, Channel, ChannelMembership, PromptTemplate, User, Workspace
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
async def test_bot_channel_template_override_belongs_to_bot_owner(db_session: AsyncSession) -> None:
    bot_owner = User(user_id="u-perm-bot-owner", username="perm_bot_owner", password_hash="x", role="member")
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
        template_id="tpl-perm-bot-owner",
        name="perm-bot-owner-template",
        system_prompt="owner system",
        user_template="{{message}}",
        created_by=bot_owner.user_id,
    )
    db_session.add_all([
        bot_owner,
        channel_admin,
        ws,
        ch,
        bot,
        ChannelMembership(channel_id=ch.channel_id, member_id=bot_owner.user_id, member_type="user", role="member"),
        ChannelMembership(channel_id=ch.channel_id, member_id=channel_admin.user_id, member_type="user", role="admin"),
        ChannelMembership(channel_id=ch.channel_id, member_id=bot.bot_id, member_type="bot"),
    ])
    await db_session.flush()
    db_session.add(template)
    await db_session.commit()

    denied = await _request_as(
        db_session,
        channel_admin,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": template.template_id},
    )
    assert denied.status_code == 403

    allowed = await _request_as(
        db_session,
        bot_owner,
        "PATCH",
        f"/api/v1/channels/{ch.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": template.template_id},
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["template_id"] == template.template_id
