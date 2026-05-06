import asyncio

import pytest

from app.config import settings
from app.services.orchestrator.queue import (
    MemoryOrchestratorQueue,
    OrchestratorJob,
    enqueue_orchestrator_job,
    start_orchestrator_workers,
    stop_orchestrator_workers,
)


@pytest.mark.asyncio
async def test_memory_orchestrator_queue_enqueue_ack_retry() -> None:
    queue = MemoryOrchestratorQueue()
    await queue.start()

    job_id = await queue.enqueue(OrchestratorJob(channel_id="ch-1", msg_id="m-1"))
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
async def test_orchestrator_workers_respect_global_concurrency(monkeypatch) -> None:
    await stop_orchestrator_workers()
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
        await start_orchestrator_workers(handler)
        for idx in range(5):
            await enqueue_orchestrator_job("ch-1", f"m-{idx}")

        await asyncio.wait_for(two_active.wait(), timeout=1)
        assert max_active == 2

        release.set()
        await asyncio.wait_for(all_processed.wait(), timeout=1)
    finally:
        release.set()
        await stop_orchestrator_workers()
