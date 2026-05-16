"""Agent Bridge-facing /docs/agent-bridge routes."""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BotAccount, User
from app.services.auth.password_utils import hash_password


@pytest.mark.asyncio
async def test_openclaw_discovery_exposes_docs_namespace(client: AsyncClient) -> None:
    resp = await client.get("/docs/agent-bridge/discovery")

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["docs_namespace"] == "/docs/agent-bridge"
    assert data["entrypoints"]["register"]["url"].endswith("/docs/agent-bridge/register")
    assert data["entrypoints"]["register"]["auth"] == "account_password_or_user_bearer"
    body_schema = data["entrypoints"]["register"]["body_schema"]
    assert "account_username" in body_schema
    assert "account_password" in body_schema
    assert "bridge_provider" in body_schema
    assert data["entrypoints"]["help_get"]["url"].endswith("/docs/agent-bridge/help?q=...")
    assert data["bridge"]["control_ws"].endswith("/ws/agent-bridge/control")
    assert data["plugin"]["name"] == "@haowei0520/openclaw-channel-agentnexus"
    assert data["plugin"]["release_folder"] == "release"
    assert data["plugin"]["download_url"].endswith(
        "/docs/agent-bridge/release/openclaw-channel-agentnexus.tgz"
    )
    assert "openclaw plugins install" in data["plugin"]["install"]["openclaw"]


@pytest.mark.asyncio
async def test_openclaw_plugin_download_serves_release_file(
    client: AsyncClient,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent_bridge_docs_routes as routes

    plugin_file = tmp_path / "openclaw-channel-agentnexus.tgz"
    plugin_file.write_bytes(b"plugin-bytes")
    monkeypatch.setattr(routes, "_PLUGIN_RELEASE_DIR", tmp_path)

    resp = await client.get("/docs/agent-bridge/release/openclaw-channel-agentnexus.tgz")

    assert resp.status_code == 200
    assert resp.content == b"plugin-bytes"


@pytest.mark.asyncio
async def test_openclaw_help_answers_question(client: AsyncClient) -> None:
    resp = await client.post("/docs/agent-bridge/help", json={"question": "怎么让 OpenClaw 自动注册？"})

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["matched"] is True
    assert "OpenClaw" in data["answer"]
    assert "/docs/agent-bridge/register" in data["answer"]


@pytest.mark.asyncio
async def test_openclaw_register_creates_websocket_bot(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    db_session.add(
        User(
            user_id="openclaw-docs-user-001",
            username="openclaw_docs_user",
            password_hash=hash_password("Openclaw123"),
            display_name="OpenClaw Docs User",
            role="member",
        )
    )
    await db_session.flush()

    resp = await client.post(
        "/docs/agent-bridge/register",
        json={
            "username": "docs_oc_bot",
            "account_username": "openclaw_docs_user",
            "account_password": "Openclaw123",
            "display_name": "Docs OpenClaw Bot",
            "agent_id": "agent-main",
            "scope": "private",
            "intro": {"description": "Docs route test bot"},
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    token = data["bot"]["bot_token"]
    assert token.startswith("agb_")
    assert data["bot"]["binding_type"] == "agent_bridge"
    assert data["bot"]["binding_config"]["agent_id"] == "agent-main"
    assert data["bot"]["bot_token_prefix"] == token[:8]
    assert data["bridge"]["data_ws"].endswith("/ws/agent-bridge/data")
    assert data["plugin"]["download_url"].endswith(
        "/docs/agent-bridge/release/openclaw-channel-agentnexus.tgz"
    )
    assert data["agent_bridge_config"]["channels"]["agentnexus"]["accounts"][0]["botToken"] == token
    assert data["agentnexus_auth"]["method"] == "account_password"
    assert data["agentnexus_auth"]["access_token"]

    bot = (
        await db_session.execute(select(BotAccount).where(BotAccount.username == "docs_oc_bot"))
    ).scalar_one()
    assert bot.binding_type == "agent_bridge"
    assert bot.created_by == "openclaw-docs-user-001"
    assert bot.bot_token_hash is not None
    assert token not in bot.bot_token_hash


@pytest.mark.asyncio
async def test_agent_bridge_register_accepts_acp_provider(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    db_session.add(
        User(
            user_id="acp-docs-user-001",
            username="acp_docs_user",
            password_hash=hash_password("Acp12345"),
            display_name="ACP Docs User",
            role="member",
        )
    )
    await db_session.flush()

    resp = await client.post(
        "/docs/agent-bridge/register",
        json={
            "username": "docs_acp_bot",
            "bridge_provider": "acp",
            "account_username": "acp_docs_user",
            "account_password": "Acp12345",
            "agent_id": "codex-main",
            "scope": "private",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    token = data["bot"]["bot_token"]
    assert token.startswith("agb_")
    assert data["bot"]["bridge_provider"] == "acp"
    assert data["bot"]["binding_config"]["bridge_provider"] == "acp"
    assert data["bot"]["description"] == "ACP Agent: codex-main"
    assert data["acp_connector_config"]["accounts"]["docs_acp_bot"]["botToken"] == token
    agent_config = data["acp_connector_config"]["accounts"]["docs_acp_bot"]["agent"]
    assert agent_config["command"] == "codex-acp"
    assert agent_config["args"] == []

    bot = (
        await db_session.execute(select(BotAccount).where(BotAccount.username == "docs_acp_bot"))
    ).scalar_one()
    assert bot.binding_type == "agent_bridge"
    assert bot.bridge_provider == "acp"


@pytest.mark.asyncio
async def test_openclaw_register_still_accepts_bearer_token(
    client: AsyncClient,
) -> None:
    resp = await client.post(
        "/docs/agent-bridge/register",
        headers={"Authorization": "Bearer a0000000-0000-0000-0000-000000000099"},
        json={
            "username": "docs_oc_bearer_bot",
            "display_name": "Bearer OpenClaw Bot",
            "agent_id": "agent-bearer",
        },
    )

    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["bot"]["bot_token"].startswith("agb_")
    assert data["agentnexus_auth"]["method"] == "bearer"
    assert data["agentnexus_auth"]["access_token"] is None
