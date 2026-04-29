"""Orchestrator pipeline event types.

Each event knows how to render itself for the two transport sinks the
orchestrator currently feeds: the channel-wide WebSocket and the per-request
SSE callback. This is the seed of the pipeline-v2 EventBus.
"""
from __future__ import annotations

from dataclasses import dataclass


class Event:
    def to_ws_frame(self) -> dict | None:
        return None

    def to_sse(self) -> tuple[str, dict] | None:
        return None


@dataclass(slots=True)
class MessageCreated(Event):
    """A complete message (user, finished bot reply, routing card) was persisted."""

    data: dict

    def to_ws_frame(self) -> dict:
        return {"type": "message", "data": self.data}

    def to_sse(self) -> tuple[str, dict]:
        return "message", self.data


@dataclass(slots=True)
class BotMessagePlaceholder(Event):
    """An empty bot message bubble was created; streaming deltas will follow."""

    data: dict

    def to_ws_frame(self) -> dict:
        return {"type": "message", "data": self.data}

    def to_sse(self) -> tuple[str, dict]:
        return "bot_message", self.data


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


@dataclass(slots=True)
class BotTrace(Event):
    """Transient bot progress/trace event; never persisted."""

    data: dict

    def to_ws_frame(self) -> dict:
        return {"type": "bot_trace", "data": self.data}

    def to_sse(self) -> tuple[str, dict]:
        return "bot_trace", self.data


@dataclass(slots=True)
class BotProcessing(Event):
    """A bot has been picked and is about to start producing a reply."""

    bot_id: str
    username: str

    def _payload(self) -> dict:
        return {"bot_id": self.bot_id, "username": self.username}

    def to_ws_frame(self) -> dict:
        return {"type": "bot_processing", "data": self._payload()}

    def to_sse(self) -> tuple[str, dict]:
        return "bot_processing", self._payload()


@dataclass(slots=True)
class MessageDone(Event):
    msg_id: str
    content: str
    file_ids: list[str] | None = None
    files: list[dict] | None = None
    is_partial: bool | None = None
    error: str | None = None

    def _payload(self) -> dict:
        d: dict = {"msg_id": self.msg_id, "content": self.content}
        if self.is_partial is not None:
            d["is_partial"] = self.is_partial
        if self.error is not None:
            d["error"] = self.error
        if self.file_ids is not None:
            d["file_ids"] = self.file_ids
        if self.files is not None:
            d["files"] = self.files
        return d

    def to_ws_frame(self) -> dict:
        return {"type": "message_done", "data": self._payload()}

    def to_sse(self) -> tuple[str, dict]:
        return "done", self._payload()
