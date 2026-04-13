"""单机 WebSocket 连接管理，按频道广播."""
import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

logger = logging.getLogger("app.services.ws_service")


class ConnectionManager:
    """频道内 WebSocket 连接管理，内存实现."""

    def __init__(self) -> None:
        self._channel_connections: dict[str, list[WebSocket]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, channel_id: str) -> None:
        await websocket.accept()
        async with self._lock:
            self._channel_connections[channel_id].append(websocket)

    async def disconnect(self, websocket: WebSocket, channel_id: str) -> None:
        async with self._lock:
            if channel_id in self._channel_connections:
                self._channel_connections[channel_id] = [
                    w for w in self._channel_connections[channel_id] if w != websocket
                ]
                if not self._channel_connections[channel_id]:
                    del self._channel_connections[channel_id]

    async def broadcast_to_channel(self, channel_id: str, message: dict) -> None:
        """向频道内所有连接并发推送消息。单个客户端失败不阻塞其他客户端。"""
        async with self._lock:
            if channel_id not in self._channel_connections:
                return
            connections = list(self._channel_connections[channel_id])
        results = await asyncio.gather(
            *[ws.send_json(message) for ws in connections],
            return_exceptions=True,
        )
        dead = [ws for ws, result in zip(connections, results) if isinstance(result, Exception)]
        if dead:
            logger.debug("Removing %d dead WebSocket connection(s) from channel %s", len(dead), channel_id)
            async with self._lock:
                dead_set = set(id(ws) for ws in dead)
                if channel_id in self._channel_connections:
                    self._channel_connections[channel_id] = [
                        ws for ws in self._channel_connections[channel_id] if id(ws) not in dead_set
                    ]
                    if not self._channel_connections[channel_id]:
                        del self._channel_connections[channel_id]


ws_manager = ConnectionManager()
