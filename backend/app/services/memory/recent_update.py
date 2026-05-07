"""Compatibility hooks for RECENT updates.

RECENT is now rendered at load time from:
- the current page, and
- sealed HistoryPage summaries.

This module keeps the historical function names used by message routes, but
the side effect is backend memory compaction rather than context_store writes.
"""
from __future__ import annotations

import logging

from app.services.memory.history_pager import (
    compact_channel_history,
    schedule_history_compaction,
)

logger = logging.getLogger("app.services.memory.recent_update")


async def update_recent_async(channel_id: str) -> None:
    """Compatibility entry point: compact memory pages for this channel."""
    try:
        await compact_channel_history(channel_id)
    except Exception as exc:
        logger.warning(
            "update_recent_async: failed to compact history channel=%s: %s",
            channel_id,
            exc,
        )


def schedule_recent_update(channel_id: str) -> None:
    """Compatibility entry point used by message routes."""
    schedule_history_compaction(channel_id)
