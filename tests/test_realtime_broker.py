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
