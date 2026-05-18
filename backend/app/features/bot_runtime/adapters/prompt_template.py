"""Shared prompt-template rendering for adapter implementations."""
from __future__ import annotations

import re
from typing import Any

from app.core.prompt_templates import DEFAULT_USER_TEMPLATE
from app.features.memory.prompt_xml import MEMORY_LAYER_FIELDS, render_channel_memory_xml

_VAR_PATTERN = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def template_uses_memory(template: str | None) -> bool:
    """Return whether a user template explicitly asks for built memory."""
    variables = {
        match.group(1)
        for match in _VAR_PATTERN.finditer(template or "")
    }
    memory_vars = {"memory", "recent"} | {key for key, _ in MEMORY_LAYER_FIELDS}
    return bool(variables & memory_vars)


def render_memory_context(memory_context: dict[str, str] | None) -> str:
    """Render the loaded memory context as the canonical {{memory}} value."""
    return render_channel_memory_xml(memory_context)


def render_user_template(
    template: str | None,
    *,
    message: str,
    context: dict[str, Any] | None = None,
) -> str:
    """Render ``{{var}}`` placeholders, keeping unknown vars intact."""
    variables: dict[str, Any] = {"message": message}
    if context:
        variables.update(context)

    def replace_var(match: re.Match[str]) -> str:
        var_name = match.group(1)
        return str(variables.get(var_name, match.group(0)))

    return _VAR_PATTERN.sub(replace_var, template or DEFAULT_USER_TEMPLATE).strip()


def build_template_context(
    *,
    bot_name: str,
    channel_id: str,
    channel_name: str,
    sender_name: str,
    timestamp: str,
    memory_context: dict[str, str] | None,
) -> dict[str, str]:
    memory_context = memory_context or {}
    context = {
        "sender_name": sender_name,
        "channel_name": channel_name,
        "channel_id": channel_id,
        "bot_name": bot_name,
        "timestamp": timestamp,
        "memory": render_memory_context(memory_context),
    }
    for key, _ in MEMORY_LAYER_FIELDS:
        context[key] = memory_context.get(key, "")
    # Deprecated template variable kept as a read-only alias while prompts migrate.
    context["recent"] = context.get("history") or memory_context.get("recent", "")
    return context
