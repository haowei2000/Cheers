"""单机 WebSocket 连接管理，按频道/用户本地投递。"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from app.config import settings

logger = logging.getLogger("app.services.ws_service")


@dataclass(eq=False)
class _ManagedConnection:
    websocket: WebSocket
    on_writer_close: Callable[["_ManagedConnection"], Awaitable[None]] | None = None
    queue: asyncio.Queue[dict[str, Any] | None] = field(init=False)
    writer_task: asyncio.Task | None = None
    closed: bool = False

    def __post_init__(self) -> None:
        maxsize = max(1, int(settings.ws_outbound_queue_size or 256))
        self.queue = asyncio.Queue(maxsize=maxsize)

    def start(self) -> None:
        self.writer_task = asyncio.create_task(self._writer())

    async def enqueue(self, message: dict[str, Any]) -> bool:
        if self.closed:
            return False
        try:
            self.queue.put_nowait(message)
            return True
        except asyncio.QueueFull:
            logger.warning("ws.outbound_queue_full: closing slow client")
            await self.close(code=1011, reason="outbound queue full")
            return False

    async def close(self, *, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        self.closed = True
        current = asyncio.current_task()
        if self.writer_task and self.writer_task is not current:
            self.writer_task.cancel()
            try:
                await self.writer_task
            except asyncio.CancelledError:
                pass
        try:
            await self.websocket.close(code=code, reason=reason)
        except Exception:
            pass

    async def _writer(self) -> None:
        timeout = max(0.1, float(settings.ws_send_timeout_seconds or 5.0))
        try:
            while True:
                message = await self.queue.get()
                if message is None:
                    return
                await asyncio.wait_for(self.websocket.send_json(message), timeout=timeout)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("ws.writer: closing failed connection: %s", exc)
            await self._close_after_writer_failure()
        finally:
            self.closed = True

    async def _close_after_writer_failure(self) -> None:
        self.closed = True
        try:
            await self.websocket.close(code=1011, reason="send failed")
        except Exception:
            pass
        if self.on_writer_close:
            await self.on_writer_close(self)


class ConnectionManager:
    """频道/用户 WebSocket 连接管理，内存实现.

    广播只把 frame 放入每个连接的有界 outbound queue，不再等待所有
    socket 直接写入完成；慢客户端会被关闭并从本地索引清理。
    """

    def __init__(self) -> None:
        self._channel_connections: dict[str, list[_ManagedConnection]] = defaultdict(list)
        self._user_connections: dict[str, list[_ManagedConnection]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, channel_id: str) -> None:
        await websocket.accept()
        conn = _ManagedConnection(
            websocket,
            on_writer_close=lambda c: self._remove_connection(self._channel_connections, channel_id, c),
        )
        conn.start()
        async with self._lock:
            self._channel_connections[channel_id].append(conn)

    async def disconnect(self, websocket: WebSocket, channel_id: str) -> None:
        conn = await self._remove_by_websocket(self._channel_connections, channel_id, websocket)
        if conn:
            await conn.close()

    async def connect_user(self, websocket: WebSocket, user_id: str) -> None:
        await websocket.accept()
        conn = _ManagedConnection(
            websocket,
            on_writer_close=lambda c: self._remove_connection(self._user_connections, user_id, c),
        )
        conn.start()
        async with self._lock:
            self._user_connections[user_id].append(conn)

    async def disconnect_user(self, websocket: WebSocket, user_id: str) -> None:
        conn = await self._remove_by_websocket(self._user_connections, user_id, websocket)
        if conn:
            await conn.close()

    async def broadcast_to_channel(self, channel_id: str, message: dict) -> None:
        """向频道内所有本实例连接投递消息。"""
        await self._broadcast_local(self._channel_connections, channel_id, message)

    async def broadcast_to_user(self, user_id: str, message: dict) -> None:
        """向某用户的所有本实例连接投递轻量通知。"""
        await self._broadcast_local(self._user_connections, user_id, message)

    async def _broadcast_local(
        self,
        mapping: dict[str, list[_ManagedConnection]],
        key: str,
        message: dict,
    ) -> None:
        async with self._lock:
            connections = list(mapping.get(key, []))
        if not connections:
            return

        dead: list[_ManagedConnection] = []
        for conn in connections:
            ok = await conn.enqueue(message)
            if not ok or conn.closed:
                dead.append(conn)
        if dead:
            await self._remove_dead(mapping, key, dead)

    async def _remove_by_websocket(
        self,
        mapping: dict[str, list[_ManagedConnection]],
        key: str,
        websocket: WebSocket,
    ) -> _ManagedConnection | None:
        async with self._lock:
            conns = mapping.get(key)
            if not conns:
                return None
            found = next((conn for conn in conns if conn.websocket is websocket), None)
            mapping[key] = [conn for conn in conns if conn.websocket is not websocket]
            if not mapping[key]:
                del mapping[key]
            return found

    async def _remove_dead(
        self,
        mapping: dict[str, list[_ManagedConnection]],
        key: str,
        dead: list[_ManagedConnection],
    ) -> None:
        dead_ids = {id(conn) for conn in dead}
        async with self._lock:
            conns = mapping.get(key)
            if not conns:
                return
            mapping[key] = [conn for conn in conns if id(conn) not in dead_ids and not conn.closed]
            if not mapping[key]:
                del mapping[key]

    async def _remove_connection(
        self,
        mapping: dict[str, list[_ManagedConnection]],
        key: str,
        conn: _ManagedConnection,
    ) -> None:
        async with self._lock:
            conns = mapping.get(key)
            if not conns:
                return
            mapping[key] = [existing for existing in conns if existing is not conn]
            if not mapping[key]:
                del mapping[key]


ws_manager = ConnectionManager()
