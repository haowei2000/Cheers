"""Tests for test openclaw bridge."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from xml.etree import ElementTree as ET

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.agent_bridge.routes import _BridgeOutboundQueueFull, _BridgeOutboundWriter
from app.config import settings
from app.db.models import AgentNexusSession, Channel, Message, Workspace
from app.features.agent_bridge.dispatcher import BridgeDispatcher
from app.features.agent_bridge.pending import PendingReply, PendingReplyRegistry
from app.features.bot_runtime.adapters.agent_bridge_bot import AgentBridgeBotAdapter
from app.features.bot_runtime.adapters.base import AgentPayload, drain_events_to_response


def _fake_bot(**kwargs):
    defaults = dict(
        bot_id="bot-ws-001",
        username="ws-bot",
        display_name="WS Bot",
        status="online",
        binding_type="agent_bridge",
        binding_config={"agent_id": "agent-x"},
        ai_model=None,
        prompt_template=None,
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _fake_template(user_template: str = "{{memory}}\n\n任务：{{message}}"):
    return SimpleNamespace(
        system_prompt="WebSocket 系统提示",
        user_template=user_template,
    )


def _payload(task_id: str = "t-ws-001", channel_id: str = "c-001") -> AgentPayload:
    return AgentPayload(
        task_id=task_id,
        channel_id=channel_id,
        trigger_message={"user": "u1", "text": "@ws-bot hi", "timestamp": "2026-04-21T00:00:00Z"},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "history": ""},
    )


# --------------------------- BridgeDispatcher ------------------------------

@pytest.mark.asyncio
async def test_dispatcher_publish_filters_by_bot_ids() -> None:
    d = BridgeDispatcher()
    sub_a = await d.subscribe(bot_ids=["bot-A"])
    sub_b = await d.subscribe(bot_ids=["bot-B"])
    sub_all = await d.subscribe(bot_ids=None)  # Debug/internal mode receives all events.

    delivered = await d.publish({"type": "dispatch", "bot_id": "bot-A"})
    assert delivered == 2  # sub_a + sub_all
    assert sub_a.queue.get_nowait()["bot_id"] == "bot-A"
    assert sub_all.queue.get_nowait()["bot_id"] == "bot-A"
    assert sub_b.queue.empty()

    delivered = await d.publish({"type": "dispatch", "bot_id": "bot-B"})
    assert delivered == 2  # sub_b + sub_all
    assert sub_b.queue.get_nowait()["bot_id"] == "bot-B"
    assert sub_all.queue.get_nowait()["bot_id"] == "bot-B"
    assert sub_a.queue.empty()


@pytest.mark.asyncio
async def test_dispatcher_empty_subscription_receives_nothing() -> None:
    """Covers test dispatcher empty subscription receives nothing behavior."""
    d = BridgeDispatcher()
    sub = await d.subscribe(bot_ids=[])
    delivered = await d.publish({"type": "dispatch", "bot_id": "bot-A"})
    assert delivered == 0
    assert sub.queue.empty()


@pytest.mark.asyncio
async def test_dispatcher_update_subscription() -> None:
    d = BridgeDispatcher()
    sub = await d.subscribe(bot_ids=[])
    await d.publish({"type": "dispatch", "bot_id": "bot-A"})
    assert sub.queue.empty()

    await d.update_subscription(sub, bot_ids=["bot-A"])
    delivered = await d.publish({"type": "dispatch", "bot_id": "bot-A"})
    assert delivered == 1
    assert sub.queue.get_nowait()["bot_id"] == "bot-A"


@pytest.mark.asyncio
async def test_dispatcher_publish_zero_when_no_subscribers() -> None:
    d = BridgeDispatcher()
    delivered = await d.publish({"type": "dispatch", "bot_id": "x"})
    assert delivered == 0


@pytest.mark.asyncio
async def test_dispatcher_unsubscribe_stops_delivery() -> None:
    d = BridgeDispatcher()
    sub = await d.subscribe(bot_ids=["bot-A"])
    await d.publish({"type": "dispatch", "bot_id": "bot-A"})
    assert sub.queue.get_nowait()["bot_id"] == "bot-A"
    await d.unsubscribe(sub)
    delivered = await d.publish({"type": "dispatch", "bot_id": "bot-A"})
    assert delivered == 0


@pytest.mark.asyncio
async def test_bridge_outbound_writer_closes_slow_subscriber(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ws_outbound_queue_size", 1)
    monkeypatch.setattr(settings, "ws_send_timeout_seconds", 10.0)

    class SlowWS:
        def __init__(self) -> None:
            self.sent: list[dict] = []
            self.closed = False
            self.send_started = asyncio.Event()
            self.release_send = asyncio.Event()

        async def send_json(self, data: dict) -> None:
            self.sent.append(data)
            self.send_started.set()
            await self.release_send.wait()

        async def close(self, code: int = 1000, reason: str = "") -> None:
            self.closed = True
            self.close_code = code
            self.close_reason = reason

    ws = SlowWS()
    writer = _BridgeOutboundWriter(ws)  # type: ignore[arg-type]
    writer.start()

    await writer.send({"type": "dispatch", "seq": 1})
    await asyncio.wait_for(ws.send_started.wait(), timeout=1)
    await writer.send({"type": "dispatch", "seq": 2})
    with pytest.raises(_BridgeOutboundQueueFull):
        await writer.send({"type": "dispatch", "seq": 3})

    assert ws.closed is True
    assert ws.close_code == 1011
    assert ws.close_reason == "outbound queue full"

    ws.release_send.set()
    await writer.close()


# --------------------------- AgentBridgeBotAdapter ---------------------------

class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


def _patch_record_event(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_record_event(bot_id: str, stream: str, event: dict) -> int:
        return 1

    monkeypatch.setattr(
        "app.features.agent_bridge.event_log.record_event",
        fake_record_event,
    )


@pytest.mark.asyncio
async def test_ws_bot_adapter_dispatches_via_registry_when_data_ws_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.features.agent_bridge.pending import pending_replies
    from app.features.agent_bridge.registry import bot_session_registry

    _patch_record_event(monkeypatch)
    ws = _FakeWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        adapter = AgentBridgeBotAdapter(_fake_bot())
        payload = _payload("t-ws-001")
        # Mock orchestrator behavior by putting the placeholder msg_id into process_config.
        payload.process_config.placeholder_msg_id = "placeholder-123"

        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
        assert resp.success is True
        assert resp.dispatched_async is True
        assert resp.content == ""
        assert len(ws.sent) == 1

        event = ws.sent[0]
        assert event["type"] == "message"
        assert event["bot_id"] == "bot-ws-001"
        assert event["channel_id"] == "c-001"
        assert event["task_id"] == "t-ws-001"
        assert event["placeholder_msg_id"] == "placeholder-123"
        assert event["binding_config"] == {"agent_id": "agent-x"}

        # The adapter pre-registered pending state so a fast plugin reply can be located.
        pending = await pending_replies.peek_by_msg("placeholder-123")
        assert pending is not None
        assert pending.bot_id == "bot-ws-001"
        assert pending.channel_id == "c-001"
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]
        # Cleanup: pop the pre-registered pending entry.
        await pending_replies.pop_by_msg("placeholder-123")


@pytest.mark.asyncio
async def test_ws_bot_adapter_commits_placeholder_before_plugin_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.features.agent_bridge.pending import pending_replies
    from app.features.agent_bridge.registry import bot_session_registry

    _patch_record_event(monkeypatch)

    async def fake_resolve_dispatch_session(*_args, **_kwargs):
        return SimpleNamespace(to_event_payload=lambda: {"provider_session_key": "sk-test"})

    monkeypatch.setattr(
        "app.features.agent_bridge.session_map.resolve_dispatch_session",
        fake_resolve_dispatch_session,
    )

    events: list[str] = []

    class OrderedWS(_FakeWS):
        async def send_json(self, data: dict) -> None:
            events.append("dispatch")
            await super().send_json(data)

    class FakeSession:
        async def flush(self) -> None:
            events.append("flush")

        async def commit(self) -> None:
            events.append("commit")

    ws = OrderedWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        adapter = AgentBridgeBotAdapter(_fake_bot())
        payload = _payload("t-ws-durable")
        payload.process_config.placeholder_msg_id = "placeholder-durable"
        payload.process_config.db_session = FakeSession()

        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

        assert resp.success is True
        assert resp.dispatched_async is True
        assert events == ["flush", "commit", "dispatch"]
        assert ws.sent[0]["placeholder_msg_id"] == "placeholder-durable"
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]
        await pending_replies.pop_by_msg("placeholder-durable")


@pytest.mark.asyncio
async def test_ws_bot_adapter_renders_prompt_template_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.features.agent_bridge.pending import pending_replies
    from app.features.agent_bridge.registry import bot_session_registry

    _patch_record_event(monkeypatch)
    ws = _FakeWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        adapter = AgentBridgeBotAdapter(_fake_bot(prompt_template=_fake_template()))
        payload = _payload("t-ws-template")
        payload.process_config.placeholder_msg_id = "placeholder-template"
        payload.memory_context = {"anchor": "WebSocket 锚点"}

        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

        assert resp.success is True
        event = ws.sent[0]
        rendered_text = event["trigger_message"]["text"]
        assert "=== 频道记忆上下文" not in rendered_text
        start = rendered_text.index("<channel_memory")
        end = rendered_text.index("</channel_memory>") + len("</channel_memory>")
        memory_root = ET.fromstring(rendered_text[start:end])
        assert memory_root.find("./layer[@name='anchor']/content").text == "WebSocket 锚点"
        assert "WebSocket 锚点" in rendered_text
        assert "任务：@ws-bot hi" in rendered_text
        assert event["raw_trigger_message"]["text"] == "@ws-bot hi"
        assert event["prompt"]["user"] == rendered_text
        assert "WebSocket 系统提示" in event["prompt"]["system"]
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]
        await pending_replies.pop_by_msg("placeholder-template")


@pytest.mark.asyncio
async def test_ws_bot_adapter_sends_delegated_xml_without_template_wrap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.features.agent_bridge.pending import pending_replies
    from app.features.agent_bridge.registry import bot_session_registry

    _patch_record_event(monkeypatch)
    ws = _FakeWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        adapter = AgentBridgeBotAdapter(_fake_bot(prompt_template=_fake_template()))
        payload = _payload("t-ws-delegated-xml")
        payload.process_config.placeholder_msg_id = "placeholder-delegated-xml"
        payload.process_config.delegated_task_xml = True
        payload.trigger_message = {
            **payload.trigger_message,
            "text": "<agentnexus_subbot_request><delegated_task>hi</delegated_task></agentnexus_subbot_request>",
        }
        payload.memory_context = {"anchor": "should-not-be-wrapped"}

        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

        assert resp.success is True
        event = ws.sent[0]
        rendered_text = event["trigger_message"]["text"]
        assert rendered_text.startswith("<agentnexus_subbot_request>")
        assert "任务：" not in rendered_text
        assert "should-not-be-wrapped" not in rendered_text
        assert event["prompt"]["user"] == rendered_text
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]
        await pending_replies.pop_by_msg("placeholder-delegated-xml")


@pytest.mark.asyncio
async def test_ws_bot_adapter_returns_failure_when_no_data_ws() -> None:
    from app.features.agent_bridge.pending import pending_replies

    adapter = AgentBridgeBotAdapter(_fake_bot(display_name="Alpha"))
    payload = _payload()
    payload.process_config.placeholder_msg_id = "placeholder-fail-001"
    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
    assert resp.success is False
    assert resp.dispatched_async is False
    assert resp.error_message == "no_plugin_subscribers"
    assert "Alpha" in resp.content
    # Failure path should roll back pre-registration.
    assert await pending_replies.peek_by_msg("placeholder-fail-001") is None


@pytest.mark.asyncio
async def test_ws_bot_adapter_does_not_create_session_when_no_data_ws(
    db_session: AsyncSession,
) -> None:
    adapter = AgentBridgeBotAdapter(_fake_bot())
    payload = _payload()
    payload.process_config.placeholder_msg_id = "placeholder-no-ws-session"
    payload.process_config.db_session = db_session
    before_count = (
        await db_session.execute(select(func.count()).select_from(AgentNexusSession))
    ).scalar_one()

    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

    assert resp.success is False
    after_count = (
        await db_session.execute(select(func.count()).select_from(AgentNexusSession))
    ).scalar_one()
    assert after_count == before_count


@pytest.mark.asyncio
async def test_ws_bot_adapter_ignores_irrelevant_bot_session() -> None:
    """Covers test ws bot adapter ignores irrelevant bot session behavior."""
    from app.features.agent_bridge.registry import bot_session_registry

    other = _FakeWS()
    await bot_session_registry.bind_data("some-other-bot", other)  # type: ignore[arg-type]
    try:
        adapter = AgentBridgeBotAdapter(_fake_bot())
        payload = _payload()
        resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
        assert resp.success is False
        assert other.sent == []
    finally:
        await bot_session_registry.unbind_data("some-other-bot", other)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_ws_bot_adapter_health_check_reflects_data_ws() -> None:
    from app.features.agent_bridge.registry import bot_session_registry

    adapter = AgentBridgeBotAdapter(_fake_bot())
    assert await adapter.health_check() is False

    ws = _FakeWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        assert await adapter.health_check() is True
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_bridge_apply_trace_broadcasts_registered_stream(monkeypatch) -> None:
    from app.features.agent_bridge.service import apply_trace, register_stream
    from app.features.agent_bridge.streams import stream_registry

    sent: list[tuple[str, dict]] = []

    async def fake_broadcast(channel_id: str, message: dict) -> None:
        sent.append((channel_id, message))

    monkeypatch.setattr(
        "app.services.ws_service.ws_manager.broadcast_to_channel",
        fake_broadcast,
    )

    await register_stream(
        msg_id="placeholder-trace",
        bot_id="bot-ws-001",
        channel_id="c-001",
        task_id="t-trace",
    )
    try:
        ok = await apply_trace(
            msg_id="placeholder-trace",
            bot_id="bot-ws-001",
            payload={
                "msg_id": "placeholder-trace",
                "task_id": "t-trace",
                "stream": "tool",
                "seq": 2,
                "title": "read_file",
                "message": "running",
                "data": {"kind": "tool"},
            },
        )
        assert ok is True
        assert sent == [
            (
                "c-001",
                {
                    "type": "bot_trace",
                    "data": {
                        "msg_id": "placeholder-trace",
                        "task_id": "t-trace",
                        "channel_id": "c-001",
                        "bot_id": "bot-ws-001",
                        "stream": "tool",
                        "seq": 2,
                        "title": "read_file",
                        "message": "running",
                        "data": {"kind": "tool"},
                    },
                },
            )
        ]
    finally:
        await stream_registry.pop("placeholder-trace")


@pytest.mark.asyncio
async def test_bridge_apply_trace_sanitizes_large_payload(monkeypatch) -> None:
    from app.features.agent_bridge.service import apply_trace, register_stream
    from app.features.agent_bridge.streams import stream_registry

    sent: list[tuple[str, dict]] = []

    async def fake_broadcast(channel_id: str, message: dict) -> None:
        sent.append((channel_id, message))

    monkeypatch.setattr(
        "app.services.ws_service.ws_manager.broadcast_to_channel",
        fake_broadcast,
    )

    await register_stream(
        msg_id="placeholder-trace-large",
        bot_id="bot-ws-001",
        channel_id="c-001",
        task_id="t-trace",
    )
    try:
        ok = await apply_trace(
            msg_id="placeholder-trace-large",
            bot_id="bot-ws-001",
            payload={
                "task_id": "t-trace",
                "stream": "acp",
                "seq": 3,
                "title": "t" * 300,
                "message": "m" * 1000,
                "data": {
                    "text": "x" * 3000,
                    "image_b64": "a" * 1000,
                    "items": list(range(30)),
                    "nested": {"a": {"b": {"c": {"d": {"e": "deep"}}}}},
                },
            },
        )
        assert ok is True
        payload = sent[0][1]["data"]
        assert payload["title"].endswith("[truncated 60 chars]")
        assert payload["message"].endswith("[truncated 200 chars]")
        assert payload["data"]["text"].endswith("[truncated 2400 chars]")
        assert payload["data"]["image_b64"] == "[omitted 1000 chars from image_b64]"
        assert payload["data"]["items"][-1] == "[omitted 10 items]"
        state = await stream_registry.get("placeholder-trace-large")
        assert state is not None
        assert state.trace_events == [payload]
    finally:
        await stream_registry.pop("placeholder-trace-large")


# --------------------------- PendingReplyRegistry --------------------------

@pytest.mark.asyncio
async def test_pending_registry_register_and_resolve_by_msg() -> None:
    reg = PendingReplyRegistry()
    p = PendingReply(task_id="t1", bot_id="b1", channel_id="c1", msg_id="m1")
    await reg.register(p)
    assert reg.count() == 1

    got = await reg.resolve(task_id=None, bot_id="b1", msg_id="m1")
    assert got is p
    assert reg.count() == 0

    # A second resolve should return None.
    got2 = await reg.resolve(task_id=None, bot_id="b1", msg_id="m1")
    assert got2 is None


@pytest.mark.asyncio
async def test_pending_registry_resolve_by_task_bot() -> None:
    reg = PendingReplyRegistry()
    p = PendingReply(task_id="t1", bot_id="b1", channel_id="c1", msg_id="m1")
    await reg.register(p)

    got = await reg.resolve(task_id="t1", bot_id="b1", msg_id=None)
    assert got is p
    assert reg.count() == 0


@pytest.mark.asyncio
async def test_pending_registry_rejects_cross_bot_resolve_by_msg() -> None:
    """Covers test pending registry rejects cross bot resolve by msg behavior."""
    reg = PendingReplyRegistry()
    p = PendingReply(task_id="t1", bot_id="bot-A", channel_id="c1", msg_id="m1")
    await reg.register(p)
    # bot-B resolving m1 should return None without deleting it.
    got = await reg.resolve(task_id=None, bot_id="bot-B", msg_id="m1")
    assert got is None
    assert reg.count() == 1
    # bot-A can still resolve its own pending entry.
    got = await reg.resolve(task_id=None, bot_id="bot-A", msg_id="m1")
    assert got is p
    assert reg.count() == 0


@pytest.mark.asyncio
async def test_pending_registry_cancels_timeout_on_resolve() -> None:
    reg = PendingReplyRegistry()
    fired = asyncio.Event()
    loop = asyncio.get_event_loop()
    p = PendingReply(task_id="t1", bot_id="b1", channel_id="c1", msg_id="m1")
    p.timeout_handle = loop.call_later(10, lambda: fired.set())  # Long enough not to fire.
    await reg.register(p)

    got = await reg.resolve(task_id=None, bot_id="b1", msg_id="m1")
    assert got is p
    assert p.timeout_handle is not None
    assert p.timeout_handle.cancelled() or not fired.is_set()


@pytest.mark.asyncio
async def test_websocket_timeout_pipeline_converts_placeholder_to_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.db.models import Base
    from app.features.agent_bridge.pending import pending_replies
    from app.features.agent_bridge.service import finalize_bot_reply
    from app.features.bot_runtime.pipeline.bot.task_timeout import (
        AgentBridgeTaskTimeoutContext,
        make_agent_bridge_task_timeout_pipeline,
    )

    sent: list[tuple[str, dict]] = []

    async def fake_broadcast(channel_id: str, message: dict) -> None:
        sent.append((channel_id, message))

    monkeypatch.setattr(
        "app.services.ws_service.ws_manager.broadcast_to_channel",
        fake_broadcast,
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as db_session:
            workspace = Workspace(workspace_id="ws-timeout-task", name="Workspace")
            channel = Channel(
                channel_id="ch-timeout-task",
                workspace_id=workspace.workspace_id,
                name="timeout-task",
            )
            msg = Message(
                msg_id="msg-timeout-task",
                channel_id=channel.channel_id,
                sender_id="bot-ws-001",
                sender_type="bot",
                content="",
                task_id="task-timeout",
                in_reply_to_msg_id="trigger-timeout",
                msg_type="reply",
            )
            db_session.add_all([workspace, channel, msg])
            await db_session.flush()

            await pending_replies.register(
                PendingReply(
                    task_id="task-timeout",
                    bot_id="bot-ws-001",
                    channel_id=channel.channel_id,
                    msg_id=msg.msg_id,
                )
            )
            try:
                timeout_ctx = AgentBridgeTaskTimeoutContext(
                    session=db_session,
                    bot_id="bot-ws-001",
                    channel_id=channel.channel_id,
                    task_id="task-timeout",
                    msg_id=msg.msg_id,
                    timeout_s=60,
                )
                await make_agent_bridge_task_timeout_pipeline().run(timeout_ctx)

                await db_session.refresh(msg)
                assert timeout_ctx.converted is True
                assert msg.content_data is not None
                assert msg.content_data["kind"] == "agent_bridge_background_task"
                assert await pending_replies.peek_by_msg(msg.msg_id) is not None
                assert sent[-1] == (
                    channel.channel_id,
                    {
                        "type": "message_done",
                            "data": {
                                "msg_id": msg.msg_id,
                                "content": "Agent Bridge 已转入后台任务，完成后会自动更新这条回复。",
                                "content_data": msg.content_data,
                            },
                    },
                )

                await finalize_bot_reply(
                    db_session,
                    bot_id="bot-ws-001",
                    channel_id=channel.channel_id,
                    content="最终回复",
                    task_id="task-timeout",
                    reply_to_msg_id=msg.msg_id,
                )
                await db_session.flush()
                await db_session.refresh(msg)

                assert msg.content == "最终回复"
                assert msg.content_data is None
                assert await pending_replies.peek_by_msg(msg.msg_id) is None
                assert sent[-1] == (
                    channel.channel_id,
                    {
                        "type": "message_done",
                            "data": {
                                "msg_id": msg.msg_id,
                                "content": "最终回复",
                                "file_ids": [],
                                "files": [],
                                "content_data": None,
                            },
                    },
                )
            finally:
                await pending_replies.pop_by_msg(msg.msg_id)
    finally:
        await engine.dispose()
