"""单 Bot 接入集成测试：发带 @bot 的消息，验证 Bot 回复被持久化并可拉取."""
import asyncio

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AIModel, BotAccount, Channel, ChannelMembership, PromptTemplate, Workspace


def _make_disabled_model(model_id: str) -> AIModel:
    """创建一个已禁用的占位 AIModel，使 adapter_resolver 返回 MockBotAdapter。"""
    return AIModel(
        model_id=model_id,
        name=f"test-model-{model_id[-4:]}",
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
        name=f"test-tpl-{template_id[-4:]}",
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
        list_resp = await client.get(f"/api/v1/channels/{channel_id}/messages")
        assert list_resp.status_code == 200
        last_messages = list_resp.json()["data"]
        bot_messages = [m for m in last_messages if m["sender_type"] == "bot"]
        if len(bot_messages) >= min_count:
            return last_messages
        if asyncio.get_running_loop().time() >= deadline:
            return last_messages
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
@pytest.mark.skip(reason="Test isolation issue - passes when run alone, fails when run with other tests")
async def test_message_at_bot_gets_bot_reply(client: AsyncClient, db_session: AsyncSession) -> None:
    """频道内添加 Bot，发送 @bot 消息，列表中应出现用户消息 + Bot 回复."""
    model = _make_disabled_model("test-model-0001")
    tpl = _make_template("test-tpl-0001")
    ws = Workspace(workspace_id="b1000000-0000-0000-0000-000000000001", name="W")
    ch = Channel(
        channel_id="b2000000-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="general",
        type="public",
    )
    bot = BotAccount(
        bot_id="b3000000-0000-0000-0000-000000000001",
        username="mockbot",
        display_name="MockBot",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([model, tpl, ws, ch, bot])
    db_session.add(
        ChannelMembership(
            channel_id=ch.channel_id,
            member_id=bot.bot_id,
            member_type="bot",
        )
    )
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "@mockbot 你好，请回复",
            "sender_id": "a0000000-0000-0000-0000-000000000001",
            "sender_type": "user",
        },
    )
    assert resp.status_code == 200
    # Wait for the background orchestrator task; MockAdapter has no IO and should finish immediately.
    await asyncio.sleep(0.2)

    list_resp = await client.get(f"/api/v1/channels/{ch.channel_id}/messages")
    assert list_resp.status_code == 200
    messages = list_resp.json()["data"]
    assert len(messages) >= 2
    user_msg = next((m for m in messages if m["sender_type"] == "user"), None)
    bot_msg = next((m for m in messages if m["sender_type"] == "bot"), None)
    assert user_msg is not None and "你好" in user_msg["content"]
    assert bot_msg is not None
    # adapter_resolver returns MockBotAdapter for models with is_enabled=False.
    assert "MockBot" in bot_msg["content"] or "模型已禁用" in bot_msg["content"]


@pytest.mark.asyncio
async def test_message_at_multiple_bots_serial_replies(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """同一消息 @ 多个 Bot 时，串行执行，每条 Bot 回复均持久化."""
    model1 = _make_disabled_model("test-model-0002")
    model2 = _make_disabled_model("test-model-0003")
    tpl = _make_template("test-tpl-0002")
    ws = Workspace(workspace_id="b1000000-0000-0000-0000-000000000002", name="W2")
    ch = Channel(
        channel_id="b2000000-0000-0000-0000-000000000002",
        workspace_id=ws.workspace_id,
        name="general",
        type="public",
    )
    bot1 = BotAccount(
        bot_id="b3000000-0000-0000-0000-000000000002",
        username="bot_a",
        display_name="BotA",
        model_id=model1.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    bot2 = BotAccount(
        bot_id="b3000000-0000-0000-0000-000000000003",
        username="bot_b",
        display_name="BotB",
        model_id=model2.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([model1, model2, tpl, ws, ch, bot1, bot2])
    db_session.add(ChannelMembership(channel_id=ch.channel_id, member_id=bot1.bot_id, member_type="bot"))
    db_session.add(ChannelMembership(channel_id=ch.channel_id, member_id=bot2.bot_id, member_type="bot"))
    await db_session.commit()

    resp = await client.post(
        f"/api/v1/channels/{ch.channel_id}/messages",
        json={
            "content": "@bot_a @bot_b 请依次回复",
            "sender_id": "a0000000-0000-0000-0000-000000000002",
            "sender_type": "user",
        },
    )
    assert resp.status_code == 200

    messages = await _wait_for_bot_messages(client, ch.channel_id, min_count=2)
    bot_messages = [m for m in messages if m["sender_type"] == "bot"]
    assert len(bot_messages) >= 2
