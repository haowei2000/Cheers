"""Message 数据访问层."""
from __future__ import annotations

from sqlalchemy import select
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
    ) -> list[Message]:
        query = select(Message).where(Message.channel_id == channel_id)
        if before_id:
            sub = select(Message.created_at).where(Message.msg_id == before_id).scalar_subquery()
            query = query.where(Message.created_at < sub)
        query = query.order_by(Message.created_at.desc()).limit(limit)
        result = await self.session.execute(query)
        # 数据库查出来是逆序（最新的在前面），返回给前端通常希望是正序
        messages = list(result.scalars().all())
        messages.reverse()
        return messages

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
