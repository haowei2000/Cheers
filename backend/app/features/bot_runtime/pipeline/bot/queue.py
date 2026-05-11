"""Bot pipeline job queue with memory and Redis Stream backends."""
from __future__ import annotations

import asyncio
import inspect
import logging
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any, Protocol

from app.config import settings

logger = logging.getLogger("app.features.bot_runtime.pipeline.bot.queue")

_STREAM_KEY = "agentnexus:bot_pipeline:jobs"
_GROUP = "agentnexus-backend"
_MAX_ATTEMPTS = 3


@dataclass(frozen=True)
class BotPipelineJob:
    channel_id: str
    msg_id: str
    job_id: str = ""
    attempts: int = 0

    def with_defaults(self) -> "BotPipelineJob":
        if self.job_id:
            return self
        return replace(self, job_id=str(uuid.uuid4()))


@dataclass(frozen=True)
class JobEnvelope:
    job: BotPipelineJob
    raw_id: Any = None


class BotPipelineQueue(Protocol):
    async def start(self) -> None: ...
    async def close(self) -> None: ...
    async def enqueue(self, job: BotPipelineJob) -> str: ...
    async def receive(self) -> JobEnvelope: ...
    async def ack(self, envelope: JobEnvelope) -> None: ...
    async def retry(self, envelope: JobEnvelope, exc: BaseException) -> None: ...


class MemoryBotPipelineQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[BotPipelineJob] = asyncio.Queue()

    async def start(self) -> None:
        return

    async def close(self) -> None:
        return

    async def enqueue(self, job: BotPipelineJob) -> str:
        job = job.with_defaults()
        await self._queue.put(job)
        return job.job_id

    async def receive(self) -> JobEnvelope:
        return JobEnvelope(job=await self._queue.get())

    async def ack(self, envelope: JobEnvelope) -> None:
        self._queue.task_done()

    async def retry(self, envelope: JobEnvelope, exc: BaseException) -> None:
        self._queue.task_done()
        job = envelope.job
        if job.attempts + 1 >= _MAX_ATTEMPTS:
            logger.error(
                "bot_pipeline_queue.memory: dropping job channel_id=%s msg_id=%s attempts=%d",
                job.channel_id, job.msg_id, job.attempts + 1,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            return
        await self.enqueue(replace(job, attempts=job.attempts + 1))


class RedisBotPipelineQueue:
    def __init__(self) -> None:
        self._consumer = f"{uuid.uuid4().hex}-{int(time.time())}"
        self._redis = None

    async def start(self) -> None:
        import redis.asyncio as redis

        self._redis = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1.0,
            socket_timeout=10.0,
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

    async def enqueue(self, job: BotPipelineJob) -> str:
        if self._redis is None:
            raise RuntimeError("RedisBotPipelineQueue not started")
        job = job.with_defaults()
        await self._redis.xadd(
            _STREAM_KEY,
            {
                "job_id": job.job_id,
                "channel_id": job.channel_id,
                "msg_id": job.msg_id,
                "attempts": str(job.attempts),
            },
        )
        return job.job_id

    async def receive(self) -> JobEnvelope:
        if self._redis is None:
            raise RuntimeError("RedisBotPipelineQueue not started")
        while True:
            rows = await self._redis.xreadgroup(
                _GROUP,
                self._consumer,
                streams={_STREAM_KEY: ">"},
                count=1,
                block=5000,
            )
            if not rows:
                continue
            _stream, messages = rows[0]
            raw_id, fields = messages[0]
            return JobEnvelope(job=_job_from_fields(fields), raw_id=raw_id)

    async def ack(self, envelope: JobEnvelope) -> None:
        if self._redis is not None and envelope.raw_id is not None:
            await self._redis.xack(_STREAM_KEY, _GROUP, envelope.raw_id)

    async def retry(self, envelope: JobEnvelope, exc: BaseException) -> None:
        job = envelope.job
        if job.attempts + 1 < _MAX_ATTEMPTS:
            await self.enqueue(replace(job, attempts=job.attempts + 1))
        else:
            logger.error(
                "bot_pipeline_queue.redis: dropping job channel_id=%s msg_id=%s attempts=%d",
                job.channel_id, job.msg_id, job.attempts + 1,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
        await self.ack(envelope)


def _job_from_fields(fields: dict[str, Any]) -> BotPipelineJob:
    raw_attempts = fields.get("attempts") or 0
    try:
        attempts = int(raw_attempts)
    except (TypeError, ValueError):
        attempts = 0
    return BotPipelineJob(
        job_id=str(fields.get("job_id") or uuid.uuid4()),
        channel_id=str(fields.get("channel_id") or ""),
        msg_id=str(fields.get("msg_id") or ""),
        attempts=attempts,
    )


_queue: BotPipelineQueue = MemoryBotPipelineQueue()
_worker_tasks: list[asyncio.Task] = []
_handler = None


def get_bot_pipeline_queue() -> BotPipelineQueue:
    return _queue


async def init_bot_pipeline_queue() -> BotPipelineQueue:
    global _queue
    backend = (settings.orchestrator_queue_backend or "redis").strip().lower()
    if backend == "redis":
        q = RedisBotPipelineQueue()
        try:
            await q.start()
            _queue = q
            logger.info("bot_pipeline_queue: using redis backend")
            return _queue
        except Exception as exc:
            logger.warning("bot_pipeline_queue: redis unavailable, falling back to memory: %s", exc)
            await q.close()
    _queue = MemoryBotPipelineQueue()
    await _queue.start()
    logger.info("bot_pipeline_queue: using memory backend")
    return _queue


async def start_bot_pipeline_workers(handler) -> None:
    global _handler
    _handler = handler
    if _worker_tasks:
        return
    await init_bot_pipeline_queue()
    concurrency = max(1, int(settings.orchestrator_worker_concurrency or 1))
    for idx in range(concurrency):
        _worker_tasks.append(asyncio.create_task(_worker_loop(idx)))
    logger.info("bot_pipeline_queue: started %d worker(s)", concurrency)


async def stop_bot_pipeline_workers() -> None:
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
            envelope = await _queue.receive()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("bot_pipeline_worker[%d]: receive failed; retrying", index)
            await asyncio.sleep(1.0)
            continue
        try:
            if _handler is None:
                raise RuntimeError("bot pipeline worker handler is not configured")
            await _handler(envelope.job.channel_id, envelope.job.msg_id)
            await _queue.ack(envelope)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception(
                "bot_pipeline_worker[%d]: job failed channel_id=%s msg_id=%s",
                index, envelope.job.channel_id, envelope.job.msg_id,
            )
            await _queue.retry(envelope, exc)


async def enqueue_bot_pipeline_job(channel_id: str, msg_id: str) -> str:
    if not _worker_tasks:
        from app.features.bot_runtime.pipeline.bot.jobs import run_bot_pipeline_job

        await start_bot_pipeline_workers(run_bot_pipeline_job)
    return await _queue.enqueue(BotPipelineJob(channel_id=channel_id, msg_id=msg_id))
