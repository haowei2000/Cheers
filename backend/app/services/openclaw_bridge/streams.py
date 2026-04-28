"""Active streaming reply registry for WebSocket-bound bots.

A `StreamState` is created when an OpenClaw-backed bot is dispatched and is
expected to reply via incremental `delta` frames. Each delta is buffered here
(not flushed to the DB row until finalize) and broadcast as a
`message_stream` WebSocket event so the frontend can render it token-by-token,
mirroring the in-process streaming path used by HttpBotAdapter / ChannelBotAdapter.

Per-msg_id locking keeps `apply_delta` / `finalize` / `cancel` serialized
even if the data WS handler ever interleaves frames.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

logger = logging.getLogger("app.services.openclaw_bridge.streams")


@dataclass
class StreamState:
    msg_id: str
    bot_id: str
    channel_id: str
    task_id: str | None = None
    buffer: str = ""
    last_seq: int = -1
    cancel_requested: bool = False
    finalized: bool = False
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
    ) -> StreamState:
        async with self._lock:
            state = StreamState(
                msg_id=msg_id, bot_id=bot_id, channel_id=channel_id, task_id=task_id,
            )
            self._by_msg[msg_id] = state
            return state

    async def get(self, msg_id: str) -> StreamState | None:
        async with self._lock:
            return self._by_msg.get(msg_id)

    async def pop(self, msg_id: str) -> StreamState | None:
        async with self._lock:
            return self._by_msg.pop(msg_id, None)

    def count(self) -> int:
        return len(self._by_msg)


stream_registry = StreamRegistry()
