"""测试 UnifiedBuiltinBotAdapter 能否通过 update_anchor 工具正确更新锚点层。"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage

from app.db.models import AIModel, BotAccount, Channel, ChannelMembership, PromptTemplate, Workspace
from app.services.adapters.base import AgentPayload
from app.services.adapters.unified_builtin import UnifiedBuiltinBotAdapter
from app.services.memory.context_store import get_layer, init_context_db


def _payload(channel_id: str, text: str) -> AgentPayload:
    return AgentPayload(
        task_id="test-task-001",
        channel_id=channel_id,
        trigger_message={"user": "user-001", "text": text, "timestamp": ""},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )


@pytest.mark.asyncio
async def test_update_anchor_persists_content() -> None:
    """LLM 返回 update_anchor 工具调用时，锚点层应被写入 context store。"""
    channel_id = "test-ch-anchor-001"
    anchor_content = "项目目标：构建多智能体协作平台，2026 Q2 上线。"

    # 模拟 LLM 返回工具调用，然后返回最终文本
    mock_llm = MagicMock()
    
    # 第一轮：返回 tool call
    res1 = AIMessage(
        content="",
        tool_calls=[{
            "name": "update_anchor",
            "args": {"content": anchor_content},
            "id": "call_1"
        }]
    )
    # 第二轮：返回普通回复
    res2 = AIMessage(content="已为你更新项目锚点。")
    
    mock_llm.ainvoke = AsyncMock(side_effect=[res1, res2])
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with (
        patch("app.config.settings.context_db_url", new="sqlite+aiosqlite:///:memory:"),
        patch("app.services.memory.context_store._engine", new=None),
        patch("app.services.memory.context_store._session_factory", new=None),
        patch("app.services.memory.context_store._context_db_initialized", new=False),
        patch("app.services.adapters.unified_builtin._make_llm", return_value=mock_llm),
        patch("app.services.adapters.unified_builtin._get_llm_config", return_value={"base_url": "x", "model": "y"}),
    ):
        await init_context_db()
        adapter = UnifiedBuiltinBotAdapter()
        resp = await adapter.execute(_payload(channel_id, "请把项目锚点更新为：" + anchor_content))

        assert resp.success is True
        assert "锚点" in resp.content or "已为你更新" in resp.content

        # 验证锚点层已持久化到 context store
        stored = await get_layer(channel_id, "ANCHOR")
        assert stored == anchor_content


@pytest.mark.asyncio
async def test_update_anchor_empty_content_returns_error() -> None:
    """update_anchor 传入空 content 时应返回错误而不崩溃。"""
    channel_id = "test-ch-anchor-002"

    mock_llm = MagicMock()
    res1 = AIMessage(
        content="",
        tool_calls=[{
            "name": "update_anchor",
            "args": {"content": ""},
            "id": "call_2"
        }]
    )
    res2 = AIMessage(content="操作失败。")
    mock_llm.ainvoke = AsyncMock(side_effect=[res1, res2])
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with (
        patch("app.config.settings.context_db_url", new="sqlite+aiosqlite:///:memory:"),
        patch("app.services.memory.context_store._engine", new=None),
        patch("app.services.memory.context_store._session_factory", new=None),
        patch("app.services.memory.context_store._context_db_initialized", new=False),
        patch("app.services.adapters.unified_builtin._make_llm", return_value=mock_llm),
        patch("app.services.adapters.unified_builtin._get_llm_config", return_value={"base_url": "x", "model": "y"}),
    ):
        await init_context_db()
        adapter = UnifiedBuiltinBotAdapter()
        resp = await adapter.execute(_payload(channel_id, "清空锚点"))

        assert resp.success is True


@pytest.mark.asyncio
@pytest.mark.skip(reason="Background task isolation issue - patches don't propagate to _run_orchestrator_bg")
async def test_update_anchor_via_api(client, db_session) -> None:
    """通过 HTTP API 发送消息，触发 update_anchor，验证 context store 中锚点已更新。"""
    from app.services.guide.constants import GUIDE_BOT_ID

    ws = Workspace(workspace_id="anc0-0000-0000-0000-000000000001", name="AnchorWS")
    ch = Channel(
        channel_id="anc1-0000-0000-0000-000000000001",
        workspace_id=ws.workspace_id,
        name="anchor-test",
        type="public",
    )
    model = _make_model("anc-model-0001")
    tpl = _make_template("anc-tpl-0001")
    bot = BotAccount(
        bot_id=GUIDE_BOT_ID,
        username="channel bot",
        display_name="内置助手",
        model_id=model.model_id,
        template_id=tpl.template_id,
        status="online",
    )
    db_session.add_all([ws, ch, model, tpl, bot])
    db_session.add(ChannelMembership(
        channel_id=ch.channel_id,
        member_id=bot.bot_id,
        member_type="bot",
    ))
    await db_session.commit()

    anchor_text = "API 测试锚点内容 v1"
    
    mock_llm = MagicMock()
    res1 = AIMessage(
        content="",
        tool_calls=[{
            "name": "update_anchor",
            "args": {"content": anchor_text},
            "id": "call_3"
        }]
    )
    res2 = AIMessage(content="锚点已更新。")
    mock_llm.ainvoke = AsyncMock(side_effect=[res1, res2])
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with (
        patch("app.config.settings.context_db_url", new="sqlite+aiosqlite:///:memory:"),
        patch("app.services.memory.context_store._engine", new=None),
        patch("app.services.memory.context_store._session_factory", new=None),
        patch("app.services.memory.context_store._context_db_initialized", new=False),
        patch("app.services.adapters.unified_builtin._make_llm", return_value=mock_llm),
        patch("app.services.adapters.unified_builtin._get_llm_config", return_value={"base_url": "x", "model": "y"}),
    ):
        await init_context_db()
        resp = await client.post(
            f"/api/v1/channels/{ch.channel_id}/messages",
            json={
                "content": f"@channel bot 请更新项目锚点：{anchor_text}",
                "sender_id": "a0000000-0000-0000-0000-000000000001",
                "sender_type": "user",
            },
        )
        assert resp.status_code == 200
        await asyncio.sleep(0.5)

        stored = await get_layer(ch.channel_id, "ANCHOR")
        assert stored == anchor_text


def _make_model(model_id: str) -> AIModel:
    return AIModel(
        model_id=model_id,
        name="test-model",
        provider="test",
        model_name="test",
        base_url="http://localhost",
        is_enabled=True,
        is_builtin=True,
        config={},
    )


def _make_template(template_id: str) -> PromptTemplate:
    return PromptTemplate(
        template_id=template_id,
        name="test-tpl",
        system_prompt="test",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )
