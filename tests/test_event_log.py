"""Per-bot data stream 事件日志 + seq 计数 + resume 回放单测。

这些测试需要真实 DB（事件写入 openclaw_plugin_events 表）。
跑前设 TEST_DATABASE_URL 指向 docker postgres，或依赖 conftest 的 db_engine
fixture（创建临时 schema）。为避免跨测试相互影响，用 uuid 前缀隔离 bot_id。
"""
from __future__ import annotations

import uuid

import pytest

from app.services.openclaw_bridge.event_log import (
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
    # 各自独立的 seq
    assert await current_seq(a, "data") == 2
    assert await current_seq(b, "data") == 1


@pytest.mark.asyncio
async def test_events_since_replays_in_order(db_engine) -> None:
    bot_id = _uniq("bot-replay")
    for i in range(1, 6):
        await record_event(bot_id, "data", {"type": "message", "idx": i})

    events = await events_since(bot_id, "data", last_seq=2)
    assert [e["idx"] for e in events] == [3, 4, 5]
    # seq 字段被附加
    assert all("seq" in e for e in events)

    all_events = await events_since(bot_id, "data", last_seq=0)
    assert len(all_events) == 5

    none = await events_since(bot_id, "data", last_seq=99999)
    assert none == []


@pytest.mark.asyncio
async def test_seq_bootstraps_from_db_for_new_counter(db_engine) -> None:
    """模拟进程重启：DB 中已有 seq=3，新 counter 实例应接着 4。"""
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
