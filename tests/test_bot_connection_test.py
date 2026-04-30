"""Bot realtime connectivity test API."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AIModel, BotAccount, PromptTemplate
from app.services.guide.constants import GUIDE_BOT_ID


@pytest.mark.asyncio
async def test_http_bot_connection_test_calls_real_health_check(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    model = AIModel(
        model_id="conn-model-0001",
        name="Conn Model",
        provider="openai",
        model_name="gpt-test",
        base_url="http://llm.test/v1",
        is_enabled=True,
        is_builtin=False,
        config={},
    )
    template = PromptTemplate(
        template_id="conn-template-0001",
        name="Conn Template",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )
    bot = BotAccount(
        bot_id="conn-bot-0001",
        username="conn_bot_http",
        model_id=model.model_id,
        template_id=template.template_id,
        status="online",
        created_by="someone-else",
    )
    db_session.add_all([model, template, bot])
    await db_session.commit()

    health = AsyncMock(return_value=True)
    with patch("app.api.v1.bots.routes.HttpBotAdapter.health_check", health):
        resp = await client.post(f"/api/v1/bots/{bot.bot_id}/connection-test")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["reachable"] is True
    assert data["binding_type"] == "http"
    assert data["message"] == "HTTP 模型 API 连通测试成功"
    health.assert_awaited_once()


@pytest.mark.asyncio
async def test_http_bot_online_status_uses_live_health_check(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    model = AIModel(
        model_id="status-model-0001",
        name="Status Model",
        provider="openai",
        model_name="gpt-test",
        base_url="http://llm.test/v1",
        is_enabled=True,
        is_builtin=False,
        config={},
    )
    template = PromptTemplate(
        template_id="status-template-0001",
        name="Status Template",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )
    bot = BotAccount(
        bot_id="status-bot-0001",
        username="status_bot_http",
        model_id=model.model_id,
        template_id=template.template_id,
        status="online",
        created_by="someone-else",
    )
    db_session.add_all([model, template, bot])
    await db_session.commit()

    health = AsyncMock(return_value=False)
    with patch("app.api.v1.bots.routes.HttpBotAdapter.health_check", health):
        resp = await client.get(f"/api/v1/bots/{bot.bot_id}/online-status")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["binding_type"] == "http"
    assert data["connection_status"] == "offline"
    assert data["is_online"] is False
    assert data["reachable"] is False
    assert data["checked_at"]
    health.assert_awaited_once()


@pytest.mark.asyncio
async def test_builtin_bot_connection_test_uses_builtin_adapter(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot = BotAccount(
        bot_id=GUIDE_BOT_ID,
        username="Coordinator",
        status="online",
        binding_type="http",
        created_by="someone-else",
    )
    db_session.add(bot)
    await db_session.flush()

    class FakeBuiltinAdapter:
        async def health_check(self) -> bool:
            return False

    with patch("app.api.v1.bots.routes.get_builtin_adapter", return_value=FakeBuiltinAdapter()):
        resp = await client.post(f"/api/v1/bots/{bot.bot_id}/connection-test")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["reachable"] is True
    assert data["connection_status"] == "online"
    assert data["dependency_ready"] is False
    assert data["adapter"] == "FakeBuiltinAdapter"
    assert "内置 Bot 可接收消息" in data["message"]


@pytest.mark.asyncio
async def test_websocket_bot_connection_test_reports_registry_state(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot = BotAccount(
        bot_id="conn-bot-0002",
        username="conn_bot_ws",
        status="online",
        binding_type="websocket",
        created_by="someone-else",
    )
    db_session.add(bot)
    await db_session.commit()

    resp = await client.post(f"/api/v1/bots/{bot.bot_id}/connection-test")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["reachable"] is False
    assert data["binding_type"] == "websocket"
    assert data["connection_status"] == "offline"
    assert data["message"] == "WebSocket Bot 未完整连接"
