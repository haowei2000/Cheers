import asyncio

import pytest

from app.config import settings
from app.services.memory import recent_update


@pytest.mark.asyncio
async def test_recent_update_debounces_burst_per_channel(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_update(channel_id: str) -> None:
        calls.append(channel_id)

    monkeypatch.setattr(settings, "orchestrator_queue_backend", "memory")
    monkeypatch.setattr(settings, "recent_debounce_seconds", 0.01)
    monkeypatch.setattr(recent_update, "update_recent_async", fake_update)

    await recent_update.reset_recent_debounce_state()
    for _ in range(5):
        recent_update.schedule_recent_update("ch-1")

    await asyncio.sleep(0.08)
    assert calls == ["ch-1"]

    await recent_update.reset_recent_debounce_state()
