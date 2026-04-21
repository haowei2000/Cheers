"""进程内 pub/sub：把 WebSocket Bot 的派发事件广播给所有已连 OpenClaw channel plugin.

设计说明：
  - 单进程单例 `bridge_dispatcher`。非集群部署下够用；如果未来多副本，
    需要用 Redis Pub/Sub 或类似机制替换此实现。
  - 每条 WS 连接订阅时拿到一个 asyncio.Queue；dispatcher.publish() 把事件
    推到每个 queue。plugin 侧自行按 bot_id 过滤感兴趣的事件。
  - Queue 满时丢弃（队列积压通常意味着 plugin 掉线或过载），由 plugin 侧
    再拉取状态自愈。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("app.services.openclaw_bridge.dispatcher")

_QUEUE_MAXSIZE = 100


class BridgeDispatcher:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        async with self._lock:
            self._subscribers.add(q)
        logger.info("bridge_dispatcher: subscriber added, total=%d", len(self._subscribers))
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        async with self._lock:
            self._subscribers.discard(q)
        logger.info("bridge_dispatcher: subscriber removed, total=%d", len(self._subscribers))

    async def publish(self, event: dict[str, Any]) -> int:
        """广播事件；返回成功入队的订阅者数量（0 表示当前无 plugin 在线）。"""
        delivered = 0
        dead: list[asyncio.Queue] = []
        async with self._lock:
            targets = list(self._subscribers)
        for q in targets:
            try:
                q.put_nowait(event)
                delivered += 1
            except asyncio.QueueFull:
                logger.warning("bridge_dispatcher: subscriber queue full, dropping event")
            except Exception as exc:  # noqa: BLE001
                logger.warning("bridge_dispatcher: subscriber unavailable: %s", exc)
                dead.append(q)
        if dead:
            async with self._lock:
                for q in dead:
                    self._subscribers.discard(q)
        return delivered

    def subscriber_count(self) -> int:
        return len(self._subscribers)


bridge_dispatcher = BridgeDispatcher()
