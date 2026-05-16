"""Event log module."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import func, select

from app.db.models import AgentBridgeEvent
from app.db.session import async_session_factory

logger = logging.getLogger("app.features.agent_bridge.event_log")


class BotEventSeq:
    """Bot Event Seq schema or model."""

    def __init__(self) -> None:
        self._counters: dict[tuple[str, str], int] = {}
        self._lock = asyncio.Lock()

    async def _bootstrap(self, bot_id: str, stream: str) -> int:
        async with async_session_factory() as s:
            max_seq = (await s.execute(
                select(func.max(AgentBridgeEvent.seq)).where(
                    AgentBridgeEvent.bot_id == bot_id,
                    AgentBridgeEvent.stream == stream,
                )
            )).scalar()
        return int(max_seq or 0)

    async def next(self, bot_id: str, stream: str) -> int:
        async with self._lock:
            key = (bot_id, stream)
            if key not in self._counters:
                self._counters[key] = await self._bootstrap(bot_id, stream)
            self._counters[key] += 1
            return self._counters[key]

    async def current(self, bot_id: str, stream: str) -> int:
        async with self._lock:
            key = (bot_id, stream)
            if key not in self._counters:
                self._counters[key] = await self._bootstrap(bot_id, stream)
            return self._counters[key]

    def reset(self) -> None:
        """Reset."""
        self._counters.clear()


bot_event_seq = BotEventSeq()


async def record_event(bot_id: str, stream: str, payload: dict[str, Any]) -> int:
    """Record event."""
    seq = await bot_event_seq.next(bot_id, stream)
    async with async_session_factory() as s:
        try:
            evt = AgentBridgeEvent(
                bot_id=bot_id,
                stream=stream,
                seq=seq,
                payload=payload,
            )
            s.add(evt)
            await s.commit()
        except Exception:
            await s.rollback()
            raise
    return seq


async def events_since(
    bot_id: str, stream: str, last_seq: int, *, limit: int = 500,
) -> list[dict[str, Any]]:
    """Events since."""
    if last_seq < 0:
        last_seq = 0
    async with async_session_factory() as s:
        rows = (await s.execute(
            select(AgentBridgeEvent.seq, AgentBridgeEvent.payload)
            .where(
                AgentBridgeEvent.bot_id == bot_id,
                AgentBridgeEvent.stream == stream,
                AgentBridgeEvent.seq > last_seq,
            )
            .order_by(AgentBridgeEvent.seq.asc())
            .limit(limit)
        )).all()
    out: list[dict[str, Any]] = []
    for seq, payload in rows:
        data = dict(payload or {})
        data["seq"] = seq
        out.append(data)
    return out


async def current_seq(bot_id: str, stream: str) -> int:
    """Current seq."""
    return await bot_event_seq.current(bot_id, stream)
