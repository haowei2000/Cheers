"""Active streaming reply registry for bot replies.

A `StreamState` is created for each bot placeholder while its reply is active.
Agent Bridge bots use it to buffer external `delta` frames; in-process bots use
it as the shared cancellation signal behind the message cancel API.

Per-msg_id locking keeps `apply_delta` / `finalize` / `cancel` serialized
even if the data WS handler ever interleaves frames.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("app.features.agent_bridge.streams")


@dataclass
class StreamState:
    msg_id: str
    bot_id: str
    channel_id: str
    task_id: str | None = None
    source: str = "local"
    buffer: str = ""
    last_seq: int = -1
    cancel_requested: bool = False
    cancel_reason: str | None = None
    finalized: bool = False
    trace_events: list[dict[str, Any]] = field(default_factory=list)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    producer_task: asyncio.Task | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class StreamRegistry:
    def __init__(self) -> None:
        self._by_msg: dict[str, StreamState] = {}
        self._lock = asyncio.Lock()

    async def register(
        self,
        *,
        msg_id: str,
        bot_id: str,
        channel_id: str,
        task_id: str | None = None,
        source: str = "local",
    ) -> StreamState:
        async with self._lock:
            existing = self._by_msg.get(msg_id)
            if existing is not None:
                existing.bot_id = bot_id
                existing.channel_id = channel_id
                existing.task_id = task_id or existing.task_id
                existing.source = source or existing.source
                return existing
            state = StreamState(
                msg_id=msg_id,
                bot_id=bot_id,
                channel_id=channel_id,
                task_id=task_id,
                source=source,
            )
            self._by_msg[msg_id] = state
            return state

    async def get(self, msg_id: str) -> StreamState | None:
        async with self._lock:
            return self._by_msg.get(msg_id)

    async def pop(self, msg_id: str) -> StreamState | None:
        async with self._lock:
            return self._by_msg.pop(msg_id, None)

    async def bind_task(self, msg_id: str, task: asyncio.Task) -> StreamState | None:
        async with self._lock:
            state = self._by_msg.get(msg_id)
            if state is not None:
                state.producer_task = task
            return state

    async def unbind_task(self, msg_id: str, task: asyncio.Task) -> None:
        async with self._lock:
            state = self._by_msg.get(msg_id)
            if state is not None and state.producer_task is task:
                state.producer_task = None

    async def request_cancel(
        self,
        msg_id: str,
        *,
        reason: str = "user_cancelled",
    ) -> StreamState | None:
        async with self._lock:
            state = self._by_msg.get(msg_id)
            if state is None:
                return None
            state.cancel_requested = True
            state.cancel_reason = reason
            state.cancel_event.set()
            task = state.producer_task
        if task is not None and not task.done():
            task.cancel()
        return state

    def count(self) -> int:
        return len(self._by_msg)


stream_registry = StreamRegistry()
