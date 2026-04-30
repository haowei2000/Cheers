"""Helpers for secret-message placeholders stored in normal message text."""
from __future__ import annotations

import re

SECRET_PLACEHOLDER = "🔒 [加密消息]"
_SECRET_PLACEHOLDER_RE = re.compile(r"🔒 \[加密消息(?::[^\]]+)?\]")


def secret_placeholder_for(msg_id: str | None) -> str:
    """Return the DB-visible placeholder for a secret message."""
    if not msg_id:
        return SECRET_PLACEHOLDER
    return f"🔒 [加密消息:{msg_id}]"


def replace_secret_placeholder(text: str, plaintext: str) -> str:
    """Replace either old or msg_id-qualified secret placeholders."""
    return _SECRET_PLACEHOLDER_RE.sub(plaintext, text)
