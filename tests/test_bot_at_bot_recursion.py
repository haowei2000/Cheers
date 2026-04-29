"""Tests for Bot@Bot recursion invariants in trigger_sub_bots_from_mentions.

Locks four documented behaviours of ``pipeline.bot.stages.dispatch.
trigger_sub_bots_from_mentions``:

1. Mentions outside the channel are ignored.
2. Already-triggered bots are skipped (cycle break via triggered_bot_ids).
3. A bot doesn't recursively call itself.
4. Recursion stops at depth >= MAX_BOT_MENTION_DEPTH.

dispatch_one is stubbed so the tests don't touch a DB / adapter — they
verify the routing/recursion logic in isolation.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from unittest.mock import MagicMock

import pytest

from app.services.pipeline.bot.stages import dispatch as dispatch_module
from app.services.pipeline.bot.stages.dispatch import (
    MAX_BOT_MENTION_DEPTH,
    trigger_sub_bots_from_mentions,
)


@dataclass
class _FakeMsg:
    msg_id: str = "parent-1"
    content: str = ""


@dataclass
class _RecordingDispatcher:
    """Captures (bot_id, depth, in_reply_to_msg_id) for each dispatch_one call."""
    calls: list[tuple[str, int, str | None]] = field(default_factory=list)

    async def __call__(
        self, ctx, bot_id, *, capabilities, recurse, depth, in_reply_to_msg_id, **kwargs,
    ):
        self.calls.append((bot_id, depth, in_reply_to_msg_id))
        return None  # success but no further work


def _make_ctx(channel_bots: list[str], bot_id_by_username: dict[str, str]):
    ctx = MagicMock()
    ctx.channel_bot_usernames = channel_bots
    ctx.bot_id_by_username = dict(bot_id_by_username)
    ctx.triggered_bot_ids = set()
    ctx.bot_messages = []
    ctx.session = MagicMock()
    ctx.writer = MagicMock()
    ctx.adapter_factory = MagicMock()
    ctx.root_task_id = "task-1"
    ctx.trigger_content = "user prompt"
    return ctx


@pytest.fixture
def dispatcher(monkeypatch):
    """Replace dispatch_one with a recorder that doesn't hit DB / adapters."""
    rec = _RecordingDispatcher()
    monkeypatch.setattr(
        "app.services.pipeline.bot.subagent.dispatch_one", rec,
    )
    return rec


# ── Invariant 1: unknown mention skipped ──────────────────────────────


async def test_unknown_mention_does_not_dispatch(dispatcher: _RecordingDispatcher) -> None:
    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    parent = _FakeMsg(content="hey @charlie can you help?")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="user prompt", depth=0,
    )
    assert dispatcher.calls == []


# ── Invariant 2: cycle break ──────────────────────────────────────────


async def test_already_triggered_bot_skipped(dispatcher: _RecordingDispatcher) -> None:
    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    # Pre-populate: pretend bot-b already ran in this orchestrator turn.
    ctx.triggered_bot_ids.add("bot-b")
    parent = _FakeMsg(content="@bob what do you think?")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="user prompt", depth=0,
    )
    assert dispatcher.calls == []


# ── Invariant 3: self-call prevention ────────────────────────────────


async def test_self_mention_skipped(dispatcher: _RecordingDispatcher) -> None:
    """A bot mentioning itself in its reply doesn't trigger an infinite loop."""
    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    parent = _FakeMsg(content="@alice should I do this?")  # alice talking to alice
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="user prompt", depth=0,
    )
    assert dispatcher.calls == []


# ── Invariant 4: depth cap ────────────────────────────────────────────


async def test_depth_cap_stops_recursion(dispatcher: _RecordingDispatcher) -> None:
    """At depth >= MAX_BOT_MENTION_DEPTH the function returns without
    dispatching, even if the parent reply has valid mentions."""
    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    parent = _FakeMsg(content="@bob keep going")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a",
        trigger_content="user prompt", depth=MAX_BOT_MENTION_DEPTH,
    )
    assert dispatcher.calls == []


async def test_depth_cap_is_three(dispatcher: _RecordingDispatcher) -> None:
    """Sanity: the cap value is 3 as documented in the comment / plan."""
    assert MAX_BOT_MENTION_DEPTH == 3


# ── Happy path: dispatch increments depth and threads parent msg_id ──


async def test_valid_mention_dispatches_with_incremented_depth(
    dispatcher: _RecordingDispatcher,
) -> None:
    """A reply mentioning a valid in-channel bot triggers dispatch_one with
    depth=parent_depth+1 and in_reply_to_msg_id=parent_msg.msg_id so the
    sub-reply chains correctly."""
    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    parent = _FakeMsg(msg_id="parent-msg-9", content="@bob jump in")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="user prompt", depth=0,
    )
    assert dispatcher.calls == [("bot-b", 1, "parent-msg-9")]
    # bot-b is now marked as triggered so a later @bob in another reply
    # within the same orchestrator run wouldn't re-fire it.
    assert "bot-b" in ctx.triggered_bot_ids


async def test_multiple_leading_mentions_dispatch_all_unique_bots(
    dispatcher: _RecordingDispatcher,
) -> None:
    """extract_mentions only recognises the leading-mentions block (e.g.
    '@a @b text' → ['a', 'b']; '@a text @b' → ['a']). Bot@Bot recursion
    inherits that behaviour, so the bot's reply must @-mention everything
    it wants to fan out at the very start."""
    ctx = _make_ctx(
        channel_bots=["alice", "bob", "carol"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b", "carol": "bot-c"},
    )
    parent = _FakeMsg(content="@bob @carol please review")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="user prompt", depth=0,
    )
    dispatched_ids = [bot_id for bot_id, _, _ in dispatcher.calls]
    assert dispatched_ids == ["bot-b", "bot-c"]


async def test_mid_text_mention_not_recognised(
    dispatcher: _RecordingDispatcher,
) -> None:
    """Conversely, '@bob' buried inside the body doesn't trigger Bot@Bot —
    only the leading run is parsed."""
    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    parent = _FakeMsg(content="here's the answer, can @bob double-check?")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="user prompt", depth=0,
    )
    assert dispatcher.calls == []


# ── Capabilities.regular: sub-bots inherit full call_bot ──────────────


async def test_sub_bots_get_regular_capabilities(monkeypatch) -> None:
    """Bot@Bot recursion uses Capabilities.regular() so sub-bots can
    themselves @-mention further bots (until the depth cap or cycle break
    fires). Auto-takeover suggestees, by contrast, get Capabilities.leaf()
    — see test_pipeline_build_payload."""
    captured: list[object] = []

    async def fake_dispatch(ctx, bot_id, *, capabilities, **kwargs):
        captured.append(capabilities)
        return None

    monkeypatch.setattr(
        "app.services.pipeline.bot.subagent.dispatch_one", fake_dispatch,
    )

    ctx = _make_ctx(
        channel_bots=["alice", "bob"],
        bot_id_by_username={"alice": "bot-a", "bob": "bot-b"},
    )
    parent = _FakeMsg(content="@bob")
    await trigger_sub_bots_from_mentions(
        ctx, parent, parent_bot_id="bot-a", trigger_content="x", depth=0,
    )
    assert len(captured) == 1
    from app.services.pipeline.bot.capabilities import Capabilities
    assert captured[0] == Capabilities.regular()


# Avoid an unused-import lint when running tests in isolation.
_ = dispatch_module
