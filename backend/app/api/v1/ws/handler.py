"""Handler module."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.log_context import bind_context
from app.core.schemas import MessageCreate
from app.services.ws_service import ws_manager

logger = logging.getLogger("app.ws")

router = APIRouter()


@router.websocket("/ws/channels/{channel_id}")
async def websocket_channel(websocket: WebSocket, channel_id: str) -> None:
    """Websocket channel."""
    with bind_context(channel_id=channel_id):
        await ws_manager.connect(websocket, channel_id)
        logger.info("ws.connect channel_id=%s", channel_id)
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
                        MessageCreate(**data)
                    except Exception as exc:
                        await websocket.send_json(
                            {"type": "error", "data": {"detail": f"invalid payload: {exc}"}}
                        )
                        continue
                    await websocket.send_json({
                        "type": "error",
                        "data": {
                            "detail": "WebSocket send_message requires authenticated REST API",
                            "code": "unauthorized",
                        },
                    })
                else:
                    await ws_manager.broadcast_to_channel(channel_id, {"type": "echo", "data": raw})
        except WebSocketDisconnect:
            logger.info("ws.disconnect channel_id=%s", channel_id)
        finally:
            await ws_manager.disconnect(websocket, channel_id)


@router.websocket("/ws/users/{user_id}")
async def websocket_user(websocket: WebSocket, user_id: str) -> None:
    """Websocket user."""
    with bind_context(user_id=user_id):
        await ws_manager.connect_user(websocket, user_id)
        logger.info("ws.connect user_id=%s", user_id)
        try:
            while True:
                # Clients usually do not send on user channels; keep receive open for heartbeat/idle traffic.
                await websocket.receive_text()
        except WebSocketDisconnect:
            logger.info("ws.disconnect user_id=%s", user_id)
        finally:
            await ws_manager.disconnect_user(websocket, user_id)
