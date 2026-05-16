"""File service module."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.db.models import FileRecord, User
from app.repositories.channel_repo import ChannelRepository
from app.repositories.file_repo import FileRepository
from app.services.channel_service import ChannelService
from app.services.file_retention import file_expires_at


class FileService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.file_repo = FileRepository(session)
        self.channel_repo = ChannelRepository(session)

    async def get_or_404(self, file_id: str) -> FileRecord:
        rec = await self.file_repo.get_by_id(file_id)
        if not rec:
            raise NotFoundError("file not found")
        return rec

    async def list_by_channel(self, channel_id: str) -> list[FileRecord]:
        ch = await self.channel_repo.get_by_id(channel_id)
        if not ch:
            raise NotFoundError("channel not found")
        return await self.file_repo.list_by_channel(channel_id)

    async def request_presign(
        self,
        channel_id: str,
        filename: str,
        content_type: str,
        size_bytes: int,
        uploader: User,
    ) -> dict:
        """Request presign."""
        from app.services.file_processor.service import FilePipelineService
        await ChannelService(self.session).require_can_send_message(channel_id, uploader)
        pipeline = FilePipelineService()
        record, reservation, metadata = pipeline.create_presigned_upload(
            channel_id=channel_id,
            uploader_id=uploader.user_id,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
        )
        self.session.add(record)
        await self.session.flush()
        await pipeline.write_upload_metadata(reservation.file_id, metadata)
        return {
            "file_id": reservation.file_id,
            "upload_url": reservation.upload_url,
            "headers": reservation.headers,
            "expires_in": reservation.expires_in,
            "object_key": reservation.object_key,
        }

    async def confirm_upload(self, file_id: str, uploader: User) -> FileRecord:
        """Confirm upload."""
        from datetime import datetime

        from app.services.storage.base import StorageObjectNotFoundError
        from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

        rec = await self.get_or_404(file_id)
        if rec.uploader_id != uploader.user_id:
            raise BadRequestError("无权操作该文件")

        if is_storage_enabled() and rec.object_key:
            storage = get_storage_service()
            scope = "generated" if rec.object_key.startswith("generated/") else "uploads"
            try:
                await storage.head_object(rec.file_id, scope=scope)
            except StorageObjectNotFoundError as exc:
                rec.status = "failed"
                rec.last_error = f"confirm: object not found ({exc})"
                await self.session.flush()
                raise BadRequestError("上传未完成：对象存储中找不到该文件") from exc

        rec.status = "uploaded"
        rec.uploaded_at = datetime.utcnow()
        rec.expires_at = rec.expires_at or file_expires_at(rec.uploaded_at)
        await self.session.flush()
        return rec

    async def get_download_url(self, file_id: str, user: User) -> str:
        """Get download url."""
        rec = await self.get_or_404(file_id)
        await ChannelService(self.session).require_channel_member(rec.channel_id, user)
        return f"/api/v1/files/{rec.file_id}/download"
