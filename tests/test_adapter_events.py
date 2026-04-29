"""AdapterEvent contract tests + ABC default-wrapping behaviour.

Verifies:

1. The Delta / Final / DispatchedAsync dataclasses round-trip and carry
   their documented fields.
2. OpenClawAdapter's default ``execute_iter`` wraps a legacy ``execute``
   that returns AgentResponse — a non-streaming adapter still produces a
   single Final via the iterator.
3. _drain_execute_iter inverts that, reducing a streaming adapter's
   Delta+Final stream into an AgentResponse.

No DB / bus dependency — these are fast unit tests.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.services.adapters.base import AgentPayload, AgentResponse, OpenClawAdapter
from app.services.pipeline.adapter_events import (
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


# ── Default execute_iter wraps legacy execute ──────────────────────────


class _LegacyAdapter(OpenClawAdapter):
    """Adapter that implements only the legacy single-result execute()."""

    def __init__(self, resp: AgentResponse) -> None:
        self._resp = resp

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return self._resp

    async def health_check(self) -> bool:
        return True


async def test_default_execute_iter_wraps_success() -> None:
    resp = AgentResponse(
        content="hi", task_id="t-1", success=True, file_ids=["f1"],
    )
    adapter = _LegacyAdapter(resp)
    events: list[AdapterEvent] = []
    async for ev in adapter.execute_iter(_payload()):
        events.append(ev)
    assert len(events) == 1
    final = events[0]
    assert isinstance(final, Final)
    assert final.content == "hi"
    assert final.success is True
    assert final.file_ids == ["f1"]


async def test_default_execute_iter_wraps_dispatched_async() -> None:
    resp = AgentResponse(
        content="", task_id="t-1", success=True, dispatched_async=True,
    )
    adapter = _LegacyAdapter(resp)
    events: list[AdapterEvent] = []
    async for ev in adapter.execute_iter(_payload()):
        events.append(ev)
    assert len(events) == 1
    assert isinstance(events[0], DispatchedAsync)


async def test_default_execute_iter_wraps_error() -> None:
    resp = AgentResponse(
        content="", task_id="t-1", success=False, error_message="upstream down",
    )
    adapter = _LegacyAdapter(resp)
    events: list[AdapterEvent] = []
    async for ev in adapter.execute_iter(_payload()):
        events.append(ev)
    assert len(events) == 1
    final = events[0]
    assert isinstance(final, Final)
    assert final.success is False
    assert final.error_message == "upstream down"


# ── _drain_execute_iter reduces streaming adapter to AgentResponse ─────


class _StreamingAdapter(OpenClawAdapter):
    """Adapter that yields multiple Delta then a Final natively."""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return await self._drain_execute_iter(payload)

    async def execute_iter(
        self, payload: AgentPayload,
    ) -> AsyncIterator[AdapterEvent]:
        yield Delta(text="he")
        yield Delta(text="llo")
        yield Final(content="hello", success=True, file_ids=["fid"])

    async def health_check(self) -> bool:
        return True


async def test_drain_reduces_deltas_into_final_content() -> None:
    """_drain_execute_iter takes the Final's content (not the joined deltas)
    so adapters whose Final.content differs from concatenated deltas (e.g.
    post-processed text) still produce the canonical full reply."""
    adapter = _StreamingAdapter()
    resp = await adapter.execute(_payload())
    assert resp.content == "hello"
    assert resp.success is True
    assert resp.file_ids == ["fid"]
    assert resp.dispatched_async is False


class _NoTerminalAdapter(OpenClawAdapter):
    """Pathological adapter that yields Delta but never a Final."""

    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return await self._drain_execute_iter(payload)

    async def execute_iter(
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
    resp = await adapter.execute(_payload())
    assert resp.success is False
    assert resp.content == "oops"
    assert resp.error_message and "no terminal" in resp.error_message


# ── DispatchedAsync conformance ────────────────────────────────────────


class _AsyncDispatchAdapter(OpenClawAdapter):
    async def execute(self, payload: AgentPayload) -> AgentResponse:
        return await self._drain_execute_iter(payload)

    async def execute_iter(
        self, payload: AgentPayload,
    ) -> AsyncIterator[AdapterEvent]:
        yield DispatchedAsync()

    async def health_check(self) -> bool:
        return True


async def test_drain_handles_dispatched_async() -> None:
    adapter = _AsyncDispatchAdapter()
    resp = await adapter.execute(_payload("t-2"))
    assert resp.dispatched_async is True
    assert resp.success is True
    assert resp.content == ""
    assert resp.task_id == "t-2"


# Suppress an asyncio_mode hint mismatch for the sync tests above.
pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")
