"""Prompt template scope visibility and usage guards."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.db.models import (
    AIModel,
    BotAccount,
    Channel,
    ChannelMembership,
    Friendship,
    Message,
    PromptTemplate,
    User,
    Workspace,
)
from app.db.session import get_session as get_session_db
from app.features.bot_runtime.pipeline.bot.context import BotRunContext
from app.features.bot_runtime.pipeline.bus import NullEventBus
from app.features.bot_runtime.pipeline.workflow import BotWorkflowBuilder
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


async def _seed_users(db_session: AsyncSession, suffix: str) -> dict[str, User]:
    owner = User(user_id=f"tmpl-owner-{suffix}", username=f"tmpl_owner_{suffix}", password_hash="x")
    friend = User(user_id=f"tmpl-friend-{suffix}", username=f"tmpl_friend_{suffix}", password_hash="x")
    stranger = User(user_id=f"tmpl-stranger-{suffix}", username=f"tmpl_stranger_{suffix}", password_hash="x")
    db_session.add_all(
        [
            owner,
            friend,
            stranger,
            Friendship(user_id=owner.user_id, friend_id=friend.user_id, status="accepted"),
        ]
    )
    await db_session.flush()
    return {"owner": owner, "friend": friend, "stranger": stranger}


def _template(template_id: str, name: str, owner: User, scope: str) -> PromptTemplate:
    return PromptTemplate(
        template_id=template_id,
        name=name,
        system_prompt=f"{name} system",
        user_template=f"{name} {{{{message}}}}",
        variables=["message"],
        is_builtin=False,
        created_by=owner.user_id,
        scope=scope,
    )


def _template_ids(resp: Response) -> set[str]:
    return {item["template_id"] for item in resp.json()["data"]}


@pytest.mark.asyncio
async def test_template_scope_filters_list_and_detail(db_session: AsyncSession) -> None:
    users = await _seed_users(db_session, "list")
    owner = users["owner"]
    friend = users["friend"]
    stranger = users["stranger"]
    private_template = _template("tmpl-private-list", "Template Private List", owner, "private")
    friend_template = _template("tmpl-friend-list", "Template Friend List", owner, "friend")
    everyone_template = _template("tmpl-everyone-list", "Template Everyone List", owner, "everyone")
    db_session.add_all([private_template, friend_template, everyone_template])
    await db_session.flush()

    owner_list = await _request_as(db_session, owner, "GET", "/api/v1/templates")
    friend_list = await _request_as(db_session, friend, "GET", "/api/v1/templates")
    stranger_list = await _request_as(db_session, stranger, "GET", "/api/v1/templates")

    assert owner_list.status_code == 200
    assert _template_ids(owner_list) >= {
        private_template.template_id,
        friend_template.template_id,
        everyone_template.template_id,
    }
    assert _template_ids(friend_list) >= {friend_template.template_id, everyone_template.template_id}
    assert private_template.template_id not in _template_ids(friend_list)
    assert _template_ids(stranger_list) >= {everyone_template.template_id}
    assert friend_template.template_id not in _template_ids(stranger_list)
    assert private_template.template_id not in _template_ids(stranger_list)

    listed = next(item for item in owner_list.json()["data"] if item["template_id"] == friend_template.template_id)
    assert listed["scope"] == "friend"
    assert listed["owner"]["user_id"] == owner.user_id
    assert listed["can_manage"] is True

    denied_detail = await _request_as(
        db_session,
        stranger,
        "GET",
        f"/api/v1/templates/{friend_template.template_id}",
    )
    assert denied_detail.status_code == 404

    friend_detail = await _request_as(
        db_session,
        friend,
        "GET",
        f"/api/v1/templates/{friend_template.template_id}",
    )
    assert friend_detail.status_code == 200
    assert friend_detail.json()["data"]["can_manage"] is False


@pytest.mark.asyncio
async def test_template_scope_create_update_and_edit_guard(db_session: AsyncSession) -> None:
    users = await _seed_users(db_session, "edit")
    owner = users["owner"]
    friend = users["friend"]

    create_resp = await _request_as(
        db_session,
        owner,
        "POST",
        "/api/v1/templates",
        json={
            "name": "Template Scope Created",
            "description": "scope create",
            "system_prompt": "created system",
            "user_template": "{{message}}",
            "variables": ["message"],
            "scope": "private",
        },
    )
    assert create_resp.status_code == 200
    template_id = create_resp.json()["data"]["template_id"]
    created = await db_session.get(PromptTemplate, template_id)
    assert created is not None
    assert created.scope == "private"

    denied_update = await _request_as(
        db_session,
        friend,
        "PATCH",
        f"/api/v1/templates/{template_id}",
        json={"scope": "everyone"},
    )
    assert denied_update.status_code == 403

    owner_update = await _request_as(
        db_session,
        owner,
        "PATCH",
        f"/api/v1/templates/{template_id}",
        json={"scope": "everyone"},
    )
    assert owner_update.status_code == 200
    assert owner_update.json()["data"]["scope"] == "everyone"

    friend_list = await _request_as(db_session, friend, "GET", "/api/v1/templates")
    assert template_id in _template_ids(friend_list)


@pytest.mark.asyncio
async def test_template_scope_guards_bot_binding(db_session: AsyncSession) -> None:
    users = await _seed_users(db_session, "bot-binding")
    owner = users["owner"]
    friend = users["friend"]
    stranger = users["stranger"]
    model = AIModel(
        model_id="tmpl-scope-model-binding",
        name="Template Scope Model Binding",
        provider="openai",
        model_name="test-model",
        base_url="http://llm.test/v1",
        is_enabled=True,
        is_public=True,
        config={},
        created_by=None,
    )
    template = _template("tmpl-private-bot-binding", "Template Private Bot Binding", owner, "private")
    db_session.add_all([model, template])
    await db_session.flush()

    denied = await _request_as(
        db_session,
        stranger,
        "POST",
        "/api/v1/bots",
        json={
            "username": "tmpl_scope_denied_bot",
            "display_name": "Denied Bot",
            "model_id": model.model_id,
            "template_id": template.template_id,
            "binding_type": "http",
        },
    )
    assert denied.status_code == 403

    template.scope = "friend"
    await db_session.flush()
    allowed = await _request_as(
        db_session,
        friend,
        "POST",
        "/api/v1/bots",
        json={
            "username": "tmpl_scope_friend_bot",
            "display_name": "Friend Bot",
            "model_id": model.model_id,
            "template_id": template.template_id,
            "binding_type": "http",
        },
    )
    assert allowed.status_code == 200


@pytest.mark.asyncio
async def test_template_scope_guards_channel_member_override(db_session: AsyncSession) -> None:
    users = await _seed_users(db_session, "channel")
    owner = users["owner"]
    stranger = users["stranger"]
    ws = Workspace(workspace_id="tmpl-scope-ws-channel", name="Template Scope WS")
    channel = Channel(
        channel_id="tmpl-scope-channel",
        workspace_id=ws.workspace_id,
        name="tmpl-scope-channel",
        type="public",
    )
    bot = BotAccount(
        bot_id="tmpl-scope-channel-bot",
        username="tmpl_scope_channel_bot",
        display_name="Template Scope Channel Bot",
        created_by=owner.user_id,
        scope="everyone",
    )
    private_template = _template("tmpl-private-channel", "Template Private Channel", owner, "private")
    everyone_template = _template("tmpl-everyone-channel", "Template Everyone Channel", owner, "everyone")
    db_session.add_all(
        [
            ws,
            channel,
            bot,
            private_template,
            everyone_template,
            ChannelMembership(
                channel_id=channel.channel_id,
                member_id=stranger.user_id,
                member_type="user",
                role="admin",
            ),
            ChannelMembership(
                channel_id=channel.channel_id,
                member_id=bot.bot_id,
                member_type="bot",
                added_by=stranger.user_id,
            ),
        ]
    )
    await db_session.flush()

    denied = await _request_as(
        db_session,
        stranger,
        "PATCH",
        f"/api/v1/channels/{channel.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": private_template.template_id},
    )
    assert denied.status_code == 403

    allowed = await _request_as(
        db_session,
        stranger,
        "PATCH",
        f"/api/v1/channels/{channel.channel_id}/members/{bot.bot_id}/template",
        json={"template_id": everyone_template.template_id},
    )
    assert allowed.status_code == 200
    assert allowed.json()["data"]["template_id"] == everyone_template.template_id


@pytest.mark.asyncio
async def test_message_prompt_template_override_denies_unauthorized_template(db_session: AsyncSession) -> None:
    users = await _seed_users(db_session, "message")
    owner = users["owner"]
    stranger = users["stranger"]
    ws = Workspace(workspace_id="tmpl-scope-ws-message", name="Template Scope Message WS")
    channel = Channel(
        channel_id="tmpl-scope-message-channel",
        workspace_id=ws.workspace_id,
        name="tmpl-scope-message-channel",
        type="public",
    )
    channel_template = PromptTemplate(
        template_id="tmpl-channel-message",
        name="Template Channel Message",
        system_prompt="channel system",
        user_template="channel {{message}}",
        variables=["message"],
        is_builtin=True,
        scope="everyone",
    )
    forced_template = _template("tmpl-private-message", "Template Private Message", owner, "private")
    bot = BotAccount(
        bot_id="tmpl-scope-message-bot",
        username="tmpl_scope_message_bot",
        display_name="Template Scope Message Bot",
        template_id=channel_template.template_id,
        status="online",
        scope="everyone",
    )
    db_session.add_all(
        [
            ws,
            channel,
            channel_template,
            forced_template,
            bot,
            ChannelMembership(
                channel_id=channel.channel_id,
                member_id=stranger.user_id,
                member_type="user",
            ),
            ChannelMembership(
                channel_id=channel.channel_id,
                member_id=bot.bot_id,
                member_type="bot",
                template_id=channel_template.template_id,
            ),
        ]
    )
    await db_session.flush()

    trigger = Message(
        msg_id="tmpl-scope-message-trigger",
        channel_id=channel.channel_id,
        sender_id=stranger.user_id,
        sender_type="user",
        content="@tmpl_scope_message_bot hi",
        content_data={"prompt_template_override_id": forced_template.template_id},
    )
    ctx = BotRunContext(
        channel_id=channel.channel_id,
        bus=NullEventBus(),
        session=db_session,
        trigger_msg=trigger,
        adapter_factory=lambda _bot_id: None,  # type: ignore[return-value]
    )

    rows, overrides = await BotWorkflowBuilder._load_channel_bots(ctx)
    BotWorkflowBuilder._build_bot_templates(ctx, rows, overrides)

    assert overrides[bot.bot_id].template_id == channel_template.template_id
    assert ctx.bot_user_templates_by_username[bot.username] == channel_template.user_template
