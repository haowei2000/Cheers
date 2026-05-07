"""Tests for ``pipeline.bot.subagent.build_payload`` capability shape.

The Capabilities tier (regular / coordinator / leaf) is what enforces
auto-takeover suggestees being leaves — they must NOT receive ``_run_ctx``
in process_config, because channel_bot's ``call_bot`` tool refuses to
dispatch further without it. This test pins that invariant.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock

from app.features.bot_runtime.pipeline.bot.capabilities import Capabilities
from app.features.bot_runtime.pipeline.bot.subagent import build_payload


@dataclass
class _FakeMsg:
    msg_id: str = "trig-1"
    sender_id: str = "u1"
    content: str = "hi"
    is_secret: bool = False
    secret_encrypted: str | None = None
    file_ids: list[str] = field(default_factory=list)
    in_reply_to_msg_id: str | None = None
    msg_type: str = "normal"
    sender_type: str = "user"
    created_at: Any = None


@dataclass
class _FakeBotMsg:
    msg_id: str = "bot-msg-1"


def _make_ctx(**overrides):
    """Build a minimal BotRunContext stand-in for build_payload."""
    ctx = MagicMock()
    ctx.channel_id = "ch1"
    ctx.root_task_id = "task-1"
    ctx.trigger_msg = _FakeMsg()
    ctx.trigger_content = "hi"
    ctx.sender_name = "Alice"
    ctx.channel_name = "general"
    ctx.user_secrets = {}
    ctx.memory_context = {}
    ctx.attachments = []
    ctx.original_question = None
    ctx.topic_chain = []
    ctx.child_replies = []
    ctx.bot_id_by_username = {"alice": "bot-a", "bob": "bot-b"}
    ctx.bot_details_by_username = {
        "alice": {"display_name": "Alice"},
        "bob": {"display_name": "Bob"},
    }
    ctx.channel_bot_usernames = ["alice", "bob"]
    ctx.adapter_factory = MagicMock()
    ctx.bus = MagicMock()
    ctx.session = MagicMock()
    ctx.writer = MagicMock()
    ctx.writer.create_and_broadcast = MagicMock()
    for key, val in overrides.items():
        setattr(ctx, key, val)
    return ctx


# ── leaf: recursion-prevention invariant ──────────────────────────────


def test_leaf_payload_omits_run_ctx() -> None:
    """The auto-takeover phase-2 contract: suggested bots cannot recursively
    call_bot. build_payload leaves run_ctx as None for Capabilities.leaf() so
    channel_bot.call_bot's first check ('错误：_run_ctx 未注入') refuses
    to dispatch further."""
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.leaf(),
    )
    assert payload.process_config.run_ctx is None
    assert payload.process_config.db_session is ctx.session
    assert payload.process_config.channel_bot_usernames == []
    assert payload.runtime.run_ctx is None


def test_leaf_payload_omits_msg_id_and_msg_type() -> None:
    """Leaf trigger_message is the minimal shape — no msg_id / msg_type
    so the legacy http_bot clarify-card branch (which gates on msg_type)
    doesn't accidentally fire for suggestees."""
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.leaf(),
    )
    assert "msg_id" not in payload.trigger_message
    assert "msg_type" not in payload.trigger_message


# ── regular: full call_bot capability ─────────────────────────────────


def test_regular_payload_carries_run_ctx() -> None:
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
    )
    assert payload.process_config.run_ctx is ctx
    assert payload.process_config.channel_bot_usernames == ["bob"]
    assert payload.runtime.run_ctx is ctx
    assert payload.runtime.channel_bot_usernames == ["bob"]


def test_regular_payload_includes_msg_id() -> None:
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
    )
    assert payload.trigger_message["msg_id"] == "trig-1"
    assert "msg_type" not in payload.trigger_message  # only coordinator gets this


# ── coordinator: regular + msg_type for clarify rendering ────────────


def test_coordinator_payload_includes_msg_type() -> None:
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.coordinator(),
    )
    assert payload.trigger_message["msg_type"] == "normal"
    assert payload.trigger_message["msg_id"] == "trig-1"
    assert payload.process_config.run_ctx is ctx


# ── overrides ─────────────────────────────────────────────────────────


def test_trigger_text_override_replaces_text() -> None:
    """call_bot dispatches a synthetic sub-task with its own message text."""
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
        trigger_text_override="please summarize this",
    )
    assert payload.trigger_message["text"] == "please summarize this"
    assert payload.message.text == "please summarize this"


def test_payload_uses_pipeline_trigger_content_not_stored_message_content() -> None:
    """Secret messages are stored as a placeholder, but BotPipeline decrypts
    the target-visible trigger text before build_payload runs."""
    trigger_msg = _FakeMsg(
        content="🔒 [加密消息]",
        is_secret=True,
        secret_encrypted="enc:ciphertext",
    )
    ctx = _make_ctx(trigger_msg=trigger_msg, trigger_content="@alice decrypted task")
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
    )
    assert payload.trigger_message["text"] == "@alice decrypted task"
    assert payload.message.text == "@alice decrypted task"


def test_skip_system_prompt_flag_propagates() -> None:
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
        skip_system_prompt=True,
    )
    assert payload.process_config.skip_system_prompt is True


def test_in_reply_to_override_chains_bot_at_bot() -> None:
    """Bot@Bot recursion sets the sub-reply's in_reply_to to the parent
    bot's msg_id so the sub-reply chains correctly."""
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
        in_reply_to_msg_id="parent-bot-msg",
    )
    assert payload.trigger_message["in_reply_to_msg_id"] == "parent-bot-msg"
    assert payload.message.in_reply_to_msg_id == "parent-bot-msg"


def test_payload_groups_message_context_and_runtime() -> None:
    ctx = _make_ctx(
        memory_context={"anchor": "A"},
        attachments=[{"file_id": "f1"}],
        original_question="What now?",
    )
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
    )

    assert payload.message.sender_id == "u1"
    assert payload.message.sender_name == "Alice"
    assert payload.context.memory == {"anchor": "A"}
    assert payload.context.attachments == [{"file_id": "f1"}]
    assert payload.context.original_question_text == "What now?"
    assert payload.runtime.bot_id == "bot-a"
    assert payload.runtime.placeholder_msg_id == "bot-msg-1"


# ── shared invariants ────────────────────────────────────────────────


def test_other_bots_excludes_self() -> None:
    """The receiving bot doesn't see itself listed as a peer in
    channel_bot_usernames / details / id-lookup. Avoids the LLM
    accidentally @-mentioning itself."""
    ctx = _make_ctx()
    payload = build_payload(
        ctx, bot_id="bot-a", bot_msg=_FakeBotMsg(),
        capabilities=Capabilities.regular(),
    )
    assert "alice" not in payload.process_config.channel_bot_usernames
    assert payload.process_config.channel_bot_usernames == ["bob"]
