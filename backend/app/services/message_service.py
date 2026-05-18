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

    async def list_messages(
        self,
        channel_id: str,
        limit: int = 50,
        before_id: str | None = None,
    ) -> tuple[list[Message], dict[str, MessageFileDTO]]:
        """List messages."""
        ch = await self.channel_repo.get_by_id(channel_id)
        if not ch:
            raise NotFoundError("channel not found")
        messages = await self.msg_repo.list_by_channel(channel_id, limit=limit, before_id=before_id)
        file_ids = sorted({fid for m in messages for fid in (m.file_ids or []) if fid})
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
        return messages, file_map

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
        file_ids = sorted({
            fid for m in messages for fid in (m.file_ids or []) if fid
        })
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
        return messages, file_map

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
            from app.services.file_scope_service import FileScopeService

            scope_service = FileScopeService(self.session)
            sender_user = None
            if sender_type == "user":
                from app.db.models import User

                sender_user = await self.session.get(User, sender_id)
            for fid in file_ids:
                rec = records.get(fid)
                if not rec:
                    raise BadRequestError(f"file {fid} not found")
                if sender_user is not None and not await scope_service.user_can_access(rec, sender_user):
                    raise BadRequestError(f"file {fid} is not accessible")

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
        if file_ids:
            from app.services.file_scope_service import FileScopeService

            await FileScopeService(self.session).link_files_to_channel(
                file_ids=file_ids,
                channel_id=channel_id,
                created_by=sender_id if sender_type == "user" else None,
            )
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
