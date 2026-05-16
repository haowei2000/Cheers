"""IngestPipeline stage unit tests (no DB).

Covers SecretEnvelopeStage and EmitStage in isolation. ValidateStage,
PersistStage, and FanoutUnreadStage need a real DB / WS — they're
exercised via the existing route-level integration tests once Phase 2
wires the pipeline into routes.py.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest

from app.config import settings
from app.features.bot_runtime.pipeline.events import Event, MessageCreated
from app.features.bot_runtime.pipeline.ingest.context import IngestContext
from app.features.bot_runtime.pipeline.ingest.stages import (
    SECRET_PLACEHOLDER,
    EmitStage,
    SecretEnvelopeStage,
    _publish_unread_events,
)


class _RecordingBus:
    def __init__(self) -> None:
        self.published: list[Event] = []

    async def publish(self, event: Event) -> None:
        self.published.append(event)


class _RecordingRealtimeBroker:
    def __init__(self, *, fail_user_id: str | None = None) -> None:
        self.fail_user_id = fail_user_id
        self.user_frames: list[tuple[str, dict]] = []
        self.active = 0
        self.max_active = 0

    async def publish_user(self, user_id: str, message: dict) -> None:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0.01)
            self.user_frames.append((user_id, message))
            if user_id == self.fail_user_id:
                raise RuntimeError("publish failed")
        finally:
            self.active -= 1

    async def publish_channel(self, channel_id: str, message: dict) -> None:
        return None


@dataclass
class _FakeMsg:
    msg_id: str = "m-test"
    channel_id: str = "ch1"
    sender_id: str = "u1"
    sender_type: str = "user"
    content: str = "hi"
    file_ids: list[str] | None = None
    mention_bot_ids: list[str] | None = None
    mention_user_ids: list[str] | None = None
    in_reply_to_msg_id: str | None = None
    msg_type: str = "normal"
    content_data: dict | None = None
    is_secret: bool = False
    secret_encrypted: str | None = None
    secret_token: str | None = None
    task_id: str | None = None
    is_partial: bool | None = None
    created_at: Any = None


def _make_ctx(**overrides: Any) -> IngestContext:
    base: dict[str, Any] = {
        "channel_id": "ch1",
        "bus": _RecordingBus(),
        "session": None,  # stages under test don't touch session
    }
    base.update(overrides)
    return IngestContext(**base)


# ── SecretEnvelopeStage ────────────────────────────────────────────────


async def test_secret_envelope_passthrough_when_not_secret() -> None:
    ctx = _make_ctx(content="plain text", is_secret=False)
    await SecretEnvelopeStage().run(ctx)
    assert ctx.stored_content == "plain text"
    assert ctx.secret_encrypted is None
    assert ctx.secret_token is None


async def test_secret_envelope_passthrough_when_skip_flag() -> None:
    """Builtin-bot post-back path: skip_secret bypasses encryption even if
    is_secret were ever set true (defensive)."""
    ctx = _make_ctx(content="plain", is_secret=True, skip_secret=True)
    await SecretEnvelopeStage().run(ctx)
    assert ctx.stored_content == "plain"
    assert ctx.secret_encrypted is None
    assert ctx.secret_token is None


async def test_secret_envelope_wraps_when_is_secret() -> None:
    ctx = _make_ctx(content="🔒 confidential", is_secret=True)
    await SecretEnvelopeStage().run(ctx)
    assert ctx.stored_content == SECRET_PLACEHOLDER
    assert ctx.secret_encrypted is not None and ctx.secret_encrypted != "🔒 confidential"
    assert ctx.secret_token is not None
    # token must be unguessable & long enough to resist brute force
    assert len(ctx.secret_token) >= 32


async def test_secret_envelope_unique_token_per_run() -> None:
    ctx1 = _make_ctx(content="x", is_secret=True)
    ctx2 = _make_ctx(content="x", is_secret=True)
    await SecretEnvelopeStage().run(ctx1)
    await SecretEnvelopeStage().run(ctx2)
    assert ctx1.secret_token != ctx2.secret_token


# ── EmitStage ──────────────────────────────────────────────────────────


async def test_emit_stage_raises_when_serialize_skipped() -> None:
    ctx = _make_ctx()
    with pytest.raises(RuntimeError, match="SerializeStage must run"):
        await EmitStage().run(ctx)


async def test_emit_stage_publishes_prebuilt_payload() -> None:
    bus = _RecordingBus()
    ctx = _make_ctx(bus=bus)
    ctx.payload = {"msg_id": "m-1", "content": "hi", "files": []}

    await EmitStage().run(ctx)

    assert len(bus.published) == 1
    event = bus.published[0]
    assert isinstance(event, MessageCreated)
    assert event.data == ctx.payload


async def test_unread_fanout_uses_bounded_concurrency_and_dedupes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.realtime_broker as realtime_broker

    broker = _RecordingRealtimeBroker()
    monkeypatch.setattr(settings, "unread_fanout_concurrency", 3)
    monkeypatch.setattr(realtime_broker, "_broker", broker)
    event = {"type": "channel_new_message", "data": {"channel_id": "ch1"}}

    await _publish_unread_events(["u1", "u2", "u2", "u3", "u4", "u5"], event)

    delivered_user_ids = [user_id for user_id, _ in broker.user_frames]
    assert len(delivered_user_ids) == 5
    assert set(delivered_user_ids) == {"u1", "u2", "u3", "u4", "u5"}
    assert broker.max_active == 3


async def test_unread_fanout_keeps_going_when_one_user_publish_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.realtime_broker as realtime_broker

    broker = _RecordingRealtimeBroker(fail_user_id="u2")
    monkeypatch.setattr(settings, "unread_fanout_concurrency", 2)
    monkeypatch.setattr(realtime_broker, "_broker", broker)
    event = {"type": "channel_new_message", "data": {"channel_id": "ch1"}}

    await _publish_unread_events(["u1", "u2", "u3"], event)

    assert {user_id for user_id, _ in broker.user_frames} == {"u1", "u2", "u3"}
