"""Shared prompt-template rendering for adapter implementations."""
from __future__ import annotations

import re
from typing import Any

from app.core.prompt_templates import DEFAULT_USER_TEMPLATE

_VAR_PATTERN = re.compile(r"\{\{\s*(\w+)\s*\}\}")

_MEMORY_BLOCK_FIELDS = (
    ("anchor", "项目锚点"),
    ("progress", "项目进度"),
    ("decisions", "决策记录"),
    ("files_index", "资料索引"),
    ("recent", "近期动态"),
    ("todos", "待办事项"),
)


def template_uses_memory(template: str | None) -> bool:
    """Return whether a user template explicitly asks for built memory."""
    return "memory" in {
        match.group(1)
        for match in _VAR_PATTERN.finditer(template or "")
    }


def render_memory_context(memory_context: dict[str, str] | None) -> str:
    """Render the loaded memory context as the canonical {{memory}} value."""
    memory_context = memory_context or {}
    sections: list[str] = []
    for key, label in _MEMORY_BLOCK_FIELDS:
        content = (memory_context.get(key) or "").strip()
        if not content:
            continue
        sections.append(
            "\n".join([
                f"## {label}",
                content,
            ])
        )
    if not sections:
        return ""
    return "\n\n".join([
        "=== 频道记忆上下文 ===",
        *sections,
    ])


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
    return {
        "sender_name": sender_name,
        "channel_name": channel_name,
        "channel_id": channel_id,
        "bot_name": bot_name,
        "timestamp": timestamp,
        "memory": render_memory_context(memory_context),
    }
