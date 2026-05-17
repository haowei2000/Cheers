"""HistoryPage length-based memory pagination tests."""
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import asc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, HistoryPage, Message, User, Workspace
from app.features.memory.channel_memory import ChannelMemory
from app.features.memory.history_pager import (
    compact_channel_history,
    get_current_page,
    render_current_page_summary,
)
from app.repositories.message_repo import MessageRepository


async def _seed_channel(session: AsyncSession, suffix: str) -> str:
    user = User(
        user_id=f"hist-user-{suffix}",
        username=f"hist_user_{suffix}",
        password_hash="x",
        display_name=f"History User {suffix}",
    )
    ws = Workspace(workspace_id=f"hist-ws-{suffix}", name=f"History WS {suffix}")
    ch = Channel(
        channel_id=f"hist-channel-{suffix}",
        workspace_id=ws.workspace_id,
        name=f"history-{suffix}",
        type="public",
    )
    session.add_all([user, ws, ch])
    await session.flush()
    return ch.channel_id


async def _add_messages(
    session: AsyncSession,
    channel_id: str,
    suffix: str,
    contents: list[str],
) -> None:
    base = datetime(2026, 1, 1, 12, 0, 0)
    for idx, content in enumerate(contents, start=1):
        session.add(
            Message(
                msg_id=f"hist-msg-{suffix}-{idx:02d}",
                channel_id=channel_id,
                sender_id=f"hist-user-{suffix}",
                sender_type="user",
                content=content,
                created_at=base + timedelta(minutes=idx),
            )
        )
    await session.flush()


async def _pages(session: AsyncSession, channel_id: str) -> list[HistoryPage]:
    result = await session.execute(
        select(HistoryPage)
        .where(HistoryPage.channel_id == channel_id)
        .order_by(asc(HistoryPage.page_number))
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_length_compaction_creates_page_when_threshold_exceeded(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "threshold")
    await _add_messages(
        db_session,
        channel_id,
        "threshold",
        ["alpha " * 10, "beta " * 10],
    )

    with patch("app.config.settings.memory_history_page_max_chars", new=220):
        created = await compact_channel_history(channel_id, db_session)

    pages = await _pages(db_session, channel_id)
    assert created == 1
    assert len(pages) == 1
    assert pages[0].page_number == 1
    assert pages[0].message_count == 2
    assert len(pages[0].raw_content) >= 220


@pytest.mark.asyncio
async def test_short_tail_stays_as_current_page(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "tail")
    await _add_messages(db_session, channel_id, "tail", ["short one", "short two"])

    with patch("app.config.settings.memory_history_page_max_chars", new=10000):
        created = await compact_channel_history(channel_id, db_session)

    current_page = await get_current_page(db_session, channel_id)
    summary = await render_current_page_summary(channel_id, db_session)
    assert created == 0
    assert await _pages(db_session, channel_id) == []
    assert current_page.page_number == 1
    assert current_page.last_sealed_msg_id is None
    assert [m.content for m in current_page.messages] == ["short one", "short two"]
    assert "short one" in summary
    assert "short two" in summary

    with patch("app.config.settings.memory_history_current_message_count", new=0):
        assert await render_current_page_summary(channel_id, db_session) == ""


@pytest.mark.asyncio
async def test_single_oversized_message_becomes_own_page(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "oversized")
    await _add_messages(db_session, channel_id, "oversized", ["x" * 300])

    with patch("app.config.settings.memory_history_page_max_chars", new=180):
        created = await compact_channel_history(channel_id, db_session)

    pages = await _pages(db_session, channel_id)
    current_page = await get_current_page(db_session, channel_id)
    assert created == 1
    assert len(pages) == 1
    assert pages[0].message_count == 1
    assert current_page.page_number == 2
    assert current_page.messages == []


@pytest.mark.asyncio
async def test_large_history_can_create_multiple_contiguous_pages(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "multi")
    await _add_messages(
        db_session,
        channel_id,
        "multi",
        [f"message {idx} " * 5 for idx in range(1, 6)],
    )

    with patch("app.config.settings.memory_history_page_max_chars", new=260):
        created = await compact_channel_history(channel_id, db_session)

    pages = await _pages(db_session, channel_id)
    current_page = await get_current_page(db_session, channel_id)
    assert created >= 2
    assert [p.page_number for p in pages] == list(range(1, len(pages) + 1))
    assert current_page.page_number == pages[-1].page_number + 1
    assert current_page.last_sealed_msg_id == pages[-1].last_msg_id
    assert [m.content for m in current_page.messages] == ["message 5 " * 5]


@pytest.mark.asyncio
async def test_channel_memory_history_combines_current_page_and_page_summaries(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "history")
    await _add_messages(
        db_session,
        channel_id,
        "history",
        [
            "first sealed message " * 8,
            "second sealed message " * 4,
            "tail-current-page-entry",
        ],
    )

    with patch("app.config.settings.memory_history_page_max_chars", new=360):
        await compact_channel_history(channel_id, db_session)

    mem = await ChannelMemory.load_layers(channel_id, db_session, {"history"})
    history = mem.to_context_dict()["history"]
    assert "current_page:" in history
    assert "<history-1" in history
    assert "tail-current-page-entry" in history
    assert "history_summary_pages:" in history
    assert "page_id:" in history


@pytest.mark.asyncio
async def test_message_repository_pagination_ignores_history_pages(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "repo")
    await _add_messages(db_session, channel_id, "repo", ["one", "two", "three"])

    with patch("app.config.settings.memory_history_page_max_chars", new=180):
        await compact_channel_history(channel_id, db_session)

    listed = await MessageRepository(db_session).list_by_channel(channel_id, limit=2)
    assert [m.content for m in listed] == ["two", "three"]


@pytest.mark.asyncio
async def test_message_repository_pagination_uses_msg_id_tiebreaker(db_session: AsyncSession) -> None:
    channel_id = await _seed_channel(db_session, "tie")
    created_at = datetime(2026, 1, 1, 12, 0, 0)
    for idx, content in enumerate(["one", "two", "three", "four"], start=1):
        db_session.add(
            Message(
                msg_id=f"hist-msg-tie-{idx:02d}",
                channel_id=channel_id,
                sender_id="hist-user-tie",
                sender_type="user",
                content=content,
                created_at=created_at,
            )
        )
    await db_session.flush()

    first_page = await MessageRepository(db_session).list_by_channel(channel_id, limit=2)
    assert [m.content for m in first_page] == ["three", "four"]

    older_page = await MessageRepository(db_session).list_by_channel(
        channel_id,
        limit=2,
        before_id=first_page[0].msg_id,
    )
    assert [m.content for m in older_page] == ["one", "two"]
