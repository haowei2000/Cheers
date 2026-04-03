"""文件业务逻辑层（轻量包装 FilePipelineService）."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.db.models import FileRecord, User
from app.repositories.file_repo import FileRepository
from app.repositories.channel_repo import ChannelRepository


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
        """生成预签名上传 URL，返回 {file_id, upload_url, headers, expires_in}."""
        from app.file_processor.service import FilePipelineService
        ch = await self.channel_repo.get_by_id(channel_id)
        if not ch:
            raise NotFoundError("channel not found")
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
        """确认上传完成，更新状态为 uploaded。"""
        from datetime import datetime
        rec = await self.get_or_404(file_id)
        if rec.uploader_id != uploader.user_id:
            raise BadRequestError("无权操作该文件")
        rec.status = "uploaded"
        rec.uploaded_at = datetime.utcnow()
        await self.session.flush()
        return rec

    async def get_download_url(self, file_id: str) -> str:
        """获取文件预签名下载 URL."""
        from app.storage.bootstrap import get_storage_service, is_storage_enabled
        rec = await self.get_or_404(file_id)
        if not is_storage_enabled():
            raise BadRequestError("storage not enabled")
        storage = get_storage_service()
        scope = "generated" if (rec.object_key or "").startswith("generated/") else "uploads"
        return storage.create_presigned_get_url(rec.file_id, scope=scope)
