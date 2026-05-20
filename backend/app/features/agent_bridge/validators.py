"""Validators module."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, ChannelMembership, FileRecord, Message
from app.services.file_retention import active_file_filter
from app.services.file_scope_service import FileScopeService


async def check_bot_in_channel(
    session: AsyncSession, *, bot_id: str, channel_id: str,
) -> tuple[str, str] | None:
    row = (await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id == bot_id,
            ChannelMembership.member_type == "bot",
        )
    )).scalar_one_or_none()
    if row is None:
        return ("not_member", f"Bot {bot_id} 不在频道 {channel_id} 的成员中")
    return None


async def check_files_in_channel(
    session: AsyncSession, *, file_ids: list[str], channel_id: str,
) -> tuple[str, str] | None:
    if not file_ids:
        return None

    channel = await session.get(Channel, channel_id)
    if channel is None:
        return ("channel_not_found", f"频道不存在: {channel_id}")

    requested_file_ids = list(dict.fromkeys(file_ids))
    records = (await session.execute(
        select(FileRecord).where(
            FileRecord.file_id.in_(requested_file_ids),
            active_file_filter(),
        )
    )).scalars().all()
    found = {record.file_id for record in records}
    missing = [file_id for file_id in requested_file_ids if file_id not in found]
    if missing:
        return ("file_not_found", f"file_ids 不存在: {missing}")

    scope = FileScopeService(session)
    not_linked: list[str] = []
    for file_id in requested_file_ids:
        if not await scope.file_linked_to_channel(file_id=file_id, channel=channel):
            not_linked.append(file_id)
    if not_linked:
        return ("file_not_in_channel", f"file_ids 不属于频道 {channel_id}: {not_linked}")

    return None


async def check_in_reply_same_channel(
    session: AsyncSession, *, msg_id: str, channel_id: str,
) -> tuple[str, str] | None:
    parent = (await session.execute(
        select(Message.channel_id).where(Message.msg_id == msg_id)
    )).scalar_one_or_none()
    if parent is None:
        return ("reply_target_not_found", f"in_reply_to_msg_id 不存在: {msg_id}")
    if parent != channel_id:
        return ("reply_cross_channel", "in_reply_to_msg_id 指向的消息不在目标频道内")
    return None
