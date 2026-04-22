"""Per-bot data stream 事件日志：写入 + 查询 + 单调 seq 计数。

设计：
  - (bot_id, stream) 为键维护内存计数器；首次使用时从 DB 的 MAX(seq) bootstrap。
  - dispatch_data 时同步 record_event，把 seq 嵌入 payload 后再发 WS。
  - plugin resume 时按 last_event_seq 回放。
  - Phase D 先不做 retention；生产上应按时间/条数 prune 老事件。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import func, select

from app.db.models import OpenClawPluginEvent
from app.db.session import async_session_factory

logger = logging.getLogger("app.services.openclaw_bridge.event_log")


class BotEventSeq:
    """(bot_id, stream) → 最近一次已发放的 seq。None 表示尚未 bootstrap。"""

    def __init__(self) -> None:
        self._counters: dict[tuple[str, str], int] = {}
        self._lock = asyncio.Lock()

    async def _bootstrap(self, bot_id: str, stream: str) -> int:
        async with async_session_factory() as s:
            max_seq = (await s.execute(
                select(func.max(OpenClawPluginEvent.seq)).where(
                    OpenClawPluginEvent.bot_id == bot_id,
                    OpenClawPluginEvent.stream == stream,
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
        """测试用：清空所有计数。"""
        self._counters.clear()


bot_event_seq = BotEventSeq()


async def record_event(bot_id: str, stream: str, payload: dict[str, Any]) -> int:
    """发放一个新的 seq 并写入事件日志。返回 seq。"""
    seq = await bot_event_seq.next(bot_id, stream)
    async with async_session_factory() as s:
        try:
            evt = OpenClawPluginEvent(
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
    """返回 seq > last_seq 的事件，按 seq 升序，最多 limit 条。

    每个返回项是 payload dict（其中包含 "seq" 字段）。
    """
    if last_seq < 0:
        last_seq = 0
    async with async_session_factory() as s:
        rows = (await s.execute(
            select(OpenClawPluginEvent.seq, OpenClawPluginEvent.payload)
            .where(
                OpenClawPluginEvent.bot_id == bot_id,
                OpenClawPluginEvent.stream == stream,
                OpenClawPluginEvent.seq > last_seq,
            )
            .order_by(OpenClawPluginEvent.seq.asc())
            .limit(limit)
        )).all()
    out: list[dict[str, Any]] = []
    for seq, payload in rows:
        data = dict(payload or {})
        data["seq"] = seq
        out.append(data)
    return out


async def current_seq(bot_id: str, stream: str) -> int:
    """返回该 bot/stream 当前已用掉的最大 seq（即最新事件的 seq）。"""
    return await bot_event_seq.current(bot_id, stream)
