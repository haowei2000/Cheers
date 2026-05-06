"""Realtime fanout broker.

Memory mode dispatches only to local WebSocket connections. Redis mode also
publishes events so future backend replicas can deliver to their own local
connections without changing the WebSocket frame shape.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Protocol

from app.config import settings

logger = logging.getLogger("app.services.realtime_broker")

_CHANNEL_PATTERN = "agentnexus:rt:channel:*"
_USER_PATTERN = "agentnexus:rt:user:*"


class RealtimeBroker(Protocol):
    async def start(self) -> None: ...
    async def close(self) -> None: ...
    async def publish_channel(self, channel_id: str, message: dict) -> None: ...
    async def publish_user(self, user_id: str, message: dict) -> None: ...


class MemoryRealtimeBroker:
    async def start(self) -> None:
        return

    async def close(self) -> None:
        return

    async def publish_channel(self, channel_id: str, message: dict) -> None:
        from app.services.ws_service import ws_manager

        await ws_manager.broadcast_to_channel(channel_id, message)

    async def publish_user(self, user_id: str, message: dict) -> None:
        from app.services.ws_service import ws_manager

        await ws_manager.broadcast_to_user(user_id, message)


class RedisRealtimeBroker:
    def __init__(self) -> None:
        self._instance_id = uuid.uuid4().hex
        self._redis = None
        self._pubsub = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        import redis.asyncio as redis

        self._redis = redis.Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=1.0,
            socket_timeout=5.0,
        )
        await self._redis.ping()
        self._pubsub = self._redis.pubsub()
        await self._pubsub.psubscribe(_CHANNEL_PATTERN, _USER_PATTERN)
        self._task = asyncio.create_task(self._listen())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    async def publish_channel(self, channel_id: str, message: dict) -> None:
        await _deliver_channel_local(channel_id, message)
        await self._publish(f"agentnexus:rt:channel:{channel_id}", "channel", channel_id, message)

    async def publish_user(self, user_id: str, message: dict) -> None:
        await _deliver_user_local(user_id, message)
        await self._publish(f"agentnexus:rt:user:{user_id}", "user", user_id, message)

    async def _publish(self, topic: str, kind: str, target_id: str, message: dict) -> None:
        if self._redis is None:
            return
        payload = {
            "source": self._instance_id,
            "kind": kind,
            "target_id": target_id,
            "message": message,
        }
        try:
            await self._redis.publish(topic, json.dumps(payload, ensure_ascii=False))
        except Exception:
            logger.warning("realtime_broker: redis publish failed topic=%s", topic, exc_info=True)

    async def _listen(self) -> None:
        assert self._pubsub is not None
        async for item in self._pubsub.listen():
            if item.get("type") != "pmessage":
                continue
            try:
                payload = json.loads(item.get("data") or "{}")
            except json.JSONDecodeError:
                continue
            if payload.get("source") == self._instance_id:
                continue
            try:
                await _deliver_payload_local(payload)
            except Exception:
                logger.debug("realtime_broker: failed to deliver redis payload", exc_info=True)


async def _deliver_payload_local(payload: dict[str, Any]) -> None:
    target_id = payload.get("target_id")
    message = payload.get("message")
    if not isinstance(target_id, str) or not isinstance(message, dict):
        return
    if payload.get("kind") == "channel":
        await _deliver_channel_local(target_id, message)
    elif payload.get("kind") == "user":
        await _deliver_user_local(target_id, message)


async def _deliver_channel_local(channel_id: str, message: dict) -> None:
    from app.services.ws_service import ws_manager

    await ws_manager.broadcast_to_channel(channel_id, message)


async def _deliver_user_local(user_id: str, message: dict) -> None:
    from app.services.ws_service import ws_manager

    await ws_manager.broadcast_to_user(user_id, message)


_broker: RealtimeBroker = MemoryRealtimeBroker()


def get_realtime_broker() -> RealtimeBroker:
    return _broker


async def init_realtime_broker() -> RealtimeBroker:
    global _broker
    backend = (settings.realtime_broker_backend or "redis").strip().lower()
    if backend == "redis":
        broker = RedisRealtimeBroker()
        try:
            await broker.start()
            _broker = broker
            logger.info("realtime_broker: using redis backend")
            return _broker
        except Exception as exc:
            logger.warning("realtime_broker: redis unavailable, falling back to memory: %s", exc)
            await broker.close()
    _broker = MemoryRealtimeBroker()
    await _broker.start()
    logger.info("realtime_broker: using memory backend")
    return _broker


async def close_realtime_broker() -> None:
    await _broker.close()
