"""MemoryManager：频道记忆加载与 system prompt 构建（供 Orchestrator 注入）。

新架构：
- ANCHOR / DECISIONS / PROGRESS → 从 memory_entries 表结构化加载
- FILES_INDEX → 从 FileRecord 实时渲染
- RECENT → 从 HistoryPage 实时渲染
- TODOS → 从 TodoItem 实时渲染
统一通过 ChannelMemory 领域对象。
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.memory.channel_memory import ChannelMemory


async def load(channel_id: str, session: AsyncSession) -> dict[str, str]:
    """加载频道全部记忆，返回兼容旧格式的 dict。"""
    mem = await ChannelMemory.load(channel_id, session)
    return mem.to_context_dict()


async def load_channel_memory(channel_id: str, session: AsyncSession) -> ChannelMemory:
    """加载频道记忆，返回完整 ChannelMemory 对象。"""
    return await ChannelMemory.load(channel_id, session)


async def save_entry(
    channel_id: str,
    layer: str,
    content: str,
    title: str | None = None,
    created_by: str | None = None,
    creator_type: str | None = None,
    session: AsyncSession | None = None,
) -> str:
    """创建一条记忆条目，返回 entry_id。供 Bot tool 和内部逻辑调用。"""


    if session is None:
        from app.db.session import async_session_factory
        async with async_session_factory() as session:
            entry_id = await _do_save_entry(session, channel_id, layer, content, title, created_by, creator_type)
            await session.commit()
            return entry_id
    return await _do_save_entry(session, channel_id, layer, content, title, created_by, creator_type)


async def _do_save_entry(
    session: AsyncSession,
    channel_id: str,
    layer: str,
    content: str,
    title: str | None,
    created_by: str | None,
    creator_type: str | None,
) -> str:
    from sqlalchemy import func, select

    from app.db.models import MemoryEntry

    layer_upper = layer.upper()
    max_order = await session.scalar(
        select(func.max(MemoryEntry.sort_order))
        .where(MemoryEntry.channel_id == channel_id, MemoryEntry.layer == layer_upper)
    )
    entry = MemoryEntry(
        channel_id=channel_id,
        layer=layer_upper,
        title=title,
        content=content,
        sort_order=(max_order or 0) + 1,
        created_by=created_by,
        creator_type=creator_type,
    )
    session.add(entry)
    await session.flush()
    return entry.entry_id


async def replace_layer_entries(
    channel_id: str,
    layer: str,
    content: str,
    title: str | None = None,
    created_by: str | None = None,
    creator_type: str | None = None,
    session: AsyncSession | None = None,
) -> str:
    """替换某层的全部条目为单条新内容（兼容旧的覆盖写入模式）。返回 entry_id。"""


    if session is None:
        from app.db.session import async_session_factory
        async with async_session_factory() as session:
            entry_id = await _do_replace(session, channel_id, layer, content, title, created_by, creator_type)
            await session.commit()
            return entry_id
    return await _do_replace(session, channel_id, layer, content, title, created_by, creator_type)


async def _do_replace(
    session: AsyncSession,
    channel_id: str,
    layer: str,
    content: str,
    title: str | None,
    created_by: str | None,
    creator_type: str | None,
) -> str:
    from sqlalchemy import delete

    from app.db.models import MemoryEntry

    layer_upper = layer.upper()
    await session.execute(
        delete(MemoryEntry).where(
            MemoryEntry.channel_id == channel_id,
            MemoryEntry.layer == layer_upper,
        )
    )
    entry = MemoryEntry(
        channel_id=channel_id,
        layer=layer_upper,
        title=title,
        content=content,
        sort_order=1,
        created_by=created_by,
        creator_type=creator_type,
    )
    session.add(entry)
    await session.flush()
    return entry.entry_id


def build_system_prompt_prefix(channel_name: str, bot_role: str, memory: dict[str, str]) -> str:
    """拼接记忆为 System Prompt 前缀。"""
    todos_section = f"\n== 待办事项（未完成）==\n{memory['todos']}\n" if memory.get("todos") else ""
    progress_section = f"\n== 项目进度 ==\n{memory['progress']}\n" if memory.get("progress") else ""
    return f"""你是 {bot_role}，正在参与频道「{channel_name}」的协作工作。
== 项目锚点（最高优先级，务必遵守）==
{memory.get('anchor', '')}
== 重要决策记录 ==
{memory.get('decisions', '')}{progress_section}
== 已上传资料索引 ==
{memory.get('files_index', '')}
== 近期频道动态 ==
{memory.get('recent', '')}{todos_section}"""
