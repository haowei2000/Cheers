"""单机 WebSocket 连接管理，按频道广播."""
import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

logger = logging.getLogger("app.services.ws_service")


class ConnectionManager:
    """频道/用户 WebSocket 连接管理，内存实现.

    两类索引独立维护：
    - _channel_connections: 订阅具体频道消息流（已有实现）
    - _user_connections: 用户级通道，用来接收跨频道的轻量通知（如未读增量）
    """

    def __init__(self) -> None:
        self._channel_connections: dict[str, list[WebSocket]] = defaultdict(list)
        self._user_connections: dict[str, list[WebSocket]] = defaultdict(list)
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

    async def connect_user(self, websocket: WebSocket, user_id: str) -> None:
        await websocket.accept()
        async with self._lock:
            self._user_connections[user_id].append(websocket)

    async def disconnect_user(self, websocket: WebSocket, user_id: str) -> None:
        async with self._lock:
            if user_id in self._user_connections:
                self._user_connections[user_id] = [
                    w for w in self._user_connections[user_id] if w != websocket
                ]
                if not self._user_connections[user_id]:
                    del self._user_connections[user_id]

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
                dead_set = {id(ws) for ws in dead}
                if channel_id in self._channel_connections:
                    self._channel_connections[channel_id] = [
                        ws for ws in self._channel_connections[channel_id] if id(ws) not in dead_set
                    ]
                    if not self._channel_connections[channel_id]:
                        del self._channel_connections[channel_id]

    async def broadcast_to_user(self, user_id: str, message: dict) -> None:
        """向某用户的所有活跃连接并发推送（用于跨频道的轻量通知）。"""
        async with self._lock:
            if user_id not in self._user_connections:
                return
            connections = list(self._user_connections[user_id])
        results = await asyncio.gather(
            *[ws.send_json(message) for ws in connections],
            return_exceptions=True,
        )
        dead = [ws for ws, result in zip(connections, results) if isinstance(result, Exception)]
        if dead:
            async with self._lock:
                dead_set = {id(ws) for ws in dead}
                if user_id in self._user_connections:
                    self._user_connections[user_id] = [
                        ws for ws in self._user_connections[user_id] if id(ws) not in dead_set
                    ]
                    if not self._user_connections[user_id]:
                        del self._user_connections[user_id]


ws_manager = ConnectionManager()
