"""Pending module."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

logger = logging.getLogger("app.features.agent_bridge.pending")


@dataclass
class PendingReply:
    task_id: str
    bot_id: str
    channel_id: str
    msg_id: str
    timeout_handle: asyncio.TimerHandle | None = None


class PendingReplyRegistry:
    def __init__(self) -> None:
        self._by_task: dict[tuple[str, str], PendingReply] = {}  # (task_id, bot_id) -> PendingReply
        self._by_msg: dict[str, PendingReply] = {}  # msg_id -> PendingReply
        self._lock = asyncio.Lock()

    async def register(self, pending: PendingReply) -> None:
        async with self._lock:
            self._by_task[(pending.task_id, pending.bot_id)] = pending
            self._by_msg[pending.msg_id] = pending

    async def pop_by_task(self, task_id: str, bot_id: str) -> PendingReply | None:
        async with self._lock:
            p = self._by_task.pop((task_id, bot_id), None)
            if p:
                self._by_msg.pop(p.msg_id, None)
                if p.timeout_handle:
                    p.timeout_handle.cancel()
            return p

    async def pop_by_msg(self, msg_id: str) -> PendingReply | None:
        async with self._lock:
            p = self._by_msg.pop(msg_id, None)
            if p:
                self._by_task.pop((p.task_id, p.bot_id), None)
                if p.timeout_handle:
                    p.timeout_handle.cancel()
            return p

    async def peek_by_msg(self, msg_id: str) -> PendingReply | None:
        """Peek by msg."""
        async with self._lock:
            return self._by_msg.get(msg_id)

    async def peek_by_task(self, task_id: str, bot_id: str) -> PendingReply | None:
        async with self._lock:
            return self._by_task.get((task_id, bot_id))

    async def resolve(self, *, task_id: str | None, bot_id: str, msg_id: str | None) -> PendingReply | None:
        """Resolve."""
        if msg_id:
            async with self._lock:
                p = self._by_msg.get(msg_id)
                if p is not None and p.bot_id == bot_id:
                    self._by_msg.pop(msg_id, None)
                    self._by_task.pop((p.task_id, p.bot_id), None)
                    if p.timeout_handle:
                        p.timeout_handle.cancel()
                    return p
        if task_id:
            return await self.pop_by_task(task_id, bot_id)
        return None

    def count(self) -> int:
        return len(self._by_task)


pending_replies = PendingReplyRegistry()
