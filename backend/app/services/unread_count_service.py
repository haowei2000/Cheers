"""Unread-count cache helpers."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ChannelMembership, ChannelUnreadCount, Message


async def increment_unread_counts(
    session: AsyncSession,
    *,
    channel_id: str,
    user_ids: list[str],
) -> None:
    unique_user_ids = list(dict.fromkeys(uid for uid in user_ids if uid))
    if not unique_user_ids:
        return

    now = datetime.now(timezone.utc)
    await session.execute(
        update(ChannelMembership)
        .where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id.in_(unique_user_ids),
            ChannelMembership.member_type == "user",
            ChannelMembership.hidden_at.is_not(None),
        )
        .values(hidden_at=None)
    )
    values = [
        {
            "channel_id": channel_id,
            "user_id": user_id,
            "unread_count": 1,
            "updated_at": now,
        }
        for user_id in unique_user_ids
    ]
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert

        stmt = insert(ChannelUnreadCount).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[ChannelUnreadCount.channel_id, ChannelUnreadCount.user_id],
            set_={
                "unread_count": ChannelUnreadCount.unread_count + 1,
                "updated_at": now,
            },
        )
        await session.execute(stmt)
        await session.flush()
        return
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert

        stmt = insert(ChannelUnreadCount).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[ChannelUnreadCount.channel_id, ChannelUnreadCount.user_id],
            set_={
                "unread_count": ChannelUnreadCount.unread_count + 1,
                "updated_at": now,
            },
        )
        await session.execute(stmt)
        await session.flush()
        return

    for user_id in unique_user_ids:
        row = await session.get(ChannelUnreadCount, {"channel_id": channel_id, "user_id": user_id})
        if row is None:
            session.add(ChannelUnreadCount(channel_id=channel_id, user_id=user_id, unread_count=1))
        else:
            row.unread_count += 1
            row.updated_at = now
    await session.flush()


async def set_unread_count(
    session: AsyncSession,
    *,
    channel_id: str,
    user_id: str,
    unread_count: int,
) -> None:
    now = datetime.now(timezone.utc)
    count = max(0, int(unread_count or 0))
    dialect = session.get_bind().dialect.name
    values = {
        "channel_id": channel_id,
        "user_id": user_id,
        "unread_count": count,
        "updated_at": now,
    }
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert

        stmt = insert(ChannelUnreadCount).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[ChannelUnreadCount.channel_id, ChannelUnreadCount.user_id],
            set_={"unread_count": count, "updated_at": now},
        )
        await session.execute(stmt)
        await session.flush()
        return
    if dialect == "sqlite":
        from sqlalchemy.dialects.sqlite import insert

        stmt = insert(ChannelUnreadCount).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[ChannelUnreadCount.channel_id, ChannelUnreadCount.user_id],
            set_={"unread_count": count, "updated_at": now},
        )
        await session.execute(stmt)
        await session.flush()
        return

    row = await session.get(ChannelUnreadCount, {"channel_id": channel_id, "user_id": user_id})
    if row is None:
        session.add(ChannelUnreadCount(**values))
    else:
        row.unread_count = count
        row.updated_at = now
    await session.flush()


async def compute_unread_counts(
    session: AsyncSession,
    *,
    user_id: str,
    channel_ids: list[str],
) -> dict[str, int]:
    result: dict[str, int] = {cid: 0 for cid in channel_ids}
    if not channel_ids:
        return result
    rows = (
        await session.execute(
            select(Message.channel_id, func.count(Message.msg_id))
            .join(
                ChannelMembership,
                and_(
                    ChannelMembership.channel_id == Message.channel_id,
                    ChannelMembership.member_id == user_id,
                    ChannelMembership.member_type == "user",
                ),
            )
            .where(
                Message.channel_id.in_(channel_ids),
                Message.sender_id != user_id,
                Message.is_deleted == False,  # noqa: E712
                or_(
                    ChannelMembership.last_read_at.is_(None),
                    Message.created_at > ChannelMembership.last_read_at,
                ),
            )
            .group_by(Message.channel_id)
        )
    ).all()
    for channel_id, count in rows:
        result[channel_id] = int(count or 0)
    return result


async def unread_counts_for(
    session: AsyncSession,
    *,
    user_id: str,
    channel_ids: list[str],
) -> dict[str, int]:
    if not channel_ids:
        return {}

    result: dict[str, int] = {cid: 0 for cid in channel_ids}
    membership_rows = (
        await session.execute(
            select(ChannelMembership.channel_id).where(
                ChannelMembership.channel_id.in_(channel_ids),
                ChannelMembership.member_id == user_id,
                ChannelMembership.member_type == "user",
            )
        )
    ).all()
    member_channel_ids = [row[0] for row in membership_rows]
    if not member_channel_ids:
        return result

    cached_rows = (
        await session.execute(
            select(ChannelUnreadCount.channel_id, ChannelUnreadCount.unread_count).where(
                ChannelUnreadCount.user_id == user_id,
                ChannelUnreadCount.channel_id.in_(member_channel_ids),
            )
        )
    ).all()
    cached_channel_ids = set()
    for channel_id, count in cached_rows:
        cached_channel_ids.add(channel_id)
        result[channel_id] = int(count or 0)

    missing = [cid for cid in member_channel_ids if cid not in cached_channel_ids]
    if missing:
        fallback = await compute_unread_counts(session, user_id=user_id, channel_ids=missing)
        for channel_id, count in fallback.items():
            result[channel_id] = count
            await set_unread_count(
                session,
                channel_id=channel_id,
                user_id=user_id,
                unread_count=count,
            )
    return result
