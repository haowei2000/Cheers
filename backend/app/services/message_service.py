"""Message service module."""
from __future__ import annotations

import secrets as _secrets

from sqlalchemy.ext.asyncio import AsyncSession

from app.contracts.messages import MessageFileDTO
from app.core.exceptions import BadRequestError, NotFoundError
from app.db.models import Message
from app.repositories.channel_repo import ChannelRepository
from app.repositories.file_repo import FileRepository
from app.repositories.message_repo import MessageRepository
from app.services.secret_messages import SECRET_PLACEHOLDER, secret_placeholder_for
from app.utils.crypto import encrypt_value


class MessageService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.msg_repo = MessageRepository(session)
        self.channel_repo = ChannelRepository(session)
        self.file_repo = FileRepository(session)

    async def _file_map_for_messages(self, messages: list[Message]) -> dict[str, MessageFileDTO]:
        file_ids = sorted({fid for m in messages for fid in (m.file_ids or []) if fid})
        records = await self.file_repo.get_many_by_ids(file_ids)
        return {
            fid: MessageFileDTO(
                file_id=rec.file_id,
                original_filename=rec.original_filename,
                content_type=rec.content_type,
                size_bytes=rec.size_bytes,
                status=rec.status,
                expires_at=rec.expires_at,
            )
            for fid, rec in records.items()
        }

    async def list_messages(
        self,
        channel_id: str,
        limit: int = 50,
        before_id: str | None = None,
    ) -> tuple[list[Message], dict[str, MessageFileDTO]]:
        """List messages. API routes perform channel membership validation before calling this."""
        messages = await self.msg_repo.list_by_channel(channel_id, limit=limit, before_id=before_id)
        return messages, await self._file_map_for_messages(messages)

    async def list_messages_after(
        self,
        channel_id: str,
        after_id: str,
        limit: int = 50,
    ) -> tuple[list[Message], dict[str, MessageFileDTO]]:
        """List messages newer than a cursor message."""
        messages = await self.msg_repo.list_after_id(channel_id, after_id=after_id, limit=limit)
        return messages, await self._file_map_for_messages(messages)

    async def list_messages_around(
        self,
        channel_id: str,
        around_id: str,
        limit: int = 50,
    ) -> tuple[list[Message], dict[str, MessageFileDTO], bool, bool, bool]:
        """List a bounded chronological window centered around a cursor message.

        Returns messages, file map, has_more_before, has_more_after, anchor_found.
        """
        anchor = await self.msg_repo.get_by_id(around_id)
        if not anchor or anchor.channel_id != channel_id:
            fallback = await self.msg_repo.list_by_channel(channel_id, limit=limit + 1)
            has_more = len(fallback) > limit
            messages = fallback[-limit:] if has_more else fallback
            return messages, await self._file_map_for_messages(messages), has_more, False, False

        bounded_limit = max(1, limit)
        side_fetch_limit = bounded_limit + 1
        before = await self.msg_repo.list_before_cursor(
            channel_id,
            before_created_at=anchor.created_at,
            before_msg_id=anchor.msg_id,
            limit=side_fetch_limit,
        )
        after = await self.msg_repo.list_after_cursor(
            channel_id,
            after_created_at=anchor.created_at,
            after_msg_id=anchor.msg_id,
            limit=side_fetch_limit,
        )

        desired_before = (bounded_limit - 1) // 2
        desired_after = bounded_limit - 1 - desired_before
        before_take = min(len(before), desired_before)
        after_take = min(len(after), desired_after)

        remaining = bounded_limit - 1 - before_take - after_take
        if remaining > 0:
            extra_before = min(len(before) - before_take, remaining)
            before_take += extra_before
            remaining -= extra_before
        if remaining > 0:
            extra_after = min(len(after) - after_take, remaining)
            after_take += extra_after

        visible_before = before[-before_take:] if before_take else []
        visible_after = after[:after_take] if after_take else []
        messages = [*visible_before, anchor, *visible_after]
        file_map = await self._file_map_for_messages(messages)
        return messages, file_map, len(before) > before_take, len(after) > after_take, True

    async def list_topic_messages(
        self,
        channel_id: str,
        root_msg_id: str,
    ) -> tuple[list[Message], dict[str, MessageFileDTO]]:
        """List topic messages."""
        ch = await self.channel_repo.get_by_id(channel_id)
        if not ch:
            raise NotFoundError("channel not found")

        root = await self.msg_repo.get_by_id(root_msg_id)
        if not root or root.channel_id != channel_id:
            raise NotFoundError("topic root message not found")

        descendants = await self.msg_repo.list_descendants_by_root(
            channel_id,
            root_msg_id,
        )
        messages = [root, *descendants]
        return messages, await self._file_map_for_messages(messages)

    async def send_message(
        self,
        channel_id: str,
        content: str,
        sender_id: str,
        sender_type: str,
        *,
        file_ids: list[str] | None = None,
        mention_bot_ids: list[str] | None = None,
        in_reply_to_msg_id: str | None = None,
        is_secret: bool = False,
    ) -> tuple[Message, dict[str, MessageFileDTO]]:
        """Send message."""
        ch = await self.channel_repo.get_by_id(channel_id)
        if not ch:
            raise NotFoundError("channel not found")

        file_ids = file_ids or []
        mention_bot_ids = mention_bot_ids or []

        # Validate that each file belongs to this channel and has a usable status.
        if file_ids:
            records = await self.file_repo.get_many_by_ids(file_ids)
            for fid in file_ids:
                rec = records.get(fid)
                if not rec:
                    raise BadRequestError(f"file {fid} not found")
                if rec.channel_id != channel_id:
                    raise BadRequestError(f"file {fid} does not belong to this channel")

        # Secret-message handling.
        if is_secret:
            encrypted = encrypt_value(content)
            stored_content = SECRET_PLACEHOLDER
            token = _secrets.token_urlsafe(32)
        else:
            encrypted = None
            stored_content = content
            token = None

        msg = await self.msg_repo.create(
            channel_id=channel_id,
            sender_id=sender_id,
            sender_type=sender_type,
            content=stored_content,
            file_ids=file_ids,
            mention_bot_ids=mention_bot_ids,
            in_reply_to_msg_id=in_reply_to_msg_id,
            is_secret=is_secret,
            secret_encrypted=encrypted,
            secret_token=token,
        )
        if is_secret:
            msg.content = secret_placeholder_for(msg.msg_id)
            await self.session.flush()

        records = await self.file_repo.get_many_by_ids(file_ids)
        file_map = {
            fid: MessageFileDTO(
                file_id=rec.file_id,
                original_filename=rec.original_filename,
                content_type=rec.content_type,
                size_bytes=rec.size_bytes,
                status=rec.status,
                expires_at=rec.expires_at,
            )
            for fid, rec in records.items()
        }
        return msg, file_map
