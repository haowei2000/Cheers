"""Prompt template tags, default Bot metadata, and routing."""
from __future__ import annotations

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.db.models import BotAccount, Channel, ChannelMembership, PromptTemplate, User, Workspace
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


def _user(user_id: str, username: str, role: str = "member") -> User:
    return User(user_id=user_id, username=username, password_hash="x", role=role)


def _bot(bot_id: str, username: str, owner: User, scope: str = "everyone") -> BotAccount:
    return BotAccount(
        bot_id=bot_id,
        username=username,
        display_name=username.replace("_", " ").title(),
        status="online",
        scope=scope,
        binding_type="agent_bridge",
        created_by=owner.user_id,
    )


def _template(
    template_id: str,
    name: str,
    owner: User,
    *,
    scope: str = "everyone",
    default_bot_id: str | None = None,
) -> PromptTemplate:
    return PromptTemplate(
        template_id=template_id,
        name=name,
        description=f"{name} description",
        system_prompt="system",
        user_template="{{message}}",
        variables=["message"],
        tags=[],
        default_bot_id=default_bot_id,
        scope=scope,
        created_by=owner.user_id,
    )


async def _seed_channel(
    db_session: AsyncSession,
    user: User,
    *,
    channel_id: str,
    bots: list[BotAccount] | None = None,
) -> Channel:
    workspace = Workspace(workspace_id=f"ws-{channel_id}", name=f"Workspace {channel_id}")
    channel = Channel(channel_id=channel_id, workspace_id=workspace.workspace_id, name=f"Channel {channel_id}")
    memberships = [
        ChannelMembership(channel_id=channel.channel_id, member_id=user.user_id, member_type="user", role="owner")
    ]
    for bot in bots or []:
        memberships.append(
            ChannelMembership(
                channel_id=channel.channel_id,
                member_id=bot.bot_id,
                member_type="bot",
                added_by=user.user_id,
            )
        )
    db_session.add_all([workspace, channel, *memberships])
    await db_session.flush()
    return channel


@pytest.mark.asyncio
async def test_template_create_update_lists_tags_and_default_bot(db_session: AsyncSession) -> None:
    owner = _user("tmpl-default-owner", "tmpl_default_owner")
    bot = _bot("tmpl-default-bot", "default_bot", owner)
    db_session.add_all([owner, bot])
    await db_session.flush()

    create_resp = await _request_as(
        db_session,
        owner,
        "POST",
        "/api/v1/templates",
        json={
            "name": "Tagged Default Template",
            "description": "template description",
            "system_prompt": "system",
            "user_template": "{{message}}",
            "variables": ["message"],
            "tags": ["Ops", " ops ", "", "Planning"],
            "default_bot_id": bot.bot_id,
            "scope": "everyone",
        },
    )
    assert create_resp.status_code == 200
    created = create_resp.json()["data"]
    assert created["tags"] == ["Ops", "Planning"]
    assert created["default_bot_id"] == bot.bot_id
    assert created["default_bot"]["username"] == bot.username

    update_resp = await _request_as(
        db_session,
        owner,
        "PATCH",
        f"/api/v1/templates/{created['template_id']}",
        json={"tags": ["Analysis", "analysis"], "default_bot_id": None},
    )
    assert update_resp.status_code == 200
    updated = update_resp.json()["data"]
    assert updated["tags"] == ["Analysis"]
    assert updated["default_bot_id"] is None
    assert updated["default_bot"] is None


@pytest.mark.asyncio
async def test_template_default_bot_binding_requires_visible_bot(db_session: AsyncSession) -> None:
    owner = _user("tmpl-default-owner-private", "tmpl_default_owner_private")
    stranger = _user("tmpl-default-stranger-private", "tmpl_default_stranger_private")
    bot = _bot("tmpl-private-default-bot", "private_default_bot", owner, scope="private")
    db_session.add_all([owner, stranger, bot])
    await db_session.flush()

    denied = await _request_as(
        db_session,
        stranger,
        "POST",
        "/api/v1/templates",
        json={
            "name": "Denied Default Bot Template",
            "system_prompt": "system",
            "user_template": "{{message}}",
            "default_bot_id": bot.bot_id,
        },
    )
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_template_response_hides_inaccessible_default_bot(db_session: AsyncSession) -> None:
    owner = _user("tmpl-default-owner-hide", "tmpl_default_owner_hide")
    stranger = _user("tmpl-default-stranger-hide", "tmpl_default_stranger_hide")
    bot = _bot("tmpl-hidden-default-bot", "hidden_default_bot", owner, scope="private")
    db_session.add_all([owner, stranger, bot])
    await db_session.flush()

    template = _template(
        "tmpl-hidden-default-template",
        "Hidden Default Template",
        owner,
        scope="everyone",
        default_bot_id=bot.bot_id,
    )
    db_session.add(template)
    await db_session.flush()

    owner_resp = await _request_as(db_session, owner, "GET", f"/api/v1/templates/{template.template_id}")
    assert owner_resp.status_code == 200
    assert owner_resp.json()["data"]["default_bot_id"] == bot.bot_id

    stranger_resp = await _request_as(db_session, stranger, "GET", f"/api/v1/templates/{template.template_id}")
    assert stranger_resp.status_code == 200
    assert stranger_resp.json()["data"]["default_bot_id"] is None
    assert stranger_resp.json()["data"]["default_bot"] is None


