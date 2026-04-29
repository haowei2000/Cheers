"""Wire-format golden tests for orchestrator EventBus.

These tests lock the WS frame and SSE event payloads emitted by every
event type. They run without a database — the goal is a fast regression
safety net for the upcoming pipeline-v2 structural changes (Phase 2–4).

If a frontend client depends on a payload key, this file is where the
contract gets pinned. Changing wire format means updating the goldens
here and in the frontend handler at the same time.
"""
from __future__ import annotations

import pytest

from app.services.pipeline.bus import (
    NullEventBus,
    SSEEventBus,
    TeeEventBus,
    WSEventBus,
    make_event_bus,
)
from app.services.pipeline.events import (
    BotMessagePlaceholder,
    BotProcessing,
    MessageCreated,
    MessageDone,
    MessageStreamDelta,
)


class _RecordingWS:
    def __init__(self) -> None:
        self.frames: list[tuple[str, dict]] = []

    async def broadcast_to_channel(self, channel_id: str, frame: dict) -> None:
        self.frames.append((channel_id, frame))


@pytest.fixture
def patched_ws(monkeypatch: pytest.MonkeyPatch) -> _RecordingWS:
    rec = _RecordingWS()
    import app.services.ws_service as wssvc

    monkeypatch.setattr(wssvc.ws_manager, "broadcast_to_channel", rec.broadcast_to_channel)
    return rec


def test_message_stream_delta_wire_format() -> None:
    e = MessageStreamDelta(msg_id="m1", delta="hi")
    assert e.to_ws_frame() == {
        "type": "message_stream",
        "data": {"msg_id": "m1", "delta": "hi"},
    }
    assert e.to_sse() == ("delta", {"msg_id": "m1", "delta": "hi"})


def test_message_created_wire_format() -> None:
    data = {"msg_id": "m1", "content": "hello", "sender_name": "Bot"}
    e = MessageCreated(data=data)
    assert e.to_ws_frame() == {"type": "message", "data": data}
    assert e.to_sse() == ("message", data)


def test_bot_message_placeholder_wire_format() -> None:
    """Placeholder shares the WS frame with MessageCreated but differs on SSE.

    The frontend uses the same WS handler ('message' type) for both;
    SSE clients distinguish 'message' (final) from 'bot_message' (empty
    bubble awaiting deltas).
    """
    data = {"msg_id": "m2"}
    e = BotMessagePlaceholder(data=data)
    assert e.to_ws_frame() == {"type": "message", "data": data}
    assert e.to_sse() == ("bot_message", data)


def test_bot_processing_wire_format() -> None:
    e = BotProcessing(bot_id="b1", username="alice")
    payload = {"bot_id": "b1", "username": "alice"}
    assert e.to_ws_frame() == {"type": "bot_processing", "data": payload}
    assert e.to_sse() == ("bot_processing", payload)


def test_message_done_wire_format_no_files() -> None:
    e = MessageDone(msg_id="m3", content="bye")
    payload = {"msg_id": "m3", "content": "bye"}
    assert e.to_ws_frame() == {"type": "message_done", "data": payload}
    assert e.to_sse() == ("done", payload)


def test_message_done_wire_format_with_files() -> None:
    files = [{"file_id": "f1", "original_filename": "a.md"}]
    e = MessageDone(
        msg_id="m4", content="x", file_ids=["f1"], files=files,
    )
    payload = {"msg_id": "m4", "content": "x", "file_ids": ["f1"], "files": files}
    assert e.to_ws_frame() == {"type": "message_done", "data": payload}
    assert e.to_sse() == ("done", payload)


def test_message_done_wire_format_partial_stream() -> None:
    """OpenClaw bridge's finalize_stream emits is_partial + optional error
    alongside the standard fields. Key order matches the legacy hand-written
    dict so existing WS clients see byte-identical frames."""
    e = MessageDone(msg_id="m5", content="hi", is_partial=True, error="user_cancelled")
    payload = {
        "msg_id": "m5",
        "content": "hi",
        "is_partial": True,
        "error": "user_cancelled",
    }
    assert e.to_ws_frame() == {"type": "message_done", "data": payload}
    assert e.to_sse() == ("done", payload)


