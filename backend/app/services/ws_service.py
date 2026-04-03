"""单机 WebSocket 连接管理，按频道广播."""
import asyncio
import json
from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    """频道内 WebSocket 连接管理，内存实现."""

    def __init__(self) -> None:
        self._channel_connections: dict[str, list[WebSocket]] = defaultdict(list)

    async def connect(self, websocket: WebSocket, channel_id: str) -> None:
        await websocket.accept()
        self._channel_connections[channel_id].append(websocket)

    def disconnect(self, websocket: WebSocket, channel_id: str) -> None:
        if channel_id in self._channel_connections:
            self._channel_connections[channel_id] = [
                w for w in self._channel_connections[channel_id] if w != websocket
            ]
            if not self._channel_connections[channel_id]:
                del self._channel_connections[channel_id]

    async def broadcast_to_channel(self, channel_id: str, message: dict) -> None:
        """向频道内所有连接并发推送消息。单个客户端失败不阻塞其他客户端。"""
        if channel_id not in self._channel_connections:
            return
        connections = list(self._channel_connections[channel_id])
        results = await asyncio.gather(
            *[ws.send_json(message) for ws in connections],
            return_exceptions=True,
        )
        dead = [ws for ws, result in zip(connections, results) if isinstance(result, Exception)]
        if dead:
            dead_set = set(id(ws) for ws in dead)
            self._channel_connections[channel_id] = [
                ws for ws in self._channel_connections[channel_id] if id(ws) not in dead_set
            ]


ws_manager = ConnectionManager()
