"""File repo module."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import FileRecord
from app.services.file_retention import active_file_filter, file_expires_at


class FileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, file_id: str, *, include_expired: bool = False) -> FileRecord | None:
        conditions = [FileRecord.file_id == file_id]
        if not include_expired:
            conditions.append(active_file_filter())
        result = await self.session.execute(
            select(FileRecord).where(*conditions)
        )
        return result.scalar_one_or_none()

    async def get_many_by_ids(
        self, file_ids: list[str], *, include_expired: bool = False,
    ) -> dict[str, FileRecord]:
        if not file_ids:
            return {}
        conditions = [FileRecord.file_id.in_(file_ids)]
        if not include_expired:
            conditions.append(active_file_filter())
        result = await self.session.execute(
            select(FileRecord).where(*conditions)
        )
        return {r.file_id: r for r in result.scalars().all()}

    async def list_by_channel(self, channel_id: str) -> list[FileRecord]:
        result = await self.session.execute(
            select(FileRecord)
            .where(FileRecord.channel_id == channel_id, active_file_filter())
            .order_by(FileRecord.created_at.desc())
        )
        return list(result.scalars().all())

    async def create(
        self,
        channel_id: str,
        uploader_id: str,
        original_path: str,
        *,
        original_filename: str | None = None,
        content_type: str | None = None,
        size_bytes: int | None = None,
        object_key: str | None = None,
        storage_bucket: str | None = None,
        status: str = "pending",
    ) -> FileRecord:
        record = FileRecord(
            channel_id=channel_id,
            uploader_id=uploader_id,
            original_path=original_path,
            original_filename=original_filename,
            content_type=content_type,
            size_bytes=size_bytes,
            object_key=object_key,
            storage_bucket=storage_bucket,
            status=status,
            expires_at=file_expires_at(),
        )
        self.session.add(record)
        await self.session.flush()
        return record

    async def update(self, record: FileRecord, **kwargs) -> FileRecord:
        for key, value in kwargs.items():
            setattr(record, key, value)
        self.session.add(record)
        await self.session.flush()
        return record

    async def delete(self, record: FileRecord) -> None:
        await self.session.delete(record)
        await self.session.flush()
