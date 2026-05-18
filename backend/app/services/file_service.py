"""File service module."""
from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError
from app.db.models import FileRecord, FileScopeLink, Message, User
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
        from app.services.file_scope_service import FileScopeService

        await ChannelService(self.session).require_can_send_message(channel_id, uploader)
        channel = await self.channel_repo.get_by_id(channel_id)
        if not channel:
            raise NotFoundError("channel not found")
        pipeline = FilePipelineService()
        record, reservation, metadata = pipeline.create_presigned_upload(
            channel_id=channel_id,
            workspace_id=channel.workspace_id,
            uploader_id=uploader.user_id,
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
        )
        self.session.add(record)
        await self.session.flush()
        await FileScopeService(self.session).ensure_personal_link(record)
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
        scope_service = None
        if rec.channel_id:
            from app.services.file_scope_service import FileScopeService

            scope_service = FileScopeService(self.session)
            channel = await self.channel_repo.get_by_id(rec.channel_id)
            if channel:
                await scope_service.link_file_to_channel(rec, channel, created_by=uploader.user_id)
        if scope_service is None:
            from app.services.file_scope_service import FileScopeService

            scope_service = FileScopeService(self.session)
        await scope_service.ensure_personal_link(rec)
        await self.session.flush()
        return rec

    async def get_download_url(self, file_id: str, user: User) -> str:
        """Get download url."""
        rec = await self.get_or_404(file_id)
        from app.services.file_scope_service import FileScopeService

        await FileScopeService(self.session).require_user_access(rec, user)
        return f"/api/v1/files/{rec.file_id}/download"

    async def delete_or_unlink(
        self,
        file_id: str,
        user: User,
        *,
        scope_type: str | None = None,
        scope_id: str | None = None,
        channel_id: str | None = None,
    ) -> dict:
        """Remove a file from a user-visible scope, hard-deleting when safe."""
        from app.services.file_retention import FileRetentionService
        from app.services.file_scope_service import channel_scope_type

        rec = await self.get_or_404(file_id)
        if channel_id:
            channel = await self.channel_repo.get_by_id(channel_id)
            if not channel:
                raise NotFoundError("channel not found")
            scope_type = channel_scope_type(channel)
            scope_id = channel.channel_id
        if not scope_type and not scope_id:
            scope_type = "personal"
            scope_id = user.user_id
        if not scope_type or not scope_id:
            raise BadRequestError("scope_type and scope_id are required")
        if scope_type not in {"personal", "channel", "dm", "workspace", "task"}:
            raise BadRequestError("invalid scope_type")

        await self._require_delete_permission(rec, user, scope_type=scope_type, scope_id=scope_id)

        if scope_type in {"channel", "dm"} and await self._file_referenced_by_channel_messages(
            file_id, scope_id,
        ):
            raise ConflictError("文件仍被频道消息引用，请先删除相关消息")

        link = (
            await self.session.execute(
                select(FileScopeLink).where(
                    FileScopeLink.file_id == file_id,
                    FileScopeLink.scope_type == scope_type,
                    FileScopeLink.scope_id == scope_id,
                )
            )
        ).scalar_one_or_none()
        unlinked = False
        if link:
            await self.session.delete(link)
            unlinked = True

        if scope_type in {"channel", "dm"} and rec.channel_id == scope_id:
            rec.channel_id = None
            unlinked = True

        await self.session.flush()
        remaining_link_exists = (
            await self.session.scalar(
                select(FileScopeLink.link_id).where(FileScopeLink.file_id == file_id).limit(1)
            )
            is not None
        )
        referenced = await self._file_referenced_by_any_message(file_id)
        if not remaining_link_exists and not referenced:
            if not await FileRetentionService(self.session).delete_physical_assets(rec):
                rec.last_error = "manual cleanup failed"
                await self.session.flush()
                raise AppError("failed to delete file assets")
            await self.session.execute(delete(FileScopeLink).where(FileScopeLink.file_id == file_id))
            await self.session.delete(rec)
            await self.session.flush()
            return {"deleted": True, "unlinked": unlinked}

        self.session.add(rec)
        await self.session.flush()
        return {"deleted": False, "unlinked": unlinked}

    async def _require_delete_permission(
        self,
        rec: FileRecord,
        user: User,
        *,
        scope_type: str,
        scope_id: str,
    ) -> None:
        from app.utils.permissions import is_admin

        if is_admin(user) or rec.uploader_id == user.user_id:
            return
        if scope_type == "personal" and scope_id == user.user_id:
            return
        if scope_type in {"channel", "dm"}:
            try:
                await ChannelService(self.session).require_channel_admin(scope_id, user)
                return
            except ForbiddenError:
                pass
        raise ForbiddenError("无权删除该文件")

    async def _file_referenced_by_channel_messages(self, file_id: str, channel_id: str) -> bool:
        rows = (
            await self.session.execute(
                select(Message.file_ids).where(Message.channel_id == channel_id)
            )
        ).scalars().all()
        return any(file_id in (file_ids or []) for file_ids in rows)

    async def _file_referenced_by_any_message(self, file_id: str) -> bool:
        rows = (await self.session.execute(select(Message.file_ids))).scalars().all()
        return any(file_id in (file_ids or []) for file_ids in rows)
