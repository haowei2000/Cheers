"""End-to-end Bot message pipeline tests."""
from __future__ import annotations

import asyncio

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AIModel, BotAccount, Channel, ChannelMembership, PromptTemplate, Workspace
from app.services.orchestrator.queue import stop_orchestrator_workers

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"


def _make_disabled_model(model_id: str) -> AIModel:
    return AIModel(
        model_id=model_id,
        name=f"pipeline-model-{model_id[-4:]}",
        provider="test",
        model_name="test",
        base_url="http://localhost",
        is_enabled=False,
        is_builtin=False,
        config={},
    )


def _make_template(template_id: str) -> PromptTemplate:
    return PromptTemplate(
        template_id=template_id,
        name=f"pipeline-tpl-{template_id[-4:]}",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )


async def _wait_for_bot_messages(
    client: AsyncClient,
    channel_id: str,
    *,
    min_count: int,
    timeout: float = 2.0,
) -> list[dict]:
    deadline = asyncio.get_running_loop().time() + timeout
    last_messages: list[dict] = []
    while True:
        resp = await client.get(f"/api/v1/channels/{channel_id}/messages")
        assert resp.status_code == 200
        last_messages = resp.json()["data"]
        if sum(1 for msg in last_messages if msg["sender_type"] == "bot") >= min_count:
            return last_messages
        if asyncio.get_running_loop().time() >= deadline:
            return last_messages
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_dm_message_to_bot_gets_reply_without_mention(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """DM to a Bot should traverse REST -> ingest -> queue worker -> Bot reply."""
    await stop_orchestrator_workers()
    model = _make_disabled_model("pipeline-model-0001")
    tpl = _make_template("pipeline-tpl-0001")
    ws = Workspace(workspace_id="pipeline-ws-0001", name="Pipeline")
    ch = Channel(
        channel_id="pipeline-ch-0001",
        workspace_id=ws.workspace_id,
        name=f"dm:{TEST_USER_ID}:pipeline-bot-0001",
        type="dm",
    )
    bot = BotAccount(
        bot_id="pipeline-bot-0001",
        username="pipeline_dm_bot",
        display_name="PipelineDMBot",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([model, tpl, ws, ch, bot])
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=TEST_USER_ID,
            member_type="user",
        )
    )
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
        )
    )
    await db_session.commit()

    try:
        resp = await client.post(
            f"/api/v1/channels/{ch.channel_id}/messages",
            json={
                "content": "hello bot, no explicit mention",
                "sender_id": "ignored",
                "sender_type": "user",
            },
        )
        assert resp.status_code == 200

        messages = await _wait_for_bot_messages(client, ch.channel_id, min_count=1)
        user_msg = next((m for m in messages if m["sender_type"] == "user"), None)
        bot_msg = next((m for m in messages if m["sender_type"] == "bot"), None)
        assert user_msg is not None and user_msg["content"] == "hello bot, no explicit mention"
        assert bot_msg is not None
        assert "PipelineDMBot" in bot_msg["content"] or "模型已禁用" in bot_msg["content"]
    finally:
        await stop_orchestrator_workers()
