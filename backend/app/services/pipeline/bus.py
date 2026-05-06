"""EventBus abstraction for orchestrator pipeline events.

Replaces the implicit dual-sink in ``_make_stream_token_cb`` (channel WS
broadcast + optional per-request SSE callback) with a typed bus. Phase 1 of
the pipeline refactor only routes ``MessageStreamDelta`` through here; later
phases extend coverage to the rest of the event types.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol

from app.services.pipeline.events import Event


class EventBus(Protocol):
    async def publish(self, event: Event) -> None: ...


class NullEventBus:
    async def publish(self, event: Event) -> None:
        return


class WSEventBus:
    def __init__(self, channel_id: str) -> None:
        self._channel_id = channel_id

    async def publish(self, event: Event) -> None:
        frame = event.to_ws_frame()
        if frame is None:
            return
        from app.services.realtime_broker import get_realtime_broker

        await get_realtime_broker().publish_channel(self._channel_id, frame)


class SSEEventBus:
    def __init__(self, stream_event: Callable[[str, dict], Awaitable[None]]) -> None:
        self._stream_event = stream_event

    async def publish(self, event: Event) -> None:
        sse = event.to_sse()
        if sse is None:
            return
        name, data = sse
        await self._stream_event(name, data)


class TeeEventBus:
    def __init__(self, *buses: EventBus) -> None:
        self._buses = tuple(buses)

    async def publish(self, event: Event) -> None:
        for bus in self._buses:
            await bus.publish(event)


def make_event_bus(
    channel_id: str,
    *,
    stream_to_ws: bool,
    stream_event: Callable[[str, dict], Awaitable[None]] | None,
) -> EventBus:
    sinks: list[EventBus] = []
    if stream_to_ws:
        sinks.append(WSEventBus(channel_id))
    if stream_event is not None:
        sinks.append(SSEEventBus(stream_event))
    if not sinks:
        return NullEventBus()
    if len(sinks) == 1:
        return sinks[0]
    return TeeEventBus(*sinks)
