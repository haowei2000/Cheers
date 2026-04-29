"""ChannelMemory：统一的频道记忆领域对象，聚合所有记忆层并提供 export 能力。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import asc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FileRecord, HistoryPage, MemoryEntry, TodoItem

# 支持结构化 CRUD 的层
ENTRY_LAYERS = ("ANCHOR", "DECISIONS", "PROGRESS")


@dataclass
class MemoryItem:
    """单条记忆条目的轻量表示。"""
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
    """频道完整记忆快照，用于注入 prompt 或导出。"""
    channel_id: str
    # 结构化层：list of items
    anchor: list[MemoryItem] = field(default_factory=list)
    decisions: list[MemoryItem] = field(default_factory=list)
    progress: list[MemoryItem] = field(default_factory=list)
    # 派生层：渲染后的文本
    files_index: str = ""
    recent: str = ""
    todos: str = ""

    # ── 加载 ──────────────────────────────────────────────────────────────────

    ALL_LAYERS = frozenset({
        "anchor", "decisions", "progress", "files_index", "recent", "todos",
    })

    @classmethod
    async def load(cls, channel_id: str, session: AsyncSession) -> ChannelMemory:
        """从 DB 加载频道全部记忆层。"""
        return await cls.load_layers(channel_id, session, cls.ALL_LAYERS)

    @classmethod
    async def load_layers(
        cls, channel_id: str, session: AsyncSession, layers: frozenset[str] | set[str],
    ) -> ChannelMemory:
        """加载指定的记忆层。``layers`` 是 ``ALL_LAYERS`` 的子集。

        未在 ``layers`` 中的层在结果对象上保持空值（[] 或 ""），
        ``to_context_dict()`` 会把它们渲染为空字符串——对调用方来说
        等价于 "未配置"。
        """
        mem = cls(channel_id=channel_id)

        # 1) 结构化层 — memory_entries 表（按需筛选 layer 列）
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

        # 2) 派生层（按需）
        if "files_index" in layers:
            mem.files_index = await cls._render_files_index(channel_id, session)
        if "recent" in layers:
            mem.recent = await cls._render_recent(channel_id, session)
        if "todos" in layers:
            mem.todos = await cls._render_todos(channel_id, session)

        return mem

    # ── 导出为 dict（兼容现有 memory_context 接口）────────────────────────────

    def to_context_dict(self) -> dict[str, str]:
        """导出为 flat dict，兼容现有 payload.memory_context 格式。"""
        return {
            "anchor": self.export_layer_md("ANCHOR"),
            "decisions": self.export_layer_md("DECISIONS"),
            "progress": self.export_layer_md("PROGRESS"),
            "files_index": self.files_index,
            "recent": self.recent,
            "todos": self.todos,
        }

    # ── 单层导出 ──────────────────────────────────────────────────────────────

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
        """将某个结构化层的所有条目导出为 Markdown。"""
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

    def export_layer_xml(self, layer: str) -> str:
        """将某个结构化层的所有条目导出为 XML。"""
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

    # ── 全量导出 ──────────────────────────────────────────────────────────────

    def export_md(self) -> str:
        """导出频道全部记忆为 Markdown 文档。"""
        sections: list[str] = []
        for layer_name, label in [
            ("ANCHOR", "项目锚点"),
            ("PROGRESS", "项目进度"),
            ("DECISIONS", "决策记录"),
        ]:
            content = self.export_layer_md(layer_name)
            if content:
                sections.append(f"## {label}\n\n{content}")

        if self.files_index:
            sections.append(f"## 资料索引\n\n{self.files_index}")
        if self.recent:
            sections.append(f"## 近期动态\n\n{self.recent}")
        if self.todos:
            sections.append(f"## 待办事项\n\n{self.todos}")

        return "\n\n---\n\n".join(sections) if sections else ""

    def export_xml(self) -> str:
        """导出频道全部记忆为 XML 文档。"""
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

    # ── 派生层渲染 ────────────────────────────────────────────────────────────

    @staticmethod
    async def _render_files_index(channel_id: str, session: AsyncSession) -> str:
        """从 FileRecord 实时渲染 FILES_INDEX 文本。"""
        result = await session.execute(
            select(FileRecord)
            .where(
                FileRecord.channel_id == channel_id,
                FileRecord.content_type.notlike("image/%"),
            )
            .order_by(asc(FileRecord.created_at))
        )
        records = result.scalars().all()
        if not records:
            return ""
        parts: list[str] = []
        for r in records:
            filename = r.original_filename or r.file_id
            lines = [f"### {filename}"]
            lines.append(f"- file_id: `{r.file_id}`")
            if r.content_type:
                lines.append(f"- 类型: {r.content_type}")
            if r.summary_3lines:
                lines.append(f"- 摘要: {r.summary_3lines}")
            ts = r.created_at.strftime("%Y-%m-%d %H:%M UTC") if r.created_at else ""
            if ts:
                lines.append(f"- 登记时间: {ts}")
            parts.append("\n".join(lines))
        return "\n\n---\n\n".join(parts)

    @staticmethod
    async def _render_recent(channel_id: str, session: AsyncSession) -> str:
        """从 HistoryPage 实时渲染 RECENT 文本。"""
        result = await session.execute(
            select(HistoryPage)
            .where(HistoryPage.channel_id == channel_id)
            .order_by(asc(HistoryPage.page_number))
        )
        pages = result.scalars().all()
        if not pages:
            return ""
        lines: list[str] = []
        for p in pages:
            start_str = p.started_at.strftime("%Y-%m-%dT%H:%M:%SZ") if p.started_at else ""
            end_str = p.ended_at.strftime("%Y-%m-%dT%H:%M:%SZ") if p.ended_at else ""
            lines.append(f'<page id="{p.page_id}" from="{start_str}" to="{end_str}">{p.summary}</page>')
        return "\n".join(lines)

    @staticmethod
    async def _render_todos(channel_id: str, session: AsyncSession) -> str:
        """从 TodoItem 实时渲染待办事项文本。"""
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
            parts.append("## 未完成")
            for t in pending:
                short_id = t.todo_id[:8]
                parts.append(f"- [ ] #{short_id}: {t.content}")
        if completed:
            parts.append("## 已完成（仅索引）")
            parts.append(" ".join(f"#{t.todo_id[:8]}" for t in completed))
        return "\n".join(parts)


def _xml_escape(s: str) -> str:
    """Minimal XML escaping for attribute values and text content."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
