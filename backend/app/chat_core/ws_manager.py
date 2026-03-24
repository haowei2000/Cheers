"""单机 WebSocket 连接管理，按频道广播."""
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
        """向频道内所有连接推送消息."""
        if channel_id not in self._channel_connections:
            return
        dead: list[WebSocket] = []
        for ws in self._channel_connections[channel_id]:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._channel_connections[channel_id] = [
                w for w in self._channel_connections[channel_id] if w != ws
            ]


ws_manager = ConnectionManager()
