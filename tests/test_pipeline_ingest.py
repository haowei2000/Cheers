"""IngestPipeline stage unit tests (no DB).

Covers SecretEnvelopeStage and EmitStage in isolation. ValidateStage,
PersistStage, and FanoutUnreadStage need a real DB / WS — they're
exercised via the existing route-level integration tests once Phase 2
wires the pipeline into routes.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from app.services.pipeline.events import Event, MessageCreated
from app.services.pipeline.ingest.context import IngestContext
from app.services.pipeline.ingest.stages import (
    SECRET_PLACEHOLDER,
    EmitStage,
    SecretEnvelopeStage,
)


class _RecordingBus:
    def __init__(self) -> None:
        self.published: list[Event] = []

    async def publish(self, event: Event) -> None:
        self.published.append(event)


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


async def test_emit_stage_raises_when_persist_skipped() -> None:
    ctx = _make_ctx()
    with pytest.raises(RuntimeError, match="PersistStage must run"):
        await EmitStage().run(ctx)


async def test_emit_stage_publishes_message_created(monkeypatch: pytest.MonkeyPatch) -> None:
    bus = _RecordingBus()
    ctx = _make_ctx(bus=bus)
    ctx.msg = _FakeMsg(
        msg_id="m-1", channel_id="ch1", content="hi", file_ids=[],
    )

    # MessageInResponse.model_validate checks ORM mapping; bypass with a
    # monkeypatch that returns a stable dict so this test stays free of DB
    # / Pydantic ORM coupling.
    captured: dict = {}

    class _FakeResp:
        @staticmethod
        def model_dump() -> dict:
            return {"msg_id": "m-1", "channel_id": "ch1", "content": "hi"}

    def _fake_validate(_msg):
        captured["called"] = True
        return _FakeResp()

    import app.services.pipeline.ingest.stages as stages_mod

    monkeypatch.setattr(stages_mod.MessageInResponse, "model_validate", _fake_validate)

    await EmitStage().run(ctx)

    assert captured.get("called") is True
    assert ctx.payload == {
        "msg_id": "m-1", "channel_id": "ch1", "content": "hi", "files": [],
    }
    assert len(bus.published) == 1
    event = bus.published[0]
    assert isinstance(event, MessageCreated)
    assert event.data == ctx.payload
