"""Agent Bridge state repository boundary.

The current implementation intentionally keeps live state in memory for the
single-backend deployment. This module gives the bridge a small boundary for a
future Redis/PostgreSQL-backed repository without changing route or adapter
callers again.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.features.agent_bridge.pending import pending_replies
from app.features.agent_bridge.registry import bot_session_registry
from app.features.agent_bridge.streams import stream_registry


@dataclass(frozen=True)
class AgentBridgeStateSnapshot:
    bot_sessions: int
    pending: int
    streams: int


class InMemoryAgentBridgeStateRepository:
    def snapshot(self) -> AgentBridgeStateSnapshot:
        return AgentBridgeStateSnapshot(
            bot_sessions=bot_session_registry.session_count(),
            pending=pending_replies.count(),
            streams=stream_registry.count(),
        )

    def connection_state(self, bot_id: str) -> dict:
        return bot_session_registry.connection_state(bot_id)


_repository = InMemoryAgentBridgeStateRepository()


def get_agent_bridge_state_repository() -> InMemoryAgentBridgeStateRepository:
    return _repository
