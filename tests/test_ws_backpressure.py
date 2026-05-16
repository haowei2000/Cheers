import asyncio
import json

import pytest

from app.config import settings
from app.services import ws_service
from app.services.ws_service import ConnectionManager


class _FastWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.closed = False
        self.sent: list[dict] = []

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, data: str) -> None:
        self.sent.append(json.loads(data))

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True


class _SlowWebSocket:
    def __init__(self) -> None:
        self.accepted = False
        self.closed = False
        self.sent: list[dict] = []
        self.send_started = asyncio.Event()
        self.release_send = asyncio.Event()

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)
        self.send_started.set()
        await self.release_send.wait()

    async def send_text(self, data: str) -> None:
        self.sent.append(json.loads(data))
        self.send_started.set()
        await self.release_send.wait()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True
        self.close_code = code
        self.close_reason = reason


class _SlowClosingWebSocket(_SlowWebSocket):
    def __init__(self, tracker: dict[str, int]) -> None:
        super().__init__()
        self.tracker = tracker

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.tracker["active"] += 1
        self.tracker["max_active"] = max(self.tracker["max_active"], self.tracker["active"])
        try:
            await asyncio.sleep(0.05)
            await super().close(code=code, reason=reason)
        finally:
            self.tracker["active"] -= 1


@pytest.mark.asyncio
async def test_ws_outbound_queue_closes_slow_client(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ws_outbound_queue_size", 1)
    monkeypatch.setattr(settings, "ws_send_timeout_seconds", 10.0)

    manager = ConnectionManager()
    ws = _SlowWebSocket()
    await manager.connect(ws, "ch-1")

    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 1}})
    await asyncio.wait_for(ws.send_started.wait(), timeout=1)
    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 2}})
    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 3}})

    assert ws.closed is True

    ws.release_send.set()
    await manager.disconnect(ws, "ch-1")


@pytest.mark.asyncio
async def test_ws_broadcast_closes_full_clients_concurrently(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ws_outbound_queue_size", 1)
    monkeypatch.setattr(settings, "ws_broadcast_enqueue_concurrency", 3)
    monkeypatch.setattr(settings, "ws_send_timeout_seconds", 10.0)

    manager = ConnectionManager()
    tracker = {"active": 0, "max_active": 0}
    sockets = [_SlowClosingWebSocket(tracker) for _ in range(3)]
    for ws in sockets:
        await manager.connect(ws, "ch-1")

    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 1}})
    for ws in sockets:
        await asyncio.wait_for(ws.send_started.wait(), timeout=1)
    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 2}})
    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 3}})

    assert all(ws.closed for ws in sockets)
    assert tracker["max_active"] == 3
    assert "ch-1" not in manager._channel_connections

    for ws in sockets:
        ws.release_send.set()
        await manager.disconnect(ws, "ch-1")


@pytest.mark.asyncio
async def test_ws_broadcast_serializes_payload_once(monkeypatch) -> None:
    calls = 0
    original = ws_service._serialize_ws_message

    def counted(message: dict):
        nonlocal calls
        calls += 1
        return original(message)

    monkeypatch.setattr(ws_service, "_serialize_ws_message", counted)

    manager = ConnectionManager()
    sockets = [_FastWebSocket(), _FastWebSocket()]
    for ws in sockets:
        await manager.connect(ws, "ch-1")

    message = {"type": "message", "data": {"text": "你好"}}
    await manager.broadcast_to_channel("ch-1", message)
    await asyncio.wait_for(_wait_until(lambda: all(ws.sent for ws in sockets)), timeout=1)

    assert calls == 1
    assert [ws.sent[0] for ws in sockets] == [message, message]

    for ws in sockets:
        await manager.disconnect(ws, "ch-1")


@pytest.mark.asyncio
async def test_ws_send_timeout_removes_slow_client(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ws_outbound_queue_size", 4)
    monkeypatch.setattr(settings, "ws_send_timeout_seconds", 0.01)

    manager = ConnectionManager()
    ws = _SlowWebSocket()
    await manager.connect(ws, "ch-1")

    await manager.broadcast_to_channel("ch-1", {"type": "message", "data": {"n": 1}})
    await asyncio.wait_for(ws.send_started.wait(), timeout=1)
    await asyncio.wait_for(_wait_until(lambda: ws.closed), timeout=1)

    assert ws.close_code == 1011
    assert "ch-1" not in manager._channel_connections


async def _wait_until(predicate, interval: float = 0.005) -> None:
    while not predicate():
        await asyncio.sleep(interval)
