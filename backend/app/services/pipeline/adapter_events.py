"""AdapterEvent: events streamed by an adapter's ``execute_iter`` AsyncIterator.

A well-behaved adapter yields zero or more ``Delta`` events (token chunks)
followed by exactly one terminal event — either ``Final`` (the adapter
finished and produced the full reply) or ``DispatchedAsync`` (the adapter
handed off to an external system, e.g. an OpenClaw plugin via the
WebSocket bridge; the actual reply will arrive later).

This is the streaming primitive that replaces the legacy
``AgentResponse`` + ``_stream_token`` callback split: callers
async-iterate the adapter and republish ``Delta`` to the channel
EventBus, then act on the terminal event.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class Delta:
    """One token / chunk of streaming output."""

    text: str


@dataclass(slots=True)
class Final:
    """Adapter finished. Carries the full reply + status."""

    content: str
    success: bool = True
    error_message: str | None = None
    file_ids: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DispatchedAsync:
    """Adapter handed off to an external async system (e.g. OpenClaw
    plugin via WS); the actual reply will arrive later through the bridge.
    The orchestrator records the placeholder as pending and arms a timeout."""


AdapterEvent = Delta | Final | DispatchedAsync
