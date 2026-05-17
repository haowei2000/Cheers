"""Debounced history-page compaction hooks.

History context is rendered at load time from the current page and sealed
HistoryPage summaries. This module coalesces bursty updates so message writes
stay cheap.
"""
from __future__ import annotations

import asyncio
import logging

from app.config import settings
from app.features.memory.history_pager import compact_channel_history

logger = logging.getLogger("app.features.memory.history_update")

_DEBOUNCE_TASKS: dict[str, asyncio.Task] = {}
_DEBOUNCE_LOCK = asyncio.Lock()
_REDIS_AVAILABLE: bool | None = None


async def update_history_async(channel_id: str) -> None:
    """Compact memory pages for this channel."""
    try:
        created = await compact_channel_history(channel_id)
        if created:
            logger.info(
                "history_compaction: sealed %d page(s) channel_id=%s",
                created,
                channel_id,
            )
    except Exception as exc:
        logger.warning(
            "update_history_async: failed to compact history channel=%s: %s",
            channel_id,
            exc,
        )


def schedule_history_update(channel_id: str) -> None:
    """Schedule a debounced history-page update for this channel."""
    asyncio.create_task(_schedule_history_update(channel_id))


def _history_debounce_seconds() -> float:
    configured = settings.history_debounce_seconds
    if configured is None:
        configured = settings.recent_debounce_seconds
    return max(0.0, float(configured or 0.0))


async def _schedule_history_update(channel_id: str) -> None:
    backend = (settings.orchestrator_queue_backend or "redis").strip().lower()
    if backend == "redis":
        claimed = await _claim_history_update_redis(channel_id)
        if claimed is True:
            await _debounced_update(channel_id)
            return
        if claimed is False:
            return
    await _schedule_history_update_memory(channel_id)


async def _schedule_history_update_memory(channel_id: str) -> None:
    async with _DEBOUNCE_LOCK:
        existing = _DEBOUNCE_TASKS.get(channel_id)
        if existing is not None and not existing.done():
            return
        task = asyncio.create_task(_debounced_update(channel_id))
        _DEBOUNCE_TASKS[channel_id] = task


async def _debounced_update(channel_id: str) -> None:
    delay = _history_debounce_seconds()
    try:
        if delay:
            await asyncio.sleep(delay)
        await update_history_async(channel_id)
    finally:
        async with _DEBOUNCE_LOCK:
            current = _DEBOUNCE_TASKS.get(channel_id)
            if current is asyncio.current_task():
                _DEBOUNCE_TASKS.pop(channel_id, None)


async def _claim_history_update_redis(channel_id: str) -> bool | None:
    """Return True when this process should run, False when another claimed,
    None when Redis is unavailable and memory fallback should be used.
    """
    global _REDIS_AVAILABLE
    if _REDIS_AVAILABLE is False:
        return None
    try:
        import redis.asyncio as redis

        delay = _history_debounce_seconds()
        ttl = max(1, int(delay) + 1)
        client = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=0.2,
            socket_timeout=1.0,
        )
        try:
            claimed = await client.set(
                f"agentnexus:history:debounce:{channel_id}",
                "1",
                ex=ttl,
                nx=True,
            )
            _REDIS_AVAILABLE = True
            return bool(claimed)
        finally:
            await client.aclose()
    except Exception as exc:
        _REDIS_AVAILABLE = False
        logger.debug("history debounce redis unavailable, using memory fallback: %s", exc)
        return None


async def reset_history_debounce_state() -> None:
    """Test helper: clear process-local debounce state."""
    global _REDIS_AVAILABLE
    async with _DEBOUNCE_LOCK:
        tasks = list(_DEBOUNCE_TASKS.values())
        for task in tasks:
            task.cancel()
        _DEBOUNCE_TASKS.clear()
    for task in tasks:
        try:
            await task
        except asyncio.CancelledError:
            pass
    _REDIS_AVAILABLE = None
