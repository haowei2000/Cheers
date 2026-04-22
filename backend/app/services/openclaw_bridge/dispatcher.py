"""进程内 pub/sub：把 WebSocket Bot 的派发事件按 bot_id 定向推送给订阅的 plugin.

设计说明：
  - 单进程单例 `bridge_dispatcher`。非集群部署下够用；多副本下应换成
    Redis Pub/Sub 或类似机制。
  - 每条 WS 连接订阅时声明它关心的 `bot_ids`。publish() 只把事件推给
    匹配该事件 `bot_id` 的订阅者 —— 避免 plugin A 看到它不负责的 Bot 流量。
  - Queue 满时丢弃（通常意味着 plugin 掉线或过载），plugin 侧应自愈。
  - 管理/调试场景可以以 bot_ids=None 订阅接收全部事件；默认 API 不暴露。
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("app.services.openclaw_bridge.dispatcher")

_QUEUE_MAXSIZE = 100


@dataclass(eq=False)
class _Subscriber:
    queue: asyncio.Queue
    # None = 接收全部（内部/调试用）；frozenset = 仅接收这些 bot_id 的事件；
    # 空集合 = 不接收任何事件（可用于 WS 握手中间态）。
    bot_ids: frozenset[str] | None = None
    extras: dict[str, Any] = field(default_factory=dict)

    def accepts(self, bot_id: str | None) -> bool:
        if self.bot_ids is None:
            return True
        if not bot_id:
            return False
        return bot_id in self.bot_ids


class BridgeDispatcher:
    def __init__(self) -> None:
        self._subscribers: set[_Subscriber] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self, bot_ids: Iterable[str] | None = None) -> _Subscriber:
        """订阅派发事件。

        Args:
            bot_ids: 订阅者关心的 bot_id 集合。None = 接收全部（仅限内部用途）；
                     传入集合 = 仅接收匹配的事件；空集合 = 不接收任何事件。
        """
        bot_ids_frozen: frozenset[str] | None
        if bot_ids is None:
            bot_ids_frozen = None
        else:
            bot_ids_frozen = frozenset(bot_ids)
        sub = _Subscriber(
            queue=asyncio.Queue(maxsize=_QUEUE_MAXSIZE),
            bot_ids=bot_ids_frozen,
        )
        async with self._lock:
            self._subscribers.add(sub)
        logger.info(
            "bridge_dispatcher: subscriber added bot_ids=%s total=%d",
            "*" if bot_ids_frozen is None else len(bot_ids_frozen),
            len(self._subscribers),
        )
        return sub

    async def update_subscription(self, sub: _Subscriber, bot_ids: Iterable[str] | None) -> None:
        """在线更新某订阅者的 bot_ids 过滤。"""
        async with self._lock:
            sub.bot_ids = None if bot_ids is None else frozenset(bot_ids)

    async def unsubscribe(self, sub: _Subscriber) -> None:
        async with self._lock:
            self._subscribers.discard(sub)
        logger.info("bridge_dispatcher: subscriber removed total=%d", len(self._subscribers))

    async def publish(self, event: dict[str, Any]) -> int:
        """定向广播事件，返回成功入队的订阅者数。"""
        bot_id = event.get("bot_id") if isinstance(event, dict) else None
        delivered = 0
        dead: list[_Subscriber] = []
        async with self._lock:
            targets = [s for s in self._subscribers if s.accepts(bot_id)]
        for sub in targets:
            try:
                sub.queue.put_nowait(event)
                delivered += 1
            except asyncio.QueueFull:
                logger.warning("bridge_dispatcher: subscriber queue full, dropping event bot_id=%s", bot_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("bridge_dispatcher: subscriber unavailable: %s", exc)
                dead.append(sub)
        if dead:
            async with self._lock:
                for s in dead:
                    self._subscribers.discard(s)
        return delivered

    def subscriber_count(self) -> int:
        return len(self._subscribers)


bridge_dispatcher = BridgeDispatcher()
