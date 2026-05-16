"""Dispatcher module."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("app.features.agent_bridge.dispatcher")

_QUEUE_MAXSIZE = 100


@dataclass(eq=False)
class _Subscriber:
    queue: asyncio.Queue
    # None receives everything for internal/debug use; frozenset receives only those bot_ids.
    # An empty set receives no events and can be used during WS handshake setup.
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
        """Subscribe."""
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
        """Update subscription."""
        async with self._lock:
            sub.bot_ids = None if bot_ids is None else frozenset(bot_ids)

    async def unsubscribe(self, sub: _Subscriber) -> None:
        async with self._lock:
            self._subscribers.discard(sub)
        logger.info("bridge_dispatcher: subscriber removed total=%d", len(self._subscribers))

    async def publish(self, event: dict[str, Any]) -> int:
        """Publish."""
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
