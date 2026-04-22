"""BotSessionRegistry 单元测试：bind/unbind/dispatch + 旧连接被踢行为。"""
from __future__ import annotations

from typing import Any

import pytest

from app.services.openclaw_bridge.registry import BotSessionRegistry


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
    # 同一 session 被复用（session_id 不变），control_ws 替换
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
async def test_unbind_control_only_clears_matching_ws() -> None:
    """unbind 只在当前仍是此 ws 时生效，避免踢掉后到的新连接。"""
    r = BotSessionRegistry()
    ws_a = FakeWS()
    ws_b = FakeWS()
    await r.bind_control("bot-1", ws_a)
    # 新连接来了（ws_b 成为当前）
    await r.bind_control("bot-1", ws_b)
    # 旧 ws 的 unbind 不应把 ws_b 清掉
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