def test_message_done_wire_format_partial_with_files() -> None:
    files = [{"file_id": "f1"}]
    e = MessageDone(
        msg_id="m6", content="x", is_partial=False, file_ids=["f1"], files=files,
    )
    payload = {
        "msg_id": "m6",
        "content": "x",
        "is_partial": False,
        "file_ids": ["f1"],
        "files": files,
    }
    assert e.to_ws_frame() == {"type": "message_done", "data": payload}
    assert e.to_sse() == ("done", payload)


def test_make_event_bus_returns_null_when_no_sinks() -> None:
    bus = make_event_bus("ch", stream_to_ws=False, stream_event=None)
    assert isinstance(bus, NullEventBus)


def test_make_event_bus_returns_single_sink() -> None:
    ws_only = make_event_bus("ch", stream_to_ws=True, stream_event=None)
    assert isinstance(ws_only, WSEventBus)

    async def emit(_n: str, _d: dict) -> None:
        return

    sse_only = make_event_bus("ch", stream_to_ws=False, stream_event=emit)
    assert isinstance(sse_only, SSEEventBus)


def test_make_event_bus_tees_when_both_sinks_active() -> None:
    async def emit(_n: str, _d: dict) -> None:
        return

    bus = make_event_bus("ch", stream_to_ws=True, stream_event=emit)
    assert isinstance(bus, TeeEventBus)


async def test_ws_event_bus_publishes_through_ws_manager(patched_ws: _RecordingWS) -> None:
    bus = WSEventBus("ch1")
    await bus.publish(MessageStreamDelta(msg_id="m", delta="x"))
    await bus.publish(MessageCreated(data={"msg_id": "m"}))
    await bus.publish(MessageDone(msg_id="m", content="done"))

    assert patched_ws.frames == [
        ("ch1", {"type": "message_stream", "data": {"msg_id": "m", "delta": "x"}}),
        ("ch1", {"type": "message", "data": {"msg_id": "m"}}),
        ("ch1", {"type": "message_done", "data": {"msg_id": "m", "content": "done"}}),
    ]


async def test_sse_event_bus_forwards_to_callback() -> None:
    captured: list[tuple[str, dict]] = []

    async def emit(name: str, data: dict) -> None:
        captured.append((name, data))

    bus = SSEEventBus(emit)
    await bus.publish(MessageCreated(data={"msg_id": "a"}))
    await bus.publish(BotMessagePlaceholder(data={"msg_id": "b"}))
    await bus.publish(MessageStreamDelta(msg_id="b", delta="hi"))
    await bus.publish(MessageDone(msg_id="b", content="hi"))

    assert captured == [
        ("message", {"msg_id": "a"}),
        ("bot_message", {"msg_id": "b"}),
        ("delta", {"msg_id": "b", "delta": "hi"}),
        ("done", {"msg_id": "b", "content": "hi"}),
    ]


async def test_tee_bus_dispatches_to_all_sinks(patched_ws: _RecordingWS) -> None:
    sse: list[tuple[str, dict]] = []

    async def emit(name: str, data: dict) -> None:
        sse.append((name, data))

    bus = make_event_bus("ch2", stream_to_ws=True, stream_event=emit)
    await bus.publish(MessageStreamDelta(msg_id="m", delta="hi"))

    assert patched_ws.frames == [
        ("ch2", {"type": "message_stream", "data": {"msg_id": "m", "delta": "hi"}}),
    ]
    assert sse == [("delta", {"msg_id": "m", "delta": "hi"})]


async def test_null_bus_is_silent(patched_ws: _RecordingWS) -> None:
    bus = NullEventBus()
    await bus.publish(MessageStreamDelta(msg_id="m", delta="hi"))
    assert patched_ws.frames == []
