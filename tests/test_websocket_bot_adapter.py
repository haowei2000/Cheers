"""WebsocketBotAdapter 与 adapter_resolver 的绑定路由契约测试。

覆盖：
  - WebsocketBotAdapter.execute() 返回占位 AgentResponse（后续提交会替换为
    「异步派发给 OpenClaw channel plugin」的真实实现）。
  - adapter_resolver 对 binding_type == 'websocket' 的 Bot 路由到 WebsocketBotAdapter。
  - 对默认 'http' 绑定仍路由到 LLMBotAdapter（回归保护）。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.adapters.base import AgentPayload, AgentResponse
from app.services.adapters.mock import MockOpenClawAdapter
from app.services.adapters.websocket_bot import WebsocketBotAdapter
from app.services.orchestrator.adapter_resolver import get_adapter_for_bot


def _fake_bot(**kwargs):
    defaults = dict(
        bot_id="bot-test-001",
        username="test-bot",
        display_name="Test Bot",
        status="online",
        binding_type="http",
        binding_config=None,
        ai_model=None,
        prompt_template=None,
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


@pytest.mark.asyncio
async def test_websocket_bot_adapter_execute_returns_placeholder() -> None:
    bot = _fake_bot(binding_type="websocket", binding_config={"agent_id": "agent-1"})
    adapter = WebsocketBotAdapter(bot)

    payload = AgentPayload(
        task_id="t-ws-1",
        channel_id="c1",
        trigger_message={"user": "u1", "text": "@test-bot hi", "timestamp": "2026-04-21T00:00:00Z"},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )
    resp = await adapter.execute(payload)
    assert isinstance(resp, AgentResponse)
    assert resp.success is True
    assert resp.task_id == "t-ws-1"
    assert "OpenClaw" in resp.content


@pytest.mark.asyncio
async def test_websocket_bot_adapter_health_check() -> None:
    adapter = WebsocketBotAdapter(_fake_bot(binding_type="websocket"))
    assert await adapter.health_check() is True


def _mock_session_returning_bot(bot) -> MagicMock:
    session = MagicMock()
    scalar = MagicMock()
    scalar.scalar_one_or_none = MagicMock(return_value=bot)
    session.execute = AsyncMock(return_value=scalar)
    return session


@pytest.mark.asyncio
async def test_resolver_routes_websocket_binding_to_ws_adapter() -> None:
    bot = _fake_bot(binding_type="websocket")
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session)
    assert isinstance(adapter, WebsocketBotAdapter)


@pytest.mark.asyncio
async def test_resolver_ws_bot_offline_returns_mock() -> None:
    bot = _fake_bot(binding_type="websocket", status="offline")
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session)
    assert isinstance(adapter, MockOpenClawAdapter)


@pytest.mark.asyncio
async def test_resolver_http_binding_without_model_returns_mock() -> None:
    """默认 http 绑定下，无 AIModel 配置仍沿用旧的回退逻辑（不应被新分支影响）。"""
    bot = _fake_bot(binding_type="http", ai_model=None)
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session)
    assert isinstance(adapter, MockOpenClawAdapter)
