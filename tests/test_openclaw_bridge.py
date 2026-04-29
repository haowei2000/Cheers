"""OpenClaw bridge 单元测试：dispatcher、pending registry、WebsocketBotAdapter.execute()."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services.adapters.base import AgentPayload
from app.services.adapters.websocket_bot import WebsocketBotAdapter
from app.services.openclaw_bridge.dispatcher import BridgeDispatcher
from app.services.openclaw_bridge.pending import PendingReply, PendingReplyRegistry


def _fake_bot(**kwargs):
    defaults = dict(
        bot_id="bot-ws-001",
        username="ws-bot",
        display_name="WS Bot",
        status="online",
        binding_type="websocket",
        binding_config={"agent_id": "agent-x"},
        ai_model=None,
        prompt_template=None,
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


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


# --------------------------- WebsocketBotAdapter ---------------------------

class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


@pytest.mark.asyncio
async def test_ws_bot_adapter_dispatches_via_registry_when_data_ws_bound() -> None:
    from app.services.openclaw_bridge.pending import pending_replies
    from app.services.openclaw_bridge.registry import bot_session_registry

    ws = _FakeWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        adapter = WebsocketBotAdapter(_fake_bot())
        payload = _payload("t-ws-001")
        # 模拟 orchestrator：把占位 msg_id 放到 process_config
        payload.process_config.placeholder_msg_id = "placeholder-123"

        resp = await adapter.execute(payload)
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
async def test_ws_bot_adapter_returns_failure_when_no_data_ws() -> None:
    from app.services.openclaw_bridge.pending import pending_replies

    adapter = WebsocketBotAdapter(_fake_bot(display_name="Alpha"))
    payload = _payload()
    payload.process_config.placeholder_msg_id = "placeholder-fail-001"
    resp = await adapter.execute(payload)
    assert resp.success is False
    assert resp.dispatched_async is False
    assert resp.error_message == "no_plugin_subscribers"
    assert "Alpha" in resp.content
    # 失败路径应回滚预登记
    assert await pending_replies.peek_by_msg("placeholder-fail-001") is None


@pytest.mark.asyncio
async def test_ws_bot_adapter_ignores_irrelevant_bot_session() -> None:
    """别的 bot 连上不会让本 bot 的 adapter 误认为在线。"""
    from app.services.openclaw_bridge.registry import bot_session_registry

    other = _FakeWS()
    await bot_session_registry.bind_data("some-other-bot", other)  # type: ignore[arg-type]
    try:
        adapter = WebsocketBotAdapter(_fake_bot())
        resp = await adapter.execute(_payload())
        assert resp.success is False
        assert other.sent == []
    finally:
        await bot_session_registry.unbind_data("some-other-bot", other)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_ws_bot_adapter_health_check_reflects_data_ws() -> None:
    from app.services.openclaw_bridge.registry import bot_session_registry

    adapter = WebsocketBotAdapter(_fake_bot())
    assert await adapter.health_check() is False

    ws = _FakeWS()
    await bot_session_registry.bind_data("bot-ws-001", ws)  # type: ignore[arg-type]
    try:
        assert await adapter.health_check() is True
    finally:
        await bot_session_registry.unbind_data("bot-ws-001", ws)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_bridge_apply_trace_broadcasts_registered_stream(monkeypatch) -> None:
    from app.services.openclaw_bridge.service import apply_trace, register_stream
    from app.services.openclaw_bridge.streams import stream_registry

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
