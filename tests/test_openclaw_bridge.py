"""Agent Bridge 单元测试：dispatcher、pending registry、AgentBridgeBotAdapter.execute()."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )


# --------------------------- BridgeDispatcher ------------------------------

@pytest.mark.asyncio
async def test_dispatcher_publish_filters_by_bot_ids() -> None:
    d = BridgeDispatcher()
    sub_a = await d.subscribe(bot_ids=["bot-A"])
    sub_b = await d.subscribe(bot_ids=["bot-B"])
    sub_all = await d.subscribe(bot_ids=None)  # 调试/内部：收全量

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
    """握手中间态：已连但还没声明 bot_ids 的订阅者不收任何事件。"""
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
        # 模拟 orchestrator：把占位 msg_id 放到 process_config
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

        # adapter 预登记了 pending（便于 plugin 秒回时定位）
        pending = await pending_replies.peek_by_msg("placeholder-123")
        assert pending is not None
        assert pending.bot_id == "bot-ws-001"
        assert pending.channel_id == "c-001"
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]
        # 清理：pop 掉预登记的 pending
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
        assert "=== 频道记忆上下文" in rendered_text
        assert "WebSocket 锚点" in rendered_text
        assert "任务：@ws-bot hi" in rendered_text
        assert event["raw_trigger_message"]["text"] == "@ws-bot hi"
        assert event["prompt"]["user"] == rendered_text
        assert "WebSocket 系统提示" in event["prompt"]["system"]
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]
        await pending_replies.pop_by_msg("placeholder-template")


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
    # 失败路径应回滚预登记
    assert await pending_replies.peek_by_msg("placeholder-fail-001") is None


@pytest.mark.asyncio
async def test_ws_bot_adapter_does_not_create_session_when_no_data_ws(
    db_session: AsyncSession,
) -> None:
    adapter = AgentBridgeBotAdapter(_fake_bot())
    payload = _payload()
    payload.process_config.placeholder_msg_id = "placeholder-no-ws-session"
    payload.process_config.db_session = db_session

    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)

    assert resp.success is False
    count = (
        await db_session.execute(select(func.count()).select_from(AgentNexusSession))
    ).scalar_one()
    assert count == 0


@pytest.mark.asyncio
async def test_ws_bot_adapter_ignores_irrelevant_bot_session() -> None:
    """别的 bot 连上不会让本 bot 的 adapter 误认为在线。"""
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

    # 再次 resolve 应为 None
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
    """plugin 用 bot-A 的连接不能 finalize bot-B 的占位消息（msg_id 相同也不行）。"""
    reg = PendingReplyRegistry()
    p = PendingReply(task_id="t1", bot_id="bot-A", channel_id="c1", msg_id="m1")
    await reg.register(p)
    # bot-B 试图用 m1 resolve → 应返回 None 且不删除
    got = await reg.resolve(task_id=None, bot_id="bot-B", msg_id="m1")
    assert got is None
    assert reg.count() == 1
    # bot-A 自己来 resolve 仍正常
    got = await reg.resolve(task_id=None, bot_id="bot-A", msg_id="m1")
    assert got is p
    assert reg.count() == 0


@pytest.mark.asyncio
async def test_pending_registry_cancels_timeout_on_resolve() -> None:
    reg = PendingReplyRegistry()
    fired = asyncio.Event()
    loop = asyncio.get_event_loop()
    p = PendingReply(task_id="t1", bot_id="b1", channel_id="c1", msg_id="m1")
    p.timeout_handle = loop.call_later(10, lambda: fired.set())  # 很长，不会触发
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
