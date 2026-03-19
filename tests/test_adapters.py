"""OpenClawAdapter 契约测试."""
import pytest
from unittest.mock import AsyncMock, patch

from app.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.adapters.mock import MockOpenClawAdapter
from app.adapters.unified_builtin import UnifiedBuiltinBotAdapter


@pytest.mark.asyncio
async def test_mock_adapter_execute() -> None:
    adapter = MockOpenClawAdapter(reply="你好，我是 Mock。")
    payload = AgentPayload(
        task_id="t1",
        channel_id="c1",
        trigger_message={"user": "张三", "text": "@bot 你好", "timestamp": "2026-03-07T00:00:00Z"},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )
    resp = await adapter.execute(payload)
    assert isinstance(resp, AgentResponse)
    assert resp.success is True
    assert resp.content == "你好，我是 Mock。"
    assert resp.task_id == "t1"


@pytest.mark.asyncio
async def test_mock_adapter_health_check() -> None:
    adapter = MockOpenClawAdapter(healthy=True)
    assert await adapter.health_check() is True
    adapter2 = MockOpenClawAdapter(healthy=False)
    assert await adapter2.health_check() is False


@pytest.mark.asyncio
async def test_unified_builtin_attachment_fallback_uses_file_content() -> None:
    adapter = UnifiedBuiltinBotAdapter()
    payload = AgentPayload(
        task_id="t-file-fallback",
        channel_id="c-file-fallback",
        trigger_message={"user": "u1", "text": "@channel bot 这个文本概括是什么？", "timestamp": "2026-03-19T00:00:00Z"},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
        attachments=[
            {
                "file_id": "file-1",
                "filename": "Halmet.docx",
                "summary": "- To be, or not to be—that is the question:\n- Whether ‘tis nobler in the mind to suffer",
                "content": "To be, or not to be—that is the question: Whether ‘tis nobler in the mind to suffer...",
                "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }
        ],
    )

    with patch("app.adapters.unified_builtin._agent_loop", new=AsyncMock(return_value="")):
        resp = await adapter.execute(payload)

    assert resp.success is True
    assert "Halmet.docx" in resp.content
    assert "To be, or not to be" in resp.content
