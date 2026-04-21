"""记录已派发给 OpenClaw plugin、等待回推的占位 Bot 消息。

进程内 dict；多副本部署需要换成 DB 持久化（可用 Message.content=''
+ msg_type=REPLY 作为 implicit pending 的天然表达，但显式 registry 便于超时处理）。
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

logger = logging.getLogger("app.services.openclaw_bridge.pending")


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

    async def resolve(self, *, task_id: str | None, bot_id: str, msg_id: str | None) -> PendingReply | None:
        """按 msg_id（优先）或 (task_id, bot_id) 定位一个 pending。找到即从 registry 移除。"""
        if msg_id:
            p = await self.pop_by_msg(msg_id)
            if p:
                return p
        if task_id:
            return await self.pop_by_task(task_id, bot_id)
        return None

    def count(self) -> int:
        return len(self._by_task)


pending_replies = PendingReplyRegistry()
