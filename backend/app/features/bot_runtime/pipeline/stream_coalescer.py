"""Coalesce high-frequency stream deltas before they hit realtime transports."""
from __future__ import annotations

import asyncio
import contextlib

from app.config import settings
from app.features.bot_runtime.pipeline.bus import EventBus
from app.features.bot_runtime.pipeline.events import MessageStreamDelta


class StreamDeltaCoalescer:
    """Buffer token deltas for one message and flush them in small batches."""

    def __init__(self, *, msg_id: str, bus: EventBus) -> None:
        self._msg_id = msg_id
        self._bus = bus
        self._parts: list[str] = []
        self._chars = 0
        self._lock = asyncio.Lock()
        self._timer_task: asyncio.Task | None = None
        self._interval = max(
            0.0,
            float(getattr(settings, "stream_delta_flush_interval_seconds", 0.08) or 0.0),
        )
        self._max_chars = max(
            1,
            int(getattr(settings, "stream_delta_flush_chars", 512) or 512),
        )

    async def add(self, delta: str) -> None:
        if not delta:
            return
        text = ""
        async with self._lock:
            self._parts.append(delta)
            self._chars += len(delta)
            if self._interval <= 0 or self._chars >= self._max_chars:
                text = self._take_locked(cancel_timer=True)
            elif self._timer_task is None or self._timer_task.done():
                self._timer_task = asyncio.create_task(self._flush_after_interval())
        if text:
            await self._publish(text)

    async def flush(self) -> None:
        async with self._lock:
            text = self._take_locked(cancel_timer=True)
        if text:
            await self._publish(text)

    async def close(self) -> None:
        timer_task: asyncio.Task | None
        async with self._lock:
            timer_task = self._timer_task
            self._timer_task = None
        if timer_task is not None and timer_task is not asyncio.current_task() and not timer_task.done():
            timer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await timer_task
        await self.flush()

    def _take_locked(self, *, cancel_timer: bool) -> str:
        text = "".join(self._parts)
        self._parts.clear()
        self._chars = 0
        if cancel_timer and self._timer_task is not None:
            timer_task = self._timer_task
            self._timer_task = None
            if timer_task is not asyncio.current_task() and not timer_task.done():
                timer_task.cancel()
        return text

    async def _flush_after_interval(self) -> None:
        try:
            await asyncio.sleep(self._interval)
            await self.flush()
        except asyncio.CancelledError:
            raise

    async def _publish(self, text: str) -> None:
        await self._bus.publish(MessageStreamDelta(msg_id=self._msg_id, delta=text))
