"""Orchestrator pipeline event types.

Each event knows how to render itself for the two transport sinks the
orchestrator currently feeds: the channel-wide WebSocket and the per-request
SSE callback. This is the seed of the pipeline-v2 EventBus.
"""
from __future__ import annotations

from dataclasses import dataclass


class Event:
    def to_ws_frame(self) -> dict:
        raise NotImplementedError

    def to_sse(self) -> tuple[str, dict]:
        raise NotImplementedError


@dataclass(slots=True)
class MessageStreamDelta(Event):
    msg_id: str
    delta: str

    def to_ws_frame(self) -> dict:
        return {
            "type": "message_stream",
            "data": {"msg_id": self.msg_id, "delta": self.delta},
        }

    def to_sse(self) -> tuple[str, dict]:
        return "delta", {"msg_id": self.msg_id, "delta": self.delta}
