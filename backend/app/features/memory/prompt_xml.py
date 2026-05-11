"""XML rendering helpers for memory injected into prompts."""
from __future__ import annotations

from typing import Any
from xml.sax.saxutils import escape, quoteattr

MEMORY_LAYER_FIELDS = (
    ("anchor", "项目锚点"),
    ("progress", "项目进度"),
    ("decisions", "决策记录"),
    ("files_index", "资料索引"),
    ("recent", "近期动态"),
    ("todos", "待办事项"),
)


def xml_text(value: Any) -> str:
    """Escape arbitrary content for XML text nodes."""
    return escape(str(value or ""), {"\r": "&#13;"})


def xml_attr(value: Any) -> str:
    """Escape arbitrary content for XML attributes."""
    return quoteattr(str(value or ""))


def render_channel_memory_xml(memory_context: dict[str, str] | None) -> str:
    """Render loaded channel memory as a compact XML prompt block."""
    memory_context = memory_context or {}
    layers: list[tuple[str, str, str]] = []
    for key, label in MEMORY_LAYER_FIELDS:
        content = (memory_context.get(key) or "").strip()
        if content:
            layers.append((key, label, content))
    if not layers:
        return ""

    lines: list[str] = ['<channel_memory version="1">']
    for key, label, content in layers:
        lines.append(f"  <layer name={xml_attr(key)} label={xml_attr(label)}>")
        lines.append(f"    <content>{xml_text(content)}</content>")
        lines.append("  </layer>")
    lines.append("</channel_memory>")
    return "\n".join(lines)


def render_agent_memory_context_xml(
    *,
    channel_name: str,
    bot_role: str,
    memory_context: dict[str, str] | None,
) -> str:
    """Render the legacy system-prompt memory prefix as XML."""
    lines = [
        '<agentnexus_context version="1">',
        f"  <identity bot_role={xml_attr(bot_role)} channel_name={xml_attr(channel_name)} />",
    ]
    memory_xml = render_channel_memory_xml(memory_context)
    if memory_xml:
        lines.extend(f"  {line}" for line in memory_xml.splitlines())
    else:
        lines.append('  <channel_memory version="1" />')
    lines.append("</agentnexus_context>")
    return "\n".join(lines)
