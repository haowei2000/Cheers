"""Registry module."""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("app.features.agent_bridge.registry")


@dataclass(eq=False)
class BotSession:
    bot_id: str
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    control_ws: WebSocket | None = None
    data_ws: WebSocket | None = None

    async def send_control(self, event: dict[str, Any]) -> bool:
        if self.control_ws is None:
            return False
        try:
            await self.control_ws.send_json(event)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("send_control bot_id=%s error: %s", self.bot_id, exc)
            return False

    async def send_data(self, event: dict[str, Any]) -> bool:
        if self.data_ws is None:
            return False
        try:
            await self.data_ws.send_json(event)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("send_data bot_id=%s error: %s", self.bot_id, exc)
            return False


class BotSessionRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, BotSession] = {}
        self._lock = asyncio.Lock()

    async def bind_control(self, bot_id: str, ws: WebSocket) -> tuple[BotSession, WebSocket | None]:
        """Bind control."""
        async with self._lock:
            sess = self._sessions.get(bot_id)
            old = sess.control_ws if sess else None
            if sess is None:
                sess = BotSession(bot_id=bot_id)
                self._sessions[bot_id] = sess
            sess.control_ws = ws
        logger.info(
            "registry.bind_control bot_id=%s session_id=%s replaced_old=%s",
            bot_id, sess.session_id, old is not None,
        )
        return sess, old

    async def unbind_control(self, bot_id: str, ws: WebSocket) -> None:
        """Unbind control."""
        async with self._lock:
            sess = self._sessions.get(bot_id)
            if sess and sess.control_ws is ws:
                sess.control_ws = None
            if sess and sess.control_ws is None and sess.data_ws is None:
                self._sessions.pop(bot_id, None)
        logger.info("registry.unbind_control bot_id=%s", bot_id)

    async def bind_data(self, bot_id: str, ws: WebSocket) -> tuple[BotSession, WebSocket | None]:
        """Bind data."""
        async with self._lock:
            sess = self._sessions.get(bot_id)
            old = sess.data_ws if sess else None
            if sess is None:
                sess = BotSession(bot_id=bot_id)
                self._sessions[bot_id] = sess
            sess.data_ws = ws
        logger.info(
            "registry.bind_data bot_id=%s session_id=%s replaced_old=%s",
            bot_id, sess.session_id, old is not None,
        )
        return sess, old

    async def unbind_data(self, bot_id: str, ws: WebSocket) -> None:
        async with self._lock:
            sess = self._sessions.get(bot_id)
            if sess and sess.data_ws is ws:
                sess.data_ws = None
            if sess and sess.control_ws is None and sess.data_ws is None:
                self._sessions.pop(bot_id, None)
        logger.info("registry.unbind_data bot_id=%s", bot_id)

    def get(self, bot_id: str) -> BotSession | None:
        return self._sessions.get(bot_id)

    def connection_state(self, bot_id: str) -> dict[str, bool | str]:
        """Return the in-memory live connection state for one Agent Bridge Bot.

        ``online`` means both control and data planes are connected; ``partial``
        means only one plane is present. The DB-level BotAccount.status remains
        the separate configured availability switch.
        """
        sess = self._sessions.get(bot_id)
        control_connected = bool(sess and sess.control_ws is not None)
        data_connected = bool(sess and sess.data_ws is not None)
        if control_connected and data_connected:
            connection_status = "online"
        elif control_connected or data_connected:
            connection_status = "partial"
        else:
            connection_status = "offline"
        return {
            "connection_status": connection_status,
            "is_online": connection_status == "online",
            "control_connected": control_connected,
            "data_connected": data_connected,
        }

    async def dispatch_control(self, bot_id: str, event: dict[str, Any]) -> bool:
        """Dispatch control."""
        sess = self._sessions.get(bot_id)
        if sess is None or sess.control_ws is None:
            return False
        return await sess.send_control(event)

    async def dispatch_data(self, bot_id: str, event: dict[str, Any]) -> bool:
        """Dispatch data."""
        sess = self._sessions.get(bot_id)
        if sess is None or sess.data_ws is None:
            return False
        # Allocate and persist seq first so payloads sent to WS always include seq.
        from app.features.agent_bridge.event_log import record_event

        seq = await record_event(bot_id, "data", event)
        event_with_seq = {**event, "seq": seq}
        return await sess.send_data(event_with_seq)

    def session_count(self) -> int:
        return len(self._sessions)


bot_session_registry = BotSessionRegistry()
