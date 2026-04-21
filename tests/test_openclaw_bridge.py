"""OpenClaw bridge 单元测试：dispatcher、pending registry、WebsocketBotAdapter.execute()."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services.adapters.base import AgentPayload
from app.services.adapters.websocket_bot import WebsocketBotAdapter
from app.services.openclaw_bridge.dispatcher import BridgeDispatcher, bridge_dispatcher
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


def _payload(task_id: str = "t-ws-001") -> AgentPayload:
    return AgentPayload(
        task_id=task_id,
        channel_id="c-001",
        trigger_message={"user": "u1", "text": "@ws-bot hi", "timestamp": "2026-04-21T00:00:00Z"},
        memory_context={"anchor": "", "decisions": "", "files_index": "", "recent": ""},
    )


# --------------------------- BridgeDispatcher ------------------------------

@pytest.mark.asyncio
async def test_dispatcher_publish_delivers_to_subscribers() -> None:
    d = BridgeDispatcher()
    q1 = await d.subscribe()
    q2 = await d.subscribe()

    delivered = await d.publish({"type": "dispatch", "bot_id": "b1"})
    assert delivered == 2
    assert q1.get_nowait()["bot_id"] == "b1"
    assert q2.get_nowait()["bot_id"] == "b1"

    await d.unsubscribe(q1)
    delivered = await d.publish({"type": "dispatch", "bot_id": "b2"})
    assert delivered == 1
    assert q2.get_nowait()["bot_id"] == "b2"


@pytest.mark.asyncio
async def test_dispatcher_publish_zero_when_no_subscribers() -> None:
    d = BridgeDispatcher()
    delivered = await d.publish({"type": "dispatch"})
    assert delivered == 0


# --------------------------- WebsocketBotAdapter ---------------------------

@pytest.mark.asyncio
async def test_ws_bot_adapter_dispatches_and_returns_async_flag() -> None:
    # 订阅全局 dispatcher 以接收事件
    q = await bridge_dispatcher.subscribe()
    try:
        adapter = WebsocketBotAdapter(_fake_bot())
        resp = await adapter.execute(_payload("t-ws-001"))

        assert resp.success is True
        assert resp.dispatched_async is True
        assert resp.content == ""

        event = q.get_nowait()
        assert event["type"] == "dispatch"
        assert event["bot_id"] == "bot-ws-001"
        assert event["bot_username"] == "ws-bot"
        assert event["channel_id"] == "c-001"
        assert event["task_id"] == "t-ws-001"
        assert event["binding_config"] == {"agent_id": "agent-x"}
    finally:
        await bridge_dispatcher.unsubscribe(q)


@pytest.mark.asyncio
async def test_ws_bot_adapter_no_subscribers_returns_failure() -> None:
    # 确保没有订阅者
    assert bridge_dispatcher.subscriber_count() == 0

    adapter = WebsocketBotAdapter(_fake_bot(display_name="Alpha"))
    resp = await adapter.execute(_payload())
    assert resp.success is False
    assert resp.dispatched_async is False
    assert resp.error_message == "no_plugin_subscribers"
    assert "Alpha" in resp.content


@pytest.mark.asyncio
async def test_ws_bot_adapter_health_check_reflects_subscribers() -> None:
    adapter = WebsocketBotAdapter(_fake_bot())
    assert bridge_dispatcher.subscriber_count() == 0
    assert await adapter.health_check() is False
    q = await bridge_dispatcher.subscribe()
    try:
        assert await adapter.health_check() is True
    finally:
        await bridge_dispatcher.unsubscribe(q)


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
async def test_pending_registry_cancels_timeout_on_resolve() -> None:
    reg = PendingReplyRegistry()
    fired = asyncio.Event()
    loop = asyncio.get_event_loop()
    p = PendingReply(task_id="t1", bot_id="b1", channel_id="c1", msg_id="m1")
    p.timeout_handle = loop.call_later(10, lambda: fired.set())  # 很长，不会触发
    await reg.register(p)

    got = await reg.resolve(task_id=None, bot_id="b1", msg_id="m1")
    assert got is p
    # timeout 应已取消
    assert p.timeout_handle is not None
    assert p.timeout_handle.cancelled() or not fired.is_set()
