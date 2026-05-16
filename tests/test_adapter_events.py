"""AdapterEvent contract tests + execute-stream reduction behaviour.

Verifies:

1. The Delta / Final / DispatchedAsync dataclasses round-trip and carry
   their documented fields.
2. BotAdapter exposes one execution method, ``execute``, which streams
   AdapterEvent values.
3. ``drain_events_to_response`` reduces Delta+Final streams into an
   AgentResponse when tests or compatibility code need the legacy shape.

No DB / bus dependency — these are fast unit tests.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.features.bot_runtime.adapters.base import (
    AgentPayload,
    BotAdapter,
    drain_events_to_response,
)
from app.features.bot_runtime.pipeline.adapter_events import (
    AdapterEvent,
    Delta,
    DispatchedAsync,
    Final,
)


def _payload(task_id: str = "t-1") -> AgentPayload:
    return AgentPayload(
        task_id=task_id,
        channel_id="ch-1",
        trigger_message={},
        memory_context={},
    )


# ── Event dataclasses ──────────────────────────────────────────────────


def test_delta_carries_text() -> None:
    d = Delta(text="hello")
    assert d.text == "hello"


def test_final_defaults() -> None:
    f = Final(content="ok")
    assert f.success is True
    assert f.error_message is None
    assert f.file_ids == []


def test_final_with_error() -> None:
    f = Final(content="", success=False, error_message="boom", file_ids=["f1"])
    assert f.success is False
    assert f.error_message == "boom"
    assert f.file_ids == ["f1"]


def test_dispatched_async_is_marker() -> None:
    """DispatchedAsync carries no fields — it's just a terminal sentinel."""
    DispatchedAsync()  # constructible, no args


# ── execute streams AdapterEvent values ────────────────────────────────


class _StreamingAdapter(BotAdapter):
    """Adapter that yields multiple Delta then a Final."""

    async def execute(
        self, payload: AgentPayload,
    ) -> AsyncIterator[AdapterEvent]:
        yield Delta(text="he")
        yield Delta(text="llo")
        yield Final(content="hello", success=True, file_ids=["fid"])

    async def health_check(self) -> bool:
        return True


async def test_execute_streams_events() -> None:
    adapter = _StreamingAdapter()
    events = [event async for event in adapter.execute(_payload())]
    assert [type(event) for event in events] == [Delta, Delta, Final]


async def test_drain_reduces_deltas_into_final_content() -> None:
    """The reducer takes the Final's content (not the joined deltas)
    so adapters whose Final.content differs from concatenated deltas (e.g.
    post-processed text) still produce the canonical full reply."""
    adapter = _StreamingAdapter()
    payload = _payload()
    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
    assert resp.content == "hello"
    assert resp.success is True
    assert resp.file_ids == ["fid"]
    assert resp.dispatched_async is False


class _NoTerminalAdapter(BotAdapter):
    """Pathological adapter that yields Delta but never a Final."""

    async def execute(
        self, payload: AgentPayload,
    ) -> AsyncIterator[AdapterEvent]:
        yield Delta(text="oops")
        # no Final / DispatchedAsync — drain falls back to deltas

    async def health_check(self) -> bool:
        return True


async def test_drain_falls_back_when_no_terminal() -> None:
    """A buggy adapter that forgets to yield Final still gets a sensible
    AgentResponse: the joined deltas as content, success=False with a
    descriptive error."""
    adapter = _NoTerminalAdapter()
    payload = _payload()
    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
    assert resp.success is False
    assert resp.content == "oops"
    assert resp.error_message and "no terminal" in resp.error_message


# ── DispatchedAsync conformance ────────────────────────────────────────


class _AsyncDispatchAdapter(BotAdapter):
    async def execute(
        self, payload: AgentPayload,
    ) -> AsyncIterator[AdapterEvent]:
        yield DispatchedAsync()

    async def health_check(self) -> bool:
        return True


async def test_drain_handles_dispatched_async() -> None:
    adapter = _AsyncDispatchAdapter()
    payload = _payload("t-2")
    resp = await drain_events_to_response(adapter.execute(payload), task_id=payload.task_id)
    assert resp.dispatched_async is True
    assert resp.success is True
    assert resp.content == ""
    assert resp.task_id == "t-2"


# Suppress an asyncio_mode hint mismatch for the sync tests above.
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")
