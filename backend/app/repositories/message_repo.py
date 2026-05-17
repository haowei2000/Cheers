"""Message repo module."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, false, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Message


class MessageRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, msg_id: str) -> Message | None:
        result = await self.session.execute(select(Message).where(Message.msg_id == msg_id))
        return result.scalar_one_or_none()

    async def list_by_channel(
        self,
        channel_id: str,
        limit: int = 50,
        before_id: str | None = None,
        exclude_empty: bool = False,
    ) -> list[Message]:
        query = select(Message).where(Message.channel_id == channel_id)
        if exclude_empty:
            query = query.where(Message.content != "")
        if before_id:
            cursor = (
                await self.session.execute(
                    select(Message.created_at, Message.msg_id).where(
                        Message.channel_id == channel_id,
                        Message.msg_id == before_id,
                    )
                )
            ).one_or_none()
            if cursor is None:
                query = query.where(false())
            else:
                before_created_at, before_msg_id = cursor
                return await self.list_before_cursor(
                    channel_id,
                    before_created_at=before_created_at,
                    before_msg_id=before_msg_id,
                    limit=limit,
                    exclude_empty=exclude_empty,
                )
        query = query.order_by(Message.created_at.desc(), Message.msg_id.desc()).limit(limit)
        result = await self.session.execute(query)
        # Database rows are fetched newest-first; frontend callers usually expect chronological order.
        messages = list(result.scalars().all())
        messages.reverse()
        return messages

    async def list_before_cursor(
        self,
        channel_id: str,
        *,
        before_created_at: datetime,
        before_msg_id: str,
        limit: int = 50,
        exclude_empty: bool = False,
    ) -> list[Message]:
        query = select(Message).where(Message.channel_id == channel_id)
        if exclude_empty:
            query = query.where(Message.content != "")
        query = query.where(
            or_(
                Message.created_at < before_created_at,
                and_(
                    Message.created_at == before_created_at,
                    Message.msg_id < before_msg_id,
                ),
            )
        )
        query = query.order_by(Message.created_at.desc(), Message.msg_id.desc()).limit(limit)
        result = await self.session.execute(query)
        messages = list(result.scalars().all())
        messages.reverse()
        return messages

    async def list_after_id(
        self,
        channel_id: str,
        after_id: str,
        limit: int = 50,
        exclude_empty: bool = False,
    ) -> list[Message]:
        query = select(Message).where(Message.channel_id == channel_id)
        if exclude_empty:
            query = query.where(Message.content != "")
        cursor = (
            await self.session.execute(
                select(Message.created_at, Message.msg_id).where(
                    Message.channel_id == channel_id,
                    Message.msg_id == after_id,
                )
            )
        ).one_or_none()
        if cursor is None:
            query = query.where(false())
        else:
            after_created_at, after_msg_id = cursor
            return await self.list_after_cursor(
                channel_id,
                after_created_at=after_created_at,
                after_msg_id=after_msg_id,
                limit=limit,
                exclude_empty=exclude_empty,
            )
        query = query.order_by(Message.created_at.asc(), Message.msg_id.asc()).limit(limit)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def list_after_cursor(
        self,
        channel_id: str,
        *,
        after_created_at: datetime,
        after_msg_id: str,
        limit: int = 50,
        exclude_empty: bool = False,
    ) -> list[Message]:
        query = select(Message).where(Message.channel_id == channel_id)
        if exclude_empty:
            query = query.where(Message.content != "")
        query = query.where(
            or_(
                Message.created_at > after_created_at,
                and_(
                    Message.created_at == after_created_at,
                    Message.msg_id > after_msg_id,
                ),
            )
        )
        query = query.order_by(Message.created_at.asc(), Message.msg_id.asc()).limit(limit)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def list_descendants_by_root(
        self,
        channel_id: str,
        root_msg_id: str,
    ) -> list[Message]:
        """List descendants by root."""
        seen = {root_msg_id}
        frontier = [root_msg_id]
        descendants: list[Message] = []

        while frontier:
            result = await self.session.execute(
                select(Message)
                .where(
                    Message.channel_id == channel_id,
                    Message.in_reply_to_msg_id.in_(frontier),
                )
                .order_by(Message.created_at.asc(), Message.msg_id.asc())
            )
            next_frontier: list[str] = []
            for msg in result.scalars().all():
                if msg.msg_id in seen:
                    continue
                seen.add(msg.msg_id)
                descendants.append(msg)
                next_frontier.append(msg.msg_id)
            frontier = next_frontier

        descendants.sort(
            key=lambda msg: (
                msg.created_at.isoformat() if msg.created_at else "",
                msg.msg_id,
            )
        )
        return descendants

    async def create(
        self,
        channel_id: str,
        sender_id: str,
        sender_type: str,
        content: str,
        *,
        file_ids: list[str] | None = None,
        mention_bot_ids: list[str] | None = None,
        mention_user_ids: list[str] | None = None,
        in_reply_to_msg_id: str | None = None,
        task_id: str | None = None,
        is_secret: bool = False,
        secret_encrypted: str | None = None,
        secret_token: str | None = None,
    ) -> Message:
        msg = Message(
            channel_id=channel_id,
            sender_id=sender_id,
            sender_type=sender_type,
            content=content,
            file_ids=file_ids or [],
            mention_bot_ids=mention_bot_ids or [],
            mention_user_ids=mention_user_ids or [],
            in_reply_to_msg_id=in_reply_to_msg_id,
            task_id=task_id,
            is_secret=is_secret,
            secret_encrypted=secret_encrypted,
            secret_token=secret_token,
        )
        self.session.add(msg)
        await self.session.flush()
        return msg

    async def update(self, msg: Message, **kwargs) -> Message:
        for key, value in kwargs.items():
            setattr(msg, key, value)
        self.session.add(msg)
        await self.session.flush()
        return msg
