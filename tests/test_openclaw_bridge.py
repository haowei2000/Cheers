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

@pytest.mark.asyncio
async def test_ws_bot_adapter_dispatches_to_matching_subscriber_only() -> None:
    sub_target = await bridge_dispatcher.subscribe(bot_ids=["bot-ws-001"])
    sub_other = await bridge_dispatcher.subscribe(bot_ids=["bot-other"])
    try:
        adapter = WebsocketBotAdapter(_fake_bot())
        resp = await adapter.execute(_payload("t-ws-001"))

        assert resp.success is True
        assert resp.dispatched_async is True
        assert resp.content == ""

        event = sub_target.queue.get_nowait()
        assert event["type"] == "dispatch"
        assert event["bot_id"] == "bot-ws-001"
        assert event["channel_id"] == "c-001"
        assert event["task_id"] == "t-ws-001"
        assert event["binding_config"] == {"agent_id": "agent-x"}

        # 非目标订阅者不应收到事件
        assert sub_other.queue.empty()
    finally:
        await bridge_dispatcher.unsubscribe(sub_target)
        await bridge_dispatcher.unsubscribe(sub_other)


@pytest.mark.asyncio
async def test_ws_bot_adapter_no_matching_subscriber_returns_failure() -> None:
    """订阅者不关心本 Bot 时，视为无 plugin 在线。"""
    sub_unrelated = await bridge_dispatcher.subscribe(bot_ids=["different-bot"])
    try:
        adapter = WebsocketBotAdapter(_fake_bot(display_name="Alpha"))
        resp = await adapter.execute(_payload())
        assert resp.success is False
        assert resp.dispatched_async is False
        assert resp.error_message == "no_plugin_subscribers"
        assert "Alpha" in resp.content
        assert sub_unrelated.queue.empty()
    finally:
        await bridge_dispatcher.unsubscribe(sub_unrelated)


@pytest.mark.asyncio
async def test_ws_bot_adapter_no_subscribers_returns_failure() -> None:
    adapter = WebsocketBotAdapter(_fake_bot(display_name="Alpha"))
    resp = await adapter.execute(_payload())
    assert resp.success is False
    assert resp.dispatched_async is False
    assert resp.error_message == "no_plugin_subscribers"


@pytest.mark.asyncio
async def test_ws_bot_adapter_health_check_reflects_subscribers() -> None:
    adapter = WebsocketBotAdapter(_fake_bot())
    assert await adapter.health_check() is False
    sub = await bridge_dispatcher.subscribe(bot_ids=["bot-ws-001"])
    try:
        assert await adapter.health_check() is True
    finally:
        await bridge_dispatcher.unsubscribe(sub)


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
    assert p.timeout_handle is not None
    assert p.timeout_handle.cancelled() or not fired.is_set()
