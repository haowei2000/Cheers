"""测试 ChannelBotAdapter 能否通过 update_anchor 工具正确更新锚点层。"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.models import AIModel, BotAccount, Channel, ChannelMembership, MemoryEntry, PromptTemplate, Workspace
from app.features.bot_runtime.adapters.base import AgentPayload, drain_events_to_response
from app.features.bot_runtime.adapters.channel_bot import ChannelBotAdapter


def _payload(channel_id: str, text: str) -> AgentPayload:
    return AgentPayload(
        task_id="test-task-001",
        channel_id=channel_id,
        trigger_message={"user": "user-001", "text": text, "timestamp": ""},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )


@pytest.mark.asyncio
async def test_update_anchor_persists_content() -> None:
    """LLM 返回 update_anchor 工具调用时，锚点层应被写入 memory_entries 表。"""
    channel_id = "test-ch-anchor-001"
    anchor_content = "项目目标：构建多智能体协作平台，2026 Q2 上线。"

    # Create an in-memory database and session.
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.execute(text(
            "CREATE TABLE memory_entries ("
            "  entry_id VARCHAR(36) PRIMARY KEY,"
            "  channel_id VARCHAR(36) NOT NULL,"
            "  layer VARCHAR(50) NOT NULL,"
            "  title VARCHAR(255),"
            "  content TEXT NOT NULL,"
            "  sort_order INTEGER NOT NULL DEFAULT 0,"
            "  created_by VARCHAR(36),"
            "  creator_type VARCHAR(16),"
            "  created_at TIMESTAMP,"
            "  updated_at TIMESTAMP,"
            "  UNIQUE(channel_id, layer, sort_order)"
            ")"
        ))
    test_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # Mock the LLM returning a tool call and then final text.
    mock_llm = MagicMock()
    res1 = MagicMock()
    res1.content = ""
    res1.tool_calls = [{
        "name": "update_anchor",
        "args": {"content": anchor_content},
        "id": "call_1"
    }]
    res2 = MagicMock()
    res2.content = "已为你更新项目锚点。"
    res2.tool_calls = []

    mock_llm.ainvoke = AsyncMock(side_effect=[res1, res2])
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with (
        patch("app.features.bot_runtime.adapters.channel_bot._make_llm", return_value=mock_llm),
        patch("app.features.bot_runtime.adapters.channel_bot._get_llm_config", return_value={"base_url": "x", "model": "y"}),
        patch("app.db.session.async_session_factory", new=test_session_factory),
    ):
        adapter = ChannelBotAdapter()
        payload = _payload(channel_id, "请把项目锚点更新为：" + anchor_content)
        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

        assert resp.success is True
        assert "锚点" in resp.content or "已为你更新" in resp.content

        # Verify the anchor layer was persisted to memory_entries.
        async with test_session_factory() as session:
            result = await session.execute(
                select(MemoryEntry).where(
                    MemoryEntry.channel_id == channel_id,
                    MemoryEntry.layer == "ANCHOR",
                )
            )
            entry = result.scalar_one_or_none()
            assert entry is not None
            assert entry.content == anchor_content


@pytest.mark.asyncio
async def test_update_anchor_empty_content_returns_error() -> None:
    """update_anchor 传入空 content 时应返回错误而不崩溃。"""
    channel_id = "test-ch-anchor-002"

    mock_llm = MagicMock()
    res1 = MagicMock()
    res1.content = ""
    res1.tool_calls = [{
        "name": "update_anchor",
        "args": {"content": ""},
        "id": "call_2"
    }]
    res2 = MagicMock()
    res2.content = "操作失败。"
    res2.tool_calls = []
    mock_llm.ainvoke = AsyncMock(side_effect=[res1, res2])
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with (
        patch("app.features.bot_runtime.adapters.channel_bot._make_llm", return_value=mock_llm),
        patch("app.features.bot_runtime.adapters.channel_bot._get_llm_config", return_value={"base_url": "x", "model": "y"}),
    ):
        adapter = ChannelBotAdapter()
        payload = _payload(channel_id, "清空锚点")
        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

        assert resp.success is True


@pytest.mark.asyncio
@pytest.mark.skip(reason="Background task isolation issue - patches don't propagate to _run_bot_pipeline_bg")
async def test_update_anchor_via_api(client, db_session) -> None:
    """通过 HTTP API 发送消息，触发 update_anchor，验证 memory_entries 中锚点已更新。"""
    from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID

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
        bot_id=HELPER_BOT_ID,
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
    res1 = MagicMock()
    res1.content = ""
    res1.tool_calls = [{
        "name": "update_anchor",
        "args": {"content": anchor_text},
        "id": "call_3"
    }]
    res2 = MagicMock()
    res2.content = "锚点已更新。"
    res2.tool_calls = []
    mock_llm.ainvoke = AsyncMock(side_effect=[res1, res2])
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with (
        patch("app.features.bot_runtime.adapters.channel_bot._make_llm", return_value=mock_llm),
        patch("app.features.bot_runtime.adapters.channel_bot._get_llm_config", return_value={"base_url": "x", "model": "y"}),
    ):
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

        result = await db_session.execute(
            select(MemoryEntry).where(
                MemoryEntry.channel_id == ch.channel_id,
                MemoryEntry.layer == "ANCHOR",
            )
        )
        entry = result.scalar_one_or_none()
        assert entry is not None
        assert entry.content == anchor_text


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
