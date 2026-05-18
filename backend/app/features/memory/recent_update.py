"""Deprecated compatibility aliases for history update hooks."""
from __future__ import annotations

from app.features.memory.history_update import (
    reset_history_debounce_state,
    schedule_history_update,
    update_history_async,
)

update_recent_async = update_history_async
schedule_recent_update = schedule_history_update
reset_recent_debounce_state = reset_history_debounce_state
