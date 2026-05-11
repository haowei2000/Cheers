"""Bot model/template binding update API."""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AIModel,
    AgentNexusSession,
    AgentNexusSessionBinding,
    BotAccount,
    Channel,
    ChannelMembership,
    PromptTemplate,
    Workspace,
)
from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"


def _model(model_id: str, name: str) -> AIModel:
    return AIModel(
        model_id=model_id,
        name=name,
        provider="openai",
        model_name=f"{model_id}-provider",
        base_url="http://llm.test/v1",
        is_enabled=True,
        is_builtin=False,
        is_public=True,
        config={},
        created_by=TEST_USER_ID,
    )


def _template(template_id: str, name: str) -> PromptTemplate:
    return PromptTemplate(
        template_id=template_id,
        name=name,
        system_prompt="system",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
        created_by=TEST_USER_ID,
    )


@pytest.mark.asyncio
async def test_bot_list_and_update_exposes_http_model_template_binding(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    model_one = _model("binding-model-0001", "Binding Model One")
    model_two = _model("binding-model-0002", "Binding Model Two")
    template_one = _template("binding-template-0001", "Binding Template One")
    template_two = _template("binding-template-0002", "Binding Template Two")
    bot = BotAccount(
        bot_id="binding-bot-0001",
        username="binding_bot",
        display_name="Binding Bot",
        avatar_url="https://cdn.example.test/binding.png",
        model_id=model_one.model_id,
        template_id=template_one.template_id,
        status="online",
        binding_type="http",
        created_by=TEST_USER_ID,
    )
    db_session.add_all([model_one, model_two, template_one, template_two, bot])
    await db_session.flush()

    list_resp = await client.get("/api/v1/bots")
    assert list_resp.status_code == 200
    listed = next(item for item in list_resp.json()["data"] if item["bot_id"] == bot.bot_id)
    assert listed["model_id"] == model_one.model_id
    assert listed["template_id"] == template_one.template_id
    assert listed["avatar_url"] == "https://cdn.example.test/binding.png"

    update_resp = await client.put(
        f"/api/v1/bots/{bot.bot_id}",
        json={
            "display_name": "Binding Bot Updated",
            "avatar_url": "https://cdn.example.test/binding-updated.png",
            "model_id": model_two.model_id,
            "template_id": template_two.template_id,
        },
    )

    assert update_resp.status_code == 200
    updated = update_resp.json()["data"]
    assert updated["display_name"] == "Binding Bot Updated"
    assert updated["avatar_url"] == "https://cdn.example.test/binding-updated.png"
    assert updated["model_id"] == model_two.model_id
    assert updated["template_id"] == template_two.template_id
    assert updated["model_name"] == model_two.name
    assert updated["template_name"] == template_two.name

    clear_resp = await client.put(
        f"/api/v1/bots/{bot.bot_id}",
        json={"avatar_url": None},
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["data"]["avatar_url"] is None


@pytest.mark.asyncio
async def test_system_admin_can_list_and_rebind_builtin_bot(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    model_one = _model("builtin-model-0001", "Builtin Model One")
    model_two = _model("builtin-model-0002", "Builtin Model Two")
    template_one = _template("builtin-template-0001", "Builtin Template One")
    template_two = _template("builtin-template-0002", "Builtin Template Two")
    db_session.add_all([model_one, model_two, template_one, template_two])
    bot = await db_session.get(BotAccount, HELPER_BOT_ID)
    if bot is None:
        bot = BotAccount(
            bot_id=HELPER_BOT_ID,
            username="Coordinator",
            display_name="协调者",
            created_by=None,
        )
        db_session.add(bot)
    bot.username = "Coordinator"
    bot.display_name = "协调者"
    bot.model_id = model_one.model_id
    bot.template_id = template_one.template_id
    bot.status = "online"
    bot.binding_type = "http"
    await db_session.flush()

    list_resp = await client.get("/api/v1/bots")
    assert list_resp.status_code == 200
    listed = next(item for item in list_resp.json()["data"] if item["bot_id"] == HELPER_BOT_ID)
    assert listed["is_builtin"] is True
    assert listed["model_id"] == model_one.model_id
    assert listed["template_id"] == template_one.template_id

    update_resp = await client.put(
        f"/api/v1/bots/{HELPER_BOT_ID}",
        json={
            "model_id": model_two.model_id,
            "template_id": template_two.template_id,
        },
    )

    assert update_resp.status_code == 200
    updated = update_resp.json()["data"]
    assert updated["is_builtin"] is True
    assert updated["model_id"] == model_two.model_id
    assert updated["template_id"] == template_two.template_id
    assert updated["model_name"] == model_two.name
    assert updated["template_name"] == template_two.name

    delete_resp = await client.delete(f"/api/v1/bots/{HELPER_BOT_ID}")
    assert delete_resp.status_code == 400


@pytest.mark.asyncio
async def test_create_bot_persists_avatar_url(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    model = _model("avatar-model-0001", "Avatar Model")
    template = _template("avatar-template-0001", "Avatar Template")
    db_session.add_all([model, template])
    await db_session.flush()

    create_resp = await client.post(
        "/api/v1/bots",
        json={
            "username": "avatar_bot",
            "display_name": "Avatar Bot",
            "model_id": model.model_id,
            "template_id": template.template_id,
            "avatar_url": "https://cdn.example.test/avatar-bot.png",
            "binding_type": "http",
        },
    )

    assert create_resp.status_code == 200
    created = create_resp.json()["data"]
    assert created["avatar_url"] == "https://cdn.example.test/avatar-bot.png"

    list_resp = await client.get("/api/v1/bots")
    assert list_resp.status_code == 200
    listed = next(item for item in list_resp.json()["data"] if item["bot_id"] == created["bot_id"])
    assert listed["avatar_url"] == "https://cdn.example.test/avatar-bot.png"


@pytest.mark.asyncio
async def test_delete_bot_removes_agentnexus_sessions_and_memberships(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot = BotAccount(
        bot_id="delete-session-bot-0001",
        username="delete_session_bot",
        display_name="Delete Session Bot",
        binding_type="agent_bridge",
        created_by=TEST_USER_ID,
    )
    workspace = Workspace(workspace_id="delete-session-ws-0001", name="Delete Session WS")
    channel = Channel(
        channel_id="delete-session-ch-0001",
        workspace_id=workspace.workspace_id,
        name="delete-session",
        type="public",
    )
    session = AgentNexusSession(
        session_id="delete-session-sess-0001",
        bot_id=bot.bot_id,
        provider="generic",
        provider_account_id="acct-delete-session",
        provider_agent_id="agent-main",
        provider_session_key="provider:generic:account:acct-delete-session:session:delete-session-sess-0001",
        current_scope_type="channel",
        current_scope_id=channel.channel_id,
    )
    binding = AgentNexusSessionBinding(
        binding_id="delete-session-bind-0001",
        session_id=session.session_id,
        bot_id=bot.bot_id,
        provider="generic",
        provider_account_id=session.provider_account_id,
        provider_agent_id=session.provider_agent_id,
        scope_type="channel",
        scope_id=channel.channel_id,
        channel_id=channel.channel_id,
        role="primary",
    )
    membership = ChannelMembership(
        channel_id=channel.channel_id,
        member_id=bot.bot_id,
        member_type="bot",
    )
    db_session.add_all([workspace, channel, bot, session, binding, membership])
    await db_session.flush()

    resp = await client.delete(f"/api/v1/bots/{bot.bot_id}")

    assert resp.status_code == 200
    assert await db_session.get(BotAccount, bot.bot_id) is None
    assert await db_session.get(AgentNexusSession, session.session_id) is None
    assert await db_session.get(AgentNexusSessionBinding, binding.binding_id) is None
    memberships = await db_session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel.channel_id,
            ChannelMembership.member_id == bot.bot_id,
        )
    )
    assert memberships.scalar_one_or_none() is None
