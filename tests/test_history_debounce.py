import asyncio

import pytest

from app.config import settings
from app.features.memory import history_update


@pytest.mark.asyncio
async def test_history_update_debounces_burst_per_channel(monkeypatch) -> None:
    calls: list[str] = []

    async def fake_update(channel_id: str) -> None:
        calls.append(channel_id)

    monkeypatch.setattr(settings, "orchestrator_queue_backend", "memory")
    monkeypatch.setattr(settings, "history_debounce_seconds", 0.01)
    monkeypatch.setattr(history_update, "update_history_async", fake_update)

    await history_update.reset_history_debounce_state()
    for _ in range(5):
        history_update.schedule_history_update("ch-1")

    await asyncio.sleep(0.08)
    assert calls == ["ch-1"]

    await history_update.reset_history_debounce_state()
