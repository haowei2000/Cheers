"""adapter_resolver 对 binding_type 的路由契约测试。

AgentBridgeBotAdapter 的 execute/health_check 语义在 tests/test_agent_bridge.py
里有专门覆盖（含 dispatcher 互动）。此文件只验证 resolver 分流行为。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.features.bot_runtime.adapters.agent_bridge_bot import AgentBridgeBotAdapter
from app.features.bot_runtime.adapters.mock_bot import MockBotAdapter
from app.features.bot_runtime.pipeline.bot.adapter_resolver import get_adapter_for_bot


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


def _mock_session_returning_bot(bot) -> MagicMock:
    session = MagicMock()
    scalar = MagicMock()
    scalar.scalar_one_or_none = MagicMock(return_value=bot)
    session.execute = AsyncMock(return_value=scalar)
    return session


@pytest.mark.asyncio
async def test_resolver_routes_websocket_binding_to_ws_adapter() -> None:
    bot = _fake_bot(binding_type="agent_bridge")
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session)
    assert isinstance(adapter, AgentBridgeBotAdapter)


@pytest.mark.asyncio
async def test_resolver_passes_template_override_to_websocket_adapter() -> None:
    template = SimpleNamespace(user_template="任务：{{message}}", system_prompt="系统")
    bot = _fake_bot(binding_type="agent_bridge", prompt_template=None)
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session, template_override=template)

    assert isinstance(adapter, AgentBridgeBotAdapter)
    assert adapter.template is template


@pytest.mark.asyncio
async def test_resolver_ws_bot_offline_returns_mock() -> None:
    bot = _fake_bot(binding_type="agent_bridge", status="offline")
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session)
    assert isinstance(adapter, MockBotAdapter)


@pytest.mark.asyncio
async def test_resolver_http_binding_without_model_returns_mock() -> None:
    """默认 http 绑定下，无 AIModel 配置仍沿用旧的回退逻辑（不应被新分支影响）。"""
    bot = _fake_bot(binding_type="http", ai_model=None)
    session = _mock_session_returning_bot(bot)

    adapter = await get_adapter_for_bot(bot.bot_id, session)
    assert isinstance(adapter, MockBotAdapter)
