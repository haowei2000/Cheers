"""Message DTO assembly for all transports."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from app.contracts.messages import MessageDTO, MessageFileDTO, MessageUpdateDTO
from app.db.models import FileRecord, Message

FileLike = FileRecord | MessageFileDTO | Mapping[str, Any]


def _datetime_wire(value: datetime | None) -> str | None:
    if not value:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _created_at_wire(message: Message) -> str | None:
    return _datetime_wire(message.created_at)


def message_file_dto(record: FileLike) -> MessageFileDTO:
    if isinstance(record, MessageFileDTO):
        dto = record
    elif isinstance(record, Mapping):
        dto = MessageFileDTO.model_validate(dict(record))
    else:
        dto = MessageFileDTO.model_validate(record)
    if not dto.preview_url:
        dto.preview_url = f"/api/v1/files/{dto.file_id}/preview"
    if not dto.download_url:
        dto.download_url = f"/api/v1/files/{dto.file_id}/download"
    return dto


class MessageAssembler:
    """Single conversion point from ORM rows to wire DTOs."""

    @staticmethod
    def assemble(message: Message, file_map: Mapping[str, FileLike] | None = None) -> MessageDTO:
        file_map = file_map or {}
        file_ids = [fid for fid in (message.file_ids or []) if isinstance(fid, str) and fid]
        files = [
            message_file_dto(file_map[fid])
            for fid in file_ids
            if fid in file_map
        ]
        return MessageDTO(
            msg_id=message.msg_id,
            channel_id=message.channel_id,
            sender_id=message.sender_id,
            sender_type=message.sender_type,
            content=message.content,
            msg_type=message.msg_type or "normal",
            content_data=message.content_data if isinstance(message.content_data, dict) else None,
            file_ids=file_ids,
            files=files,
            mention_bot_ids=message.mention_bot_ids or [],
            mention_user_ids=message.mention_user_ids or [],
            task_id=message.task_id,
            in_reply_to_msg_id=message.in_reply_to_msg_id,
            created_at=_created_at_wire(message),
            is_secret=bool(message.is_secret),
            is_partial=bool(message.is_partial),
            is_deleted=bool(getattr(message, "is_deleted", False)),
            deleted_at=_datetime_wire(getattr(message, "deleted_at", None)),
            deleted_by=getattr(message, "deleted_by", None),
        )

    @staticmethod
    def assemble_many(
        messages: Sequence[Message],
        file_map: Mapping[str, FileLike] | None = None,
    ) -> list[MessageDTO]:
        return [MessageAssembler.assemble(message, file_map) for message in messages]

    @staticmethod
    def update(
        message: Message,
        *,
        file_map: Mapping[str, FileLike] | None = None,
        is_partial: bool | None = None,
        error: str | None = None,
        content_data: dict[str, Any] | None = None,
        clear_content_data: bool = False,
    ) -> MessageUpdateDTO:
        file_ids = [fid for fid in (message.file_ids or []) if isinstance(fid, str) and fid]
        file_map = file_map or {}
        files = [
            message_file_dto(file_map[fid])
            for fid in file_ids
            if fid in file_map
        ]
        is_deleted = bool(getattr(message, "is_deleted", False))
        return MessageUpdateDTO(
            msg_id=message.msg_id,
            content=message.content,
            file_ids=file_ids,
            files=files,
            is_partial=is_partial,
            is_deleted=True if is_deleted else None,
            deleted_at=_datetime_wire(getattr(message, "deleted_at", None)) if is_deleted else None,
            deleted_by=getattr(message, "deleted_by", None) if is_deleted else None,
            error=error,
            content_data=content_data,
            clear_content_data=clear_content_data,
        )
