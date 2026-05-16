import asyncio

import pytest

from app.services import realtime_broker
from app.services.realtime_broker import RedisRealtimeBroker


@pytest.mark.asyncio
async def test_redis_broker_publish_failure_keeps_local_delivery(monkeypatch) -> None:
    delivered: list[tuple[str, dict]] = []

    async def fake_deliver(channel_id: str, message: dict) -> None:
        delivered.append((channel_id, message))

    class FailingRedis:
        async def publish(self, topic: str, payload: str) -> None:
            raise RuntimeError("redis down")

    broker = RedisRealtimeBroker()
    broker._redis = FailingRedis()
    monkeypatch.setattr(realtime_broker, "_deliver_channel_local", fake_deliver)

    frame = {"type": "message", "data": {"n": 1}}
    await broker.publish_channel("ch-1", frame)

    assert delivered == [("ch-1", frame)]


@pytest.mark.asyncio
async def test_redis_broker_publish_runs_in_parallel_with_local_delivery(monkeypatch) -> None:
    delivered: list[tuple[str, dict]] = []
    local_started = asyncio.Event()
    release_local = asyncio.Event()
    publish_started = asyncio.Event()

    async def fake_deliver(channel_id: str, message: dict) -> None:
        local_started.set()
        await release_local.wait()
        delivered.append((channel_id, message))

    class RecordingRedis:
        async def publish(self, topic: str, payload: str) -> None:
            publish_started.set()

    broker = RedisRealtimeBroker()
    broker._redis = RecordingRedis()
    monkeypatch.setattr(realtime_broker, "_deliver_channel_local", fake_deliver)

    frame = {"type": "message", "data": {"n": 1}}
    task = asyncio.create_task(broker.publish_channel("ch-1", frame))
    try:
        await asyncio.wait_for(local_started.wait(), timeout=1)
        await asyncio.wait_for(publish_started.wait(), timeout=1)
        assert not task.done()
    finally:
        release_local.set()
        await task

    assert delivered == [("ch-1", frame)]
