"""Lightweight context policy for the built-in Coordinator Bot."""
from __future__ import annotations

from dataclasses import dataclass

ALL_COORDINATOR_TOOLS = frozenset({
    "update_anchor",
    "update_progress",
    "update_decision",
    "call_bot",
    "call_user",
    "create_file",
    "read_file",
    "create_todo",
    "list_todos",
    "update_todo",
    "delete_todo",
    "web_fetch",
    "web_search",
    "search_help_docs",
    "read_help_doc",
})


@dataclass(frozen=True)
class CoordinatorContextProfile:
    """Prompt/context budget chosen before the Coordinator adapter runs."""

    intent: str
    include_help: bool
    help_limit: int
    memory_layers: frozenset[str]
    history_limit: int
    history_msg_max_chars: int
    enabled_tools: frozenset[str]
    include_bot_roster: bool = False
    memory_char_budget: int = 5000


def build_coordinator_profile(
    user_text: str,
    *,
    has_attachments: bool = False,
    has_peer_bots: bool = False,
    is_clarify_reply: bool = False,
) -> CoordinatorContextProfile:
    """Return a single universal profile — all tools, all memory layers, for every request."""

    return CoordinatorContextProfile(
        intent="general",
        include_help=True,
        help_limit=3,
        memory_layers=frozenset({"anchor", "progress", "decisions", "files_index", "history", "todos"}),
        history_limit=30,
        history_msg_max_chars=600,
        enabled_tools=ALL_COORDINATOR_TOOLS,
        include_bot_roster=has_peer_bots,
        memory_char_budget=8000,
    )