@pytest.mark.asyncio
async def test_deleting_bot_clears_template_default_bot(db_session: AsyncSession) -> None:
    owner = _user("tmpl-default-owner-delete", "tmpl_default_owner_delete")
    bot = _bot("tmpl-delete-default-bot", "delete_default_bot", owner)
    db_session.add_all([owner, bot])
    await db_session.flush()

    template = _template(
        "tmpl-delete-default-template",
        "Delete Default Template",
        owner,
        default_bot_id=bot.bot_id,
    )
    db_session.add(template)
    await db_session.flush()

    resp = await _request_as(db_session, owner, "DELETE", f"/api/v1/bots/{bot.bot_id}")
    assert resp.status_code == 200
    await db_session.refresh(template)
    assert template.default_bot_id is None


@pytest.mark.asyncio
async def test_selected_template_default_bot_auto_routes_when_no_explicit_target(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = _user("tmpl-default-owner-route", "tmpl_default_owner_route")
    bot = _bot("tmpl-route-default-bot", "route_default_bot", owner)
    db_session.add_all([owner, bot])
    await db_session.flush()

    template = _template(
        "tmpl-route-default-template",
        "Route Default Template",
        owner,
        default_bot_id=bot.bot_id,
    )
    db_session.add(template)
    channel = await _seed_channel(db_session, owner, channel_id="tmpl-default-route-channel", bots=[bot])
    await db_session.flush()
    monkeypatch.setattr(
        "app.api.v1.messages.routes.enqueue_bot_pipeline_job",
        AsyncMock(return_value="job-default-route"),
    )

    resp = await _request_as(
        db_session,
        owner,
        "POST",
        f"/api/v1/channels/{channel.channel_id}/messages",
        json={
            "content": "Please handle this",
            "sender_id": owner.user_id,
            "sender_type": "user",
            "msg_type": "normal",
            "content_data": {"prompt_template_override_id": template.template_id},
        },
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["mention_bot_ids"] == [bot.bot_id]


@pytest.mark.asyncio
async def test_explicit_bot_target_prevents_template_default_bot_routing(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = _user("tmpl-default-owner-explicit", "tmpl_default_owner_explicit")
    default_bot = _bot("tmpl-explicit-default-bot", "explicit_default_bot", owner)
    other_bot = _bot("tmpl-explicit-other-bot", "explicit_other_bot", owner)
    db_session.add_all([owner, default_bot, other_bot])
    await db_session.flush()

    template = _template(
        "tmpl-explicit-default-template",
        "Explicit Default Template",
        owner,
        default_bot_id=default_bot.bot_id,
    )
    db_session.add(template)
    channel = await _seed_channel(
        db_session,
        owner,
        channel_id="tmpl-default-explicit-channel",
        bots=[default_bot, other_bot],
    )
    await db_session.flush()
    monkeypatch.setattr(
        "app.api.v1.messages.routes.enqueue_bot_pipeline_job",
        AsyncMock(return_value="job-explicit-route"),
    )

    resp = await _request_as(
        db_session,
        owner,
        "POST",
        f"/api/v1/channels/{channel.channel_id}/messages",
        json={
            "content": "Please handle this",
            "sender_id": owner.user_id,
            "sender_type": "user",
            "mention_bot_ids": [other_bot.bot_id],
            "msg_type": "normal",
            "content_data": {"prompt_template_override_id": template.template_id},
        },
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["mention_bot_ids"] == [other_bot.bot_id]


@pytest.mark.asyncio
async def test_template_default_bot_outside_channel_blocks_send(db_session: AsyncSession) -> None:
    owner = _user("tmpl-default-owner-missing", "tmpl_default_owner_missing")
    bot = _bot("tmpl-missing-default-bot", "missing_default_bot", owner)
    db_session.add_all([owner, bot])
    await db_session.flush()

    template = _template(
        "tmpl-missing-default-template",
        "Missing Default Template",
        owner,
        default_bot_id=bot.bot_id,
    )
    db_session.add(template)
    channel = await _seed_channel(db_session, owner, channel_id="tmpl-default-missing-channel", bots=[])
    await db_session.flush()

    resp = await _request_as(
        db_session,
        owner,
        "POST",
        f"/api/v1/channels/{channel.channel_id}/messages",
        json={
            "content": "Please handle this",
            "sender_id": owner.user_id,
            "sender_type": "user",
            "msg_type": "normal",
            "content_data": {"prompt_template_override_id": template.template_id},
        },
    )
    assert resp.status_code == 400
    assert "Add default Bot" in resp.text
