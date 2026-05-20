"""Tests for Agent Bridge connector control settings."""
from __future__ import annotations

from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.agent_bridge.routes import _record_connector_config_options
from app.db.models import BotAccount
from app.db.session import async_session_factory
from app.features.agent_bridge.registry import bot_session_registry


class _FakeControlWS:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, event: dict) -> None:
        self.sent.append(event)


@pytest.mark.asyncio
async def test_connector_control_update_persists_and_dispatches(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot = BotAccount(
        bot_id="connector-control-bot-001",
        username="connector_control_bot",
        display_name="Connector Control Bot",
        status="online",
        binding_type="agent_bridge",
        binding_config={"agent_id": "codex"},
        created_by="a0000000-0000-0000-0000-000000000099",
    )
    db_session.add(bot)
    await db_session.commit()

    ws = _FakeControlWS()
    await bot_session_registry.bind_control(bot.bot_id, ws)  # type: ignore[arg-type]
    try:
        resp = await client.put(
            f"/api/v1/bots/{bot.bot_id}/connector-control",
            json={
                "settings": {
                    "permissionMode": "allow",
                    "promptTimeoutMs": 900_000,
                    "requestTimeoutMs": 120_000,
                    "cwd": "/tmp/agentnexus-workspace",
                    "model": "gpt-5.5",
                },
            },
        )
    finally:
        await bot_session_registry.unbind_control(bot.bot_id, ws)  # type: ignore[arg-type]

    assert resp.status_code == 200
    payload = resp.json()["data"]
    assert payload["dispatched"] is True
    assert payload["connector_control"]["settings"] == {
        "permissionMode": "allow",
        "promptTimeoutMs": 900_000,
        "requestTimeoutMs": 120_000,
        "cwd": "/tmp/agentnexus-workspace",
        "model": "gpt-5.5",
    }
    assert ws.sent[-1] == {
        "type": "config_update",
        "revision": 1,
        "settings": {
            "permissionMode": "allow",
            "promptTimeoutMs": 900_000,
            "requestTimeoutMs": 120_000,
            "cwd": "/tmp/agentnexus-workspace",
            "model": "gpt-5.5",
        },
        "updated_at": payload["connector_control"]["updated_at"],
    }

    await db_session.refresh(bot)
    assert bot.binding_config["connector_control"]["settings"]["permissionMode"] == "allow"
    assert bot.binding_config["connector_control"]["settings"]["model"] == "gpt-5.5"


@pytest.mark.asyncio
async def test_connector_control_update_requires_agent_bridge_bot(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    bot = BotAccount(
        bot_id="connector-control-http-001",
        username="connector_control_http",
        display_name="HTTP Bot",
        status="online",
        binding_type="http",
        created_by="a0000000-0000-0000-0000-000000000099",
    )
    db_session.add(bot)
    await db_session.commit()

    resp = await client.put(
        f"/api/v1/bots/{bot.bot_id}/connector-control",
        json={"settings": {"permissionMode": "allow"}},
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_connector_control_records_discovered_options() -> None:
    suffix = uuid4().hex[:8]
    bot_id = f"connector-control-options-{suffix}"
    async with async_session_factory() as session:
        bot = BotAccount(
            bot_id=bot_id,
            username=f"connector_control_options_{suffix}",
            display_name="Connector Control Options",
            status="online",
            binding_type="agent_bridge",
            binding_config={
                "agent_id": "codex",
                "connector_control": {
                    "revision": 3,
                    "settings": {"permissionMode": "reject"},
                },
            },
            created_by="a0000000-0000-0000-0000-000000000099",
        )
        session.add(bot)
        await session.commit()

    await _record_connector_config_options(
        bot_id,
        {
            "type": "config_options",
            "options": {
                "source": "acp",
                "sessionId": "fake-session",
                "providerSessionKey": "agentnexus:channel:C1",
                "modes": {
                    "currentModeId": "ask",
                    "availableModes": [{"id": "ask", "name": "Ask"}],
                },
                "configOptions": [
                    {
                        "id": "model",
                        "name": "Model",
                        "currentValueId": "fake-small",
                        "values": [{"id": "fake-small", "name": "Fake Small"}],
                    },
                ],
            },
        },
    )

    async with async_session_factory() as session:
        bot = await session.get(BotAccount, bot_id)
        assert bot is not None
        control = bot.binding_config["connector_control"]
    assert control["settings"] == {"permissionMode": "reject"}
    assert control["options"]["source"] == "acp"
    assert control["options"]["modes"]["currentModeId"] == "ask"
    assert control["options"]["configOptions"][0]["id"] == "model"
    assert "reported_at" in control["options"]
