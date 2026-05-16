"""Channel memory module."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import asc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FileRecord, MemoryEntry, TodoItem
from app.services.file_retention import active_file_filter

# Layers that support structured CRUD.
ENTRY_LAYERS = ("ANCHOR", "DECISIONS", "PROGRESS")


@dataclass
class MemoryItem:
    """Memory Item schema or model."""
    entry_id: str
    layer: str
    title: str | None
    content: str
    sort_order: int
    created_by: str | None = None
    creator_type: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    @classmethod
    def from_orm(cls, obj: MemoryEntry) -> MemoryItem:
        return cls(
            entry_id=obj.entry_id,
            layer=obj.layer,
            title=obj.title,
            content=obj.content,
            sort_order=obj.sort_order,
            created_by=obj.created_by,
            creator_type=obj.creator_type,
            created_at=obj.created_at,
            updated_at=obj.updated_at,
        )


@dataclass
class ChannelMemory:
    """Channel Memory schema or model."""
    channel_id: str
    # Structured layers: list of items.
    anchor: list[MemoryItem] = field(default_factory=list)
    decisions: list[MemoryItem] = field(default_factory=list)
    progress: list[MemoryItem] = field(default_factory=list)
    # Derived layers: rendered text.
    files_index: str = ""
    recent: str = ""
    todos: str = ""

    # Loading.

    ALL_LAYERS = frozenset({
        "anchor", "decisions", "progress", "files_index", "recent", "todos",
    })

    @classmethod
    async def load(cls, channel_id: str, session: AsyncSession) -> ChannelMemory:
        """Load."""
        return await cls.load_layers(channel_id, session, cls.ALL_LAYERS)

    @classmethod
    async def load_layers(
        cls, channel_id: str, session: AsyncSession, layers: frozenset[str] | set[str],
    ) -> ChannelMemory:
        """Load layers."""
        mem = cls(channel_id=channel_id)

        # 1) Structured layers from memory_entries, optionally filtered by layer.
        wanted_entry_layers: list[str] = []
        if "anchor" in layers:
            wanted_entry_layers.append("ANCHOR")
        if "decisions" in layers:
            wanted_entry_layers.append("DECISIONS")
        if "progress" in layers:
            wanted_entry_layers.append("PROGRESS")
        if wanted_entry_layers:
            result = await session.execute(
                select(MemoryEntry)
                .where(
                    MemoryEntry.channel_id == channel_id,
                    MemoryEntry.layer.in_(wanted_entry_layers),
                )
                .order_by(asc(MemoryEntry.sort_order), asc(MemoryEntry.created_at))
            )
            for entry in result.scalars().all():
                item = MemoryItem.from_orm(entry)
                layer_name = entry.layer.upper()
                if layer_name == "ANCHOR":
                    mem.anchor.append(item)
                elif layer_name == "DECISIONS":
                    mem.decisions.append(item)
                elif layer_name == "PROGRESS":
                    mem.progress.append(item)

        # 2) Derived layers, when requested.
        if "files_index" in layers:
            mem.files_index = await cls._render_files_index(channel_id, session)
        if "recent" in layers:
            mem.recent = await cls._render_recent(channel_id, session)
        if "todos" in layers:
            mem.todos = await cls._render_todos(channel_id, session)

        return mem

    # Export as dict for compatibility with the existing memory_context API.

    def to_context_dict(self) -> dict[str, str]:
        """To context dict."""
        return {
            "anchor": self.export_layer_text("ANCHOR"),
            "decisions": self.export_layer_text("DECISIONS"),
            "progress": self.export_layer_text("PROGRESS"),
            "files_index": self.files_index,
            "recent": self.recent,
            "todos": self.todos,
        }

    # Single-layer export.

    def _get_items(self, layer: str) -> list[MemoryItem]:
        layer = layer.upper()
        if layer == "ANCHOR":
            return self.anchor
        elif layer == "DECISIONS":
            return self.decisions
        elif layer == "PROGRESS":
            return self.progress
        return []

    def export_layer_md(self, layer: str) -> str:
        """Export layer md."""
        items = self._get_items(layer)
        if not items:
            return ""
        parts: list[str] = []
        for item in items:
            if item.title:
                parts.append(f"### {item.title}\n{item.content}")
            else:
                parts.append(item.content)
        return "\n\n".join(parts)

    def export_layer_text(self, layer: str) -> str:
        """Export layer text."""
        items = self._get_items(layer)
        if not items:
            return ""
        parts: list[str] = []
        for item in items:
            if item.title:
                parts.append(f"title: {item.title}\ncontent: {item.content}")
            else:
                parts.append(item.content)
        return "\n\n".join(parts)

    def export_layer_xml(self, layer: str) -> str:
        """Export layer xml."""
        items = self._get_items(layer)
        tag = layer.lower()
        if not items:
            return f"<{tag}/>"
        lines: list[str] = [f"<{tag}>"]
        for item in items:
            title_attr = f' title="{_xml_escape(item.title)}"' if item.title else ""
            lines.append(f"  <entry id=\"{item.entry_id}\"{title_attr}>{_xml_escape(item.content)}</entry>")
        lines.append(f"</{tag}>")
        return "\n".join(lines)

    # Full export.

    def export_md(self) -> str:
        """Export md."""
        sections: list[str] = []
        for layer_name, label in [
            ("ANCHOR", "Project Anchor"),
            ("PROGRESS", "Project Progress"),
            ("DECISIONS", "Decision Records"),
        ]:
            content = self.export_layer_md(layer_name)
            if content:
                sections.append(f"## {label}\n\n{content}")

        if self.files_index:
            sections.append(f"## File Index\n\n{self.files_index}")
        if self.recent:
            sections.append(f"## Recent Updates\n\n{self.recent}")
        if self.todos:
            sections.append(f"## Todos\n\n{self.todos}")

        return "\n\n---\n\n".join(sections) if sections else ""

    def export_xml(self) -> str:
        """Export xml."""
        lines: list[str] = ["<project_memory>"]
        lines.append(f"  {self.export_layer_xml('ANCHOR')}")
        lines.append(f"  {self.export_layer_xml('PROGRESS')}")
        lines.append(f"  {self.export_layer_xml('DECISIONS')}")
        if self.files_index:
            lines.append(f"  <files_index>{_xml_escape(self.files_index)}</files_index>")
        else:
            lines.append("  <files_index/>")
        if self.recent:
            lines.append(f"  <recent>{_xml_escape(self.recent)}</recent>")
        else:
            lines.append("  <recent/>")
        if self.todos:
            lines.append(f"  <todos>{_xml_escape(self.todos)}</todos>")
        else:
            lines.append("  <todos/>")
        lines.append("</project_memory>")
        return "\n".join(lines)

    # Derived-layer rendering.

    @staticmethod
    async def _render_files_index(channel_id: str, session: AsyncSession) -> str:
        """Render files index."""
        result = await session.execute(
            select(FileRecord)
            .where(
                FileRecord.channel_id == channel_id,
                FileRecord.content_type.notlike("image/%"),
                active_file_filter(),
            )
            .order_by(asc(FileRecord.created_at))
        )
        records = result.scalars().all()
        if not records:
            return ""
        parts: list[str] = []
        for r in records:
            filename = r.original_filename or r.file_id
            lines = [f"filename: {filename}"]
            lines.append(f"file_id: {r.file_id}")
            if r.content_type:
                lines.append(f"content_type: {r.content_type}")
            if r.summary_3lines:
                lines.append(f"summary: {r.summary_3lines}")
            ts = r.created_at.strftime("%Y-%m-%d %H:%M UTC") if r.created_at else ""
            if ts:
                lines.append(f"registered_at: {ts}")
            parts.append("\n".join(lines))
        return "\n\n".join(parts)

    @staticmethod
    async def _render_recent(channel_id: str, session: AsyncSession) -> str:
        """Render recent."""
        from app.features.memory.history_pager import render_recent_context

        return await render_recent_context(channel_id, session)

    @staticmethod
    async def _render_todos(channel_id: str, session: AsyncSession) -> str:
        """Render todos."""
        result = await session.execute(
            select(TodoItem)
            .where(TodoItem.channel_id == channel_id)
            .order_by(TodoItem.created_at)
        )
        all_todos = result.scalars().all()
        if not all_todos:
            return ""
        pending = [t for t in all_todos if t.status == "pending"]
        completed = [t for t in all_todos if t.status == "completed"]
        parts: list[str] = []
        if pending:
            parts.append("pending:")
            for t in pending:
                short_id = t.todo_id[:8]
                parts.append(f"todo_id: {short_id}\ncontent: {t.content}")
        if completed:
            parts.append("completed_ids:")
            parts.append(" ".join(t.todo_id[:8] for t in completed))
        return "\n".join(parts)


def _xml_escape(s: str) -> str:
    """Minimal XML escaping for attribute values and text content."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
