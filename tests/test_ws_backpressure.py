import asyncio

import pytest

from app.config import settings
from app.services.ws_service import ConnectionManager


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

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True
        self.close_code = code
        self.close_reason = reason


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
