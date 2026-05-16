"""Tests for test adapters."""
from unittest.mock import patch

import httpx
import pytest

from app.db.models import AIModel, BotAccount, PromptTemplate
from app.features.bot_runtime.adapters.base import AgentPayload, drain_events_to_response
from app.features.bot_runtime.adapters.channel_bot import ChannelBotAdapter
from app.features.bot_runtime.adapters.http_bot import HttpBotAdapter
from app.features.bot_runtime.adapters.mock_bot import MockBotAdapter
from app.features.bot_runtime.pipeline.adapter_events import Final


def _http_bot_adapter(
    *,
    provider: str = "openai",
    model_name: str = "gpt-test",
    base_url: str = "http://llm.test/v1",
) -> HttpBotAdapter:
    model = AIModel(
        model_id="adapter-health-model",
        name="Adapter Health Model",
        provider=provider,
        model_name=model_name,
        base_url=base_url,
        is_enabled=True,
        is_builtin=False,
        config={},
    )
    template = PromptTemplate(
        template_id="adapter-health-template",
        name="Adapter Health Template",
        system_prompt="system",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=False,
    )
    bot = BotAccount(
        bot_id="adapter-health-bot",
        username="adapter_health_bot",
        model_id=model.model_id,
        template_id=template.template_id,
        status="online",
    )
    bot.ai_model = model
    bot.prompt_template = template
    return HttpBotAdapter(bot)


@pytest.mark.asyncio
async def test_mock_adapter_execute() -> None:
    adapter = MockBotAdapter(reply="你好，我是 Mock。")
    payload = AgentPayload(
        task_id="t1",
        channel_id="c1",
        trigger_message={"user": "张三", "text": "@bot 你好", "timestamp": "2026-03-07T00:00:00Z"},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )
    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
    assert resp.success is True
    assert resp.content == "你好，我是 Mock。"
    assert resp.task_id == "t1"


@pytest.mark.asyncio
async def test_mock_adapter_health_check() -> None:
    adapter = MockBotAdapter(healthy=True)
    assert await adapter.health_check() is True
    adapter2 = MockBotAdapter(healthy=False)
    assert await adapter2.health_check() is False


@pytest.mark.asyncio
async def test_http_bot_health_check_prefers_models_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        assert request.method == "GET"
        return httpx.Response(200, json={"data": [{"id": "gpt-test"}]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)

    assert await _http_bot_adapter().health_check() is True
    assert requested_paths == ["/v1/models"]


@pytest.mark.asyncio
async def test_http_bot_health_check_falls_back_to_chat_when_models_endpoint_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_paths.append(request.url.path)
        if request.url.path == "/v1/models":
            return httpx.Response(404)
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)

    assert await _http_bot_adapter().health_check() is True
    assert requested_paths == ["/v1/models", "/v1/chat/completions"]


@pytest.mark.asyncio
async def test_http_bot_health_check_reports_missing_model_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "other-model"}]})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)

    assert await _http_bot_adapter().health_check() is False


@pytest.mark.asyncio
async def test_channel_bot_attachment_fallback_uses_file_content() -> None:
    adapter = ChannelBotAdapter()
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

    async def _empty_iter(*args, **kwargs):
        # Yield an empty Final → triggers ChannelBotAdapter.execute's
        # keyword-fallback branch (which injects the file content).
        yield Final(content="", success=True)

    with patch("app.features.bot_runtime.adapters.channel_bot._run_agent_iter", new=_empty_iter):
        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

    assert resp.success is True
    assert "Halmet.docx" in resp.content
    assert "To be, or not to be" in resp.content
