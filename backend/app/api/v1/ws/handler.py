"""WebSocket 频道处理器（从 main.py 迁移）."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.core.schemas import MessageCreate
from app.db.session import async_session_factory
from app.services.ws_service import ws_manager

logger = logging.getLogger("app.ws")

router = APIRouter()


@router.websocket("/ws/channels/{channel_id}")
async def websocket_channel(websocket: WebSocket, channel_id: str) -> None:
    """连接频道 WebSocket，接收实时消息推送 & send_message 动作."""
    await ws_manager.connect(websocket, channel_id)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                obj = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                await websocket.send_json({"type": "error", "data": {"detail": "invalid JSON"}})
                continue

            if obj.get("type") == "send_message":
                data = obj.get("data") or {}
                try:
                    body = MessageCreate(**data)
                except Exception as exc:
                    await websocket.send_json(
                        {"type": "error", "data": {"detail": f"invalid payload: {exc}"}}
                    )
                    continue
                try:
                    from app.api.v1.messages.routes import _handle_send_message
                    async with async_session_factory() as session:
                        await _handle_send_message(
                            session,
                            channel_id=channel_id,
                            body=body,
                        )
                except HTTPException as exc:
                    await websocket.send_json({"type": "error", "data": {"detail": exc.detail}})
                except Exception as exc:
                    logger.exception("ws send_message failed channel_id=%s: %s", channel_id, exc)
                    await websocket.send_json(
                        {"type": "error", "data": {"detail": "internal server error"}}
                    )
            else:
                await ws_manager.broadcast_to_channel(channel_id, {"type": "echo", "data": raw})
    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket, channel_id)
