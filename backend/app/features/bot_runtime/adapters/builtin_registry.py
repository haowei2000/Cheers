"""Builtin registry module."""

from __future__ import annotations

from collections.abc import Callable

from app.features.bot_runtime.adapters.base import BotAdapter
from app.features.bot_runtime.adapters.coordinator import ChannelBotAdapter
from app.features.bot_runtime.builtin_ids import HELPER_BOT_ID

# Factories must be zero-argument; built-in bots do not read AIModel/PromptTemplate from the DB at runtime.
BUILTIN_BOT_ADAPTERS: dict[str, Callable[[], BotAdapter]] = {
    # @Helper combines help, collaboration, and memory management; the adapter class keeps its legacy name.
    HELPER_BOT_ID: ChannelBotAdapter,
}


def get_builtin_adapter(bot_id: str) -> BotAdapter | None:
    """Get builtin adapter."""
    factory = BUILTIN_BOT_ADAPTERS.get(bot_id)
    return factory() if factory else None
