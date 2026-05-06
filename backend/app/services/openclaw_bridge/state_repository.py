"""OpenClaw bridge state repository boundary.

The current implementation intentionally keeps live state in memory for the
single-backend deployment. This module gives the bridge a small seam for a
future Redis/PostgreSQL-backed repository without changing route or adapter
callers again.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.openclaw_bridge.pending import pending_replies
from app.services.openclaw_bridge.registry import bot_session_registry
from app.services.openclaw_bridge.streams import stream_registry


@dataclass(frozen=True)
class OpenClawStateSnapshot:
    bot_sessions: int
    pending: int
    streams: int


class InMemoryOpenClawStateRepository:
    def snapshot(self) -> OpenClawStateSnapshot:
        return OpenClawStateSnapshot(
            bot_sessions=bot_session_registry.session_count(),
            pending=pending_replies.count(),
            streams=stream_registry.count(),
        )

    def connection_state(self, bot_id: str) -> dict:
        return bot_session_registry.connection_state(bot_id)


_repository = InMemoryOpenClawStateRepository()


def get_openclaw_state_repository() -> InMemoryOpenClawStateRepository:
    return _repository
