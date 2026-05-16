"""Unit tests for BotSessionRegistry bind/unbind/dispatch and old-connection eviction."""
from __future__ import annotations

from typing import Any

import pytest

from app.features.agent_bridge.registry import BotSessionRegistry


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed = False

    async def send_json(self, data: dict) -> None:
        if self.closed:
            raise RuntimeError("ws already closed")
        self.sent.append(data)


@pytest.mark.asyncio
async def test_bind_control_returns_old_when_replaced() -> None:
    r = BotSessionRegistry()
    ws_a = FakeWS()
    ws_b = FakeWS()

    sess1, old1 = await r.bind_control("bot-1", ws_a)
    assert old1 is None
    assert sess1.control_ws is ws_a

    sess2, old2 = await r.bind_control("bot-1", ws_b)
    # The same session is reused; session_id stays the same and control_ws is replaced.
    assert sess2.session_id == sess1.session_id
    assert sess2.control_ws is ws_b
    assert old2 is ws_a


@pytest.mark.asyncio
async def test_dispatch_control_delivers_to_bound_ws() -> None:
    r = BotSessionRegistry()
    ws = FakeWS()
    await r.bind_control("bot-1", ws)

    ok = await r.dispatch_control("bot-1", {"type": "channel_joined", "channel_id": "C1"})
    assert ok is True
    assert ws.sent == [{"type": "channel_joined", "channel_id": "C1"}]


@pytest.mark.asyncio
async def test_dispatch_control_returns_false_when_unbound() -> None:
    r = BotSessionRegistry()
    ok = await r.dispatch_control("bot-unknown", {"type": "x"})
    assert ok is False


@pytest.mark.asyncio
async def test_connection_state_tracks_control_and_data_planes() -> None:
    r = BotSessionRegistry()
    control = FakeWS()
    data = FakeWS()

    assert r.connection_state("bot-1") == {
        "connection_status": "offline",
        "is_online": False,
        "control_connected": False,
        "data_connected": False,
    }

    await r.bind_control("bot-1", control)
    assert r.connection_state("bot-1") == {
        "connection_status": "partial",
        "is_online": False,
        "control_connected": True,
        "data_connected": False,
    }

    await r.bind_data("bot-1", data)
    assert r.connection_state("bot-1") == {
        "connection_status": "online",
        "is_online": True,
        "control_connected": True,
        "data_connected": True,
    }

    await r.unbind_control("bot-1", control)
    assert r.connection_state("bot-1") == {
        "connection_status": "partial",
        "is_online": False,
        "control_connected": False,
        "data_connected": True,
    }


@pytest.mark.asyncio
async def test_unbind_control_only_clears_matching_ws() -> None:
    """unbind only applies while this ws is current, preserving newer connections."""
    r = BotSessionRegistry()
    ws_a = FakeWS()
    ws_b = FakeWS()
    await r.bind_control("bot-1", ws_a)
    # A new connection arrives, so ws_b becomes current.
    await r.bind_control("bot-1", ws_b)
    # The old ws unbind must not clear ws_b.
    await r.unbind_control("bot-1", ws_a)
    sess = r.get("bot-1")
    assert sess is not None
    assert sess.control_ws is ws_b


@pytest.mark.asyncio
async def test_unbind_control_with_matching_ws_removes_session() -> None:
    r = BotSessionRegistry()
    ws = FakeWS()
    await r.bind_control("bot-1", ws)
    await r.unbind_control("bot-1", ws)
    assert r.get("bot-1") is None
    assert r.session_count() == 0
