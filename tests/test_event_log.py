"""Unit tests for per-bot data stream event logs, seq counters, and resume replay.

These tests need a real database because events are written to the
agent_bridge_events table. Set TEST_DATABASE_URL to Docker Postgres before
running, or rely on the db_engine fixture from conftest to create a temporary
schema. UUID prefixes isolate bot_id values across tests.
"""
from __future__ import annotations

import uuid

import pytest

from app.features.agent_bridge.event_log import (
    BotEventSeq,
    current_seq,
    events_since,
    record_event,
)


def _uniq(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@pytest.mark.asyncio
async def test_record_event_assigns_monotonic_seq(db_engine) -> None:
    bot_id = _uniq("bot-log")
    seq1 = await record_event(bot_id, "data", {"type": "message", "idx": 1})
    seq2 = await record_event(bot_id, "data", {"type": "message", "idx": 2})
    seq3 = await record_event(bot_id, "data", {"type": "message", "idx": 3})
    assert seq2 == seq1 + 1
    assert seq3 == seq2 + 1


@pytest.mark.asyncio
async def test_seq_is_per_bot_stream(db_engine) -> None:
    a = _uniq("bot-A")
    b = _uniq("bot-B")
    await record_event(a, "data", {"x": 1})
    await record_event(a, "data", {"x": 2})
    await record_event(b, "data", {"x": 1})
    # Each bot has an independent seq.
    assert await current_seq(a, "data") == 2
    assert await current_seq(b, "data") == 1


@pytest.mark.asyncio
async def test_events_since_replays_in_order(db_engine) -> None:
    bot_id = _uniq("bot-replay")
    for i in range(1, 6):
        await record_event(bot_id, "data", {"type": "message", "idx": i})

    events = await events_since(bot_id, "data", last_seq=2)
    assert [e["idx"] for e in events] == [3, 4, 5]
    # The seq field is attached.
    assert all("seq" in e for e in events)

    all_events = await events_since(bot_id, "data", last_seq=0)
    assert len(all_events) == 5

    none = await events_since(bot_id, "data", last_seq=99999)
    assert none == []


@pytest.mark.asyncio
async def test_seq_bootstraps_from_db_for_new_counter(db_engine) -> None:
    """Simulate process restart: DB has seq=3, so a fresh counter continues at 4."""
    bot_id = _uniq("bot-boot")
    for _ in range(3):
        await record_event(bot_id, "data", {"x": 1})
    fresh = BotEventSeq()
    nxt = await fresh.next(bot_id, "data")
    assert nxt == 4


@pytest.mark.asyncio
async def test_events_since_limit(db_engine) -> None:
    bot_id = _uniq("bot-limit")
    for i in range(1, 11):
        await record_event(bot_id, "data", {"idx": i})

    evts = await events_since(bot_id, "data", 0, limit=3)
    assert len(evts) == 3
