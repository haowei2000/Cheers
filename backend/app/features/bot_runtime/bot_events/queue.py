"""Bot event queue with memory and Redis Stream backends.

This queue handles second-phase bot lifecycle events, such as an Agent Bridge
provider finishing a previously-dispatched async bot reply. User messages
remain synchronously persisted; this queue is for bot completion work.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
import uuid
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

from app.config import settings

logger = logging.getLogger("app.features.bot_runtime.bot_events.queue")

_STREAM_KEY = "agentnexus:queue:bot-events"
_GROUP = "agentnexus-bot-events"
_MAX_ATTEMPTS = 3
_PENDING_IDLE_MS = 300_000
_XREAD_BLOCK_MS = 5_000
_REDIS_SOCKET_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class BotEventJob:
    event_type: str
    payload: dict[str, Any] = field(default_factory=dict)
    job_id: str = ""
    attempts: int = 0

    def with_defaults(self) -> "BotEventJob":
        if self.job_id:
            return self
        return replace(self, job_id=str(uuid.uuid4()))


@dataclass(frozen=True)
class BotEventEnvelope:
    job: BotEventJob
    raw_id: Any = None


class BotEventQueue(Protocol):
    async def start(self) -> None: ...
    async def close(self) -> None: ...
    async def enqueue(self, job: BotEventJob) -> str: ...
    async def receive(self) -> BotEventEnvelope: ...
    async def receive_batch(self, max_count: int | None = None) -> list[BotEventEnvelope]: ...
    async def ack(self, envelope: BotEventEnvelope) -> None: ...
    async def retry(self, envelope: BotEventEnvelope, exc: BaseException) -> None: ...


class MemoryBotEventQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[BotEventJob] = asyncio.Queue()

    async def start(self) -> None:
        return

    async def close(self) -> None:
        return

    async def enqueue(self, job: BotEventJob) -> str:
        job = job.with_defaults()
        await self._queue.put(job)
        return job.job_id

    async def receive(self) -> BotEventEnvelope:
        return BotEventEnvelope(job=await self._queue.get())

    async def receive_batch(self, max_count: int | None = None) -> list[BotEventEnvelope]:
        first = await self.receive()
        envelopes = [first]
        limit = max(1, int(max_count or 1))
        for _ in range(limit - 1):
            try:
                envelopes.append(BotEventEnvelope(job=self._queue.get_nowait()))
            except asyncio.QueueEmpty:
                break
        return envelopes

    async def ack(self, envelope: BotEventEnvelope) -> None:
        self._queue.task_done()

    async def retry(self, envelope: BotEventEnvelope, exc: BaseException) -> None:
        self._queue.task_done()
        job = envelope.job
        if job.attempts + 1 >= _MAX_ATTEMPTS:
            logger.error(
                "bot_event_queue.memory: dropping job event_type=%s attempts=%d",
                job.event_type, job.attempts + 1,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            return
        await self.enqueue(replace(job, attempts=job.attempts + 1))


class RedisBotEventQueue:
    def __init__(self) -> None:
        self._consumer = f"{uuid.uuid4().hex}-{int(time.time())}"
        self._redis = None

    async def start(self) -> None:
        import redis.asyncio as redis

        self._redis = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1.0,
            socket_timeout=_REDIS_SOCKET_TIMEOUT_SECONDS,
        )
        pong = self._redis.ping()
        if inspect.isawaitable(pong):
            await pong
        try:
            await self._redis.xgroup_create(_STREAM_KEY, _GROUP, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    async def enqueue(self, job: BotEventJob) -> str:
        if self._redis is None:
            raise RuntimeError("RedisBotEventQueue not started")
        job = job.with_defaults()
        await self._redis.xadd(
            _STREAM_KEY,
            {
                "job_id": job.job_id,
                "event_type": job.event_type,
                "payload": json.dumps(job.payload, ensure_ascii=False),
                "attempts": str(job.attempts),
            },
        )
        return job.job_id

    async def receive(self) -> BotEventEnvelope:
        return (await self.receive_batch(max_count=1))[0]

    async def receive_batch(self, max_count: int | None = None) -> list[BotEventEnvelope]:
        if self._redis is None:
            raise RuntimeError("RedisBotEventQueue not started")
        limit = max(1, int(max_count or settings.bot_event_redis_read_count or 1))
        while True:
            claimed = await self._claim_stale_pending(limit)
            if claimed:
                return claimed
            rows = await self._redis.xreadgroup(
                _GROUP,
                self._consumer,
                streams={_STREAM_KEY: ">"},
                count=limit,
                block=_XREAD_BLOCK_MS,
            )
            if not rows:
                continue
            _stream, messages = rows[0]
            return [
                BotEventEnvelope(job=_job_from_fields(fields), raw_id=raw_id)
                for raw_id, fields in messages
            ]

    async def _claim_stale_pending(self, max_count: int) -> list[BotEventEnvelope]:
        if self._redis is None:
            return []
        try:
            claimed = await self._redis.xautoclaim(
                _STREAM_KEY,
                _GROUP,
                self._consumer,
                min_idle_time=_PENDING_IDLE_MS,
                start_id="0-0",
                count=max_count,
            )
        except Exception as exc:
            logger.debug("bot_event_queue.redis: pending reclaim failed: %s", exc)
            return []
        messages = []
        if isinstance(claimed, (list, tuple)) and len(claimed) >= 2:
            messages = claimed[1] or []
        if not messages:
            return []
        return [
            BotEventEnvelope(job=_job_from_fields(fields), raw_id=raw_id)
            for raw_id, fields in messages
        ]

    async def ack(self, envelope: BotEventEnvelope) -> None:
        if self._redis is not None and envelope.raw_id is not None:
            await self._redis.xack(_STREAM_KEY, _GROUP, envelope.raw_id)

    async def retry(self, envelope: BotEventEnvelope, exc: BaseException) -> None:
        job = envelope.job
        if job.attempts + 1 < _MAX_ATTEMPTS:
            await self.enqueue(replace(job, attempts=job.attempts + 1))
        else:
            logger.error(
                "bot_event_queue.redis: dropping job event_type=%s attempts=%d",
                job.event_type, job.attempts + 1,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
        await self.ack(envelope)


def _job_from_fields(fields: dict[str, Any]) -> BotEventJob:
    raw_attempts = fields.get("attempts") or 0
    try:
        attempts = int(raw_attempts)
    except (TypeError, ValueError):
        attempts = 0
    payload_raw = fields.get("payload") or "{}"
    try:
        payload = json.loads(payload_raw) if isinstance(payload_raw, str) else {}
    except json.JSONDecodeError:
        payload = {}
    return BotEventJob(
        job_id=str(fields.get("job_id") or uuid.uuid4()),
        event_type=str(fields.get("event_type") or ""),
        payload=payload if isinstance(payload, dict) else {},
        attempts=attempts,
    )


_queue: BotEventQueue = MemoryBotEventQueue()
_worker_tasks: list[asyncio.Task] = []
_handler = None


def get_bot_event_queue() -> BotEventQueue:
    return _queue


async def init_bot_event_queue() -> BotEventQueue:
    global _queue
    backend = (
        getattr(settings, "bot_event_queue_backend", "")
        or settings.orchestrator_queue_backend
        or "redis"
    ).strip().lower()
    if backend == "redis":
        q = RedisBotEventQueue()
        try:
            await q.start()
            _queue = q
            logger.info("bot_event_queue: using redis backend")
            return _queue
        except Exception as exc:
            logger.warning("bot_event_queue: redis unavailable, falling back to memory: %s", exc)
            await q.close()
    _queue = MemoryBotEventQueue()
    await _queue.start()
    logger.info("bot_event_queue: using memory backend")
    return _queue


async def start_bot_event_workers(handler) -> None:
    global _handler
    _handler = handler
    if _worker_tasks:
        return
    await init_bot_event_queue()
    concurrency = max(1, int(getattr(settings, "bot_event_worker_concurrency", 1) or 1))
    for idx in range(concurrency):
        _worker_tasks.append(asyncio.create_task(_worker_loop(idx)))
    logger.info("bot_event_queue: started %d worker(s)", concurrency)


async def stop_bot_event_workers() -> None:
    global _handler
    for task in list(_worker_tasks):
        task.cancel()
    for task in list(_worker_tasks):
        try:
            await task
        except asyncio.CancelledError:
            pass
    _worker_tasks.clear()
    _handler = None
    await _queue.close()


async def _worker_loop(index: int) -> None:
    while True:
        try:
            envelopes = await _queue.receive_batch()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("bot_event_worker[%d]: receive failed; retrying", index)
            await asyncio.sleep(1.0)
            continue
        for envelope in envelopes:
            try:
                if _handler is None:
                    raise RuntimeError("bot event worker handler is not configured")
                await _handler(envelope.job)
                await _queue.ack(envelope)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception(
                    "bot_event_worker[%d]: job failed event_type=%s job_id=%s",
                    index, envelope.job.event_type, envelope.job.job_id,
                )
                await _queue.retry(envelope, exc)


async def enqueue_bot_event_job(event_type: str, payload: dict[str, Any]) -> str:
    if not _worker_tasks:
        from app.features.bot_runtime.bot_events.jobs import run_bot_event_job

        await start_bot_event_workers(run_bot_event_job)
    return await _queue.enqueue(BotEventJob(event_type=event_type, payload=payload))
