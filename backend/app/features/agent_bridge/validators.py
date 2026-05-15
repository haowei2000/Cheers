"""plugin 提交的 reply/send 帧的跨领域校验工具。

返回 None 表示通过；返回 (code, detail) 表示拒绝。这样调用方可以自由决定
要不要抛 HTTPException、写 send_ack(ok=False) 还是别的包装。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ChannelMembership, FileRecord, Message
from app.services.file_retention import active_file_filter


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
    rows = (await session.execute(
        select(FileRecord.file_id, FileRecord.channel_id).where(
            FileRecord.file_id.in_(file_ids),
            active_file_filter(),
        )
    )).all()
    found = {fid: cid for fid, cid in rows}
    missing = [f for f in file_ids if f not in found]
    if missing:
        return ("file_not_found", f"file_ids 不存在: {missing}")
    cross = [f for f in file_ids if found[f] != channel_id]
    if cross:
        return ("file_cross_channel", f"file_ids 不属于目标频道 {channel_id}: {cross}")
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
