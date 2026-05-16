"""Manager module."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.memory.channel_memory import ChannelMemory
from app.features.memory.prompt_xml import render_agent_memory_context_xml


async def load(channel_id: str, session: AsyncSession) -> dict[str, str]:
    """Load."""
    mem = await ChannelMemory.load(channel_id, session)
    return mem.to_context_dict()


async def load_layers(
    channel_id: str, session: AsyncSession, layers: frozenset[str] | set[str],
) -> dict[str, str]:
    """Load layers."""
    mem = await ChannelMemory.load_layers(channel_id, session, layers)
    return mem.to_context_dict()


async def load_channel_memory(channel_id: str, session: AsyncSession) -> ChannelMemory:
    """Load channel memory."""
    return await ChannelMemory.load(channel_id, session)


async def save_layer(
    channel_id: str,
    layer: str,
    content: str,
    session: AsyncSession | None = None,
) -> str:
    """Save layer."""
    return await replace_layer_entries(
        channel_id=channel_id,
        layer=layer,
        content=content,
        session=session,
    )


async def save_entry(
    channel_id: str,
    layer: str,
    content: str,
    title: str | None = None,
    created_by: str | None = None,
    creator_type: str | None = None,
    session: AsyncSession | None = None,
) -> str:
    """Save entry."""


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
    """Replace layer entries."""


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
    """Build system prompt prefix."""
    return render_agent_memory_context_xml(
        channel_name=channel_name,
        bot_role=bot_role,
        memory_context=memory,
    )
