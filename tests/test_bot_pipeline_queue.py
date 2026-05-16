import asyncio

import pytest

from app.config import settings
from app.features.bot_runtime.pipeline.bot.queue import (
    MemoryBotPipelineQueue,
    BotPipelineJob,
    RedisBotPipelineQueue,
    enqueue_bot_pipeline_job,
    start_bot_pipeline_workers,
    stop_bot_pipeline_workers,
)


@pytest.mark.asyncio
async def test_memory_bot_pipeline_queue_enqueue_ack_retry() -> None:
    queue = MemoryBotPipelineQueue()
    await queue.start()

    job_id = await queue.enqueue(BotPipelineJob(channel_id="ch-1", msg_id="m-1"))
    first = await queue.receive()

    assert first.job.job_id == job_id
    assert first.job.channel_id == "ch-1"
    assert first.job.msg_id == "m-1"
    assert first.job.attempts == 0

    await queue.retry(first, RuntimeError("boom"))
    second = await queue.receive()

    assert second.job.job_id == job_id
    assert second.job.attempts == 1

    await queue.ack(second)


@pytest.mark.asyncio
async def test_memory_bot_pipeline_queue_receive_batch_drains_available() -> None:
    queue = MemoryBotPipelineQueue()
    await queue.start()

    for idx in range(3):
        await queue.enqueue(BotPipelineJob(channel_id="ch-1", msg_id=f"m-{idx}"))

    batch = await queue.receive_batch(max_count=8)

    assert [envelope.job.msg_id for envelope in batch] == ["m-0", "m-1", "m-2"]
    for envelope in batch:
        await queue.ack(envelope)


@pytest.mark.asyncio
async def test_redis_bot_pipeline_queue_reads_configured_batch(monkeypatch) -> None:
    monkeypatch.setattr(settings, "bot_pipeline_redis_read_count", 8)

    class FakeRedis:
        def __init__(self) -> None:
            self.count = None

        async def xreadgroup(self, *args, **kwargs):
            self.count = kwargs["count"]
            return [(
                "stream",
                [
                    ("1-0", {"job_id": "j1", "channel_id": "ch", "msg_id": "m1", "attempts": "0"}),
                    ("1-1", {"job_id": "j2", "channel_id": "ch", "msg_id": "m2", "attempts": "0"}),
                ],
            )]

    redis = FakeRedis()
    queue = RedisBotPipelineQueue()
    queue._redis = redis

    batch = await queue.receive_batch()

    assert redis.count == 8
    assert [envelope.job.msg_id for envelope in batch] == ["m1", "m2"]


@pytest.mark.asyncio
async def test_bot_pipeline_workers_respect_global_concurrency(monkeypatch) -> None:
    await stop_bot_pipeline_workers()
    monkeypatch.setattr(settings, "orchestrator_queue_backend", "memory")
    monkeypatch.setattr(settings, "orchestrator_worker_concurrency", 2)

    active = 0
    max_active = 0
    processed = 0
    lock = asyncio.Lock()
    release = asyncio.Event()
    two_active = asyncio.Event()
    all_processed = asyncio.Event()

    async def handler(channel_id: str, msg_id: str) -> None:
        nonlocal active, max_active, processed
        async with lock:
            active += 1
            max_active = max(max_active, active)
            if active == 2:
                two_active.set()
        await release.wait()
        async with lock:
            active -= 1
            processed += 1
            if processed == 5:
                all_processed.set()

    try:
        await start_bot_pipeline_workers(handler)
        for idx in range(5):
            await enqueue_bot_pipeline_job("ch-1", f"m-{idx}")

        await asyncio.wait_for(two_active.wait(), timeout=1)
        assert max_active == 2

        release.set()
        await asyncio.wait_for(all_processed.wait(), timeout=1)
    finally:
        release.set()
        await stop_bot_pipeline_workers()
