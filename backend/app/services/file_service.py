"""File service module."""
from __future__ import annotations

import shutil
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import resolve_data_dir, settings
from app.core.exceptions import (
    AppError,
    BadRequestError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
)
from app.db.models import Channel, FileRecord, FileScopeLink, Message, User, Workspace
from app.repositories.channel_repo import ChannelRepository
from app.repositories.file_repo import FileRepository
from app.services.channel_service import ChannelService
from app.services.file_retention import file_expires_at
from app.services.file_scope_service import (
    SCOPE_CHANNEL,
    SCOPE_DM,
    SCOPE_PERSONAL,
    SCOPE_PERSONAL_HIDDEN,
    SCOPE_TASK,
    SCOPE_WORKSPACE,
    FileScopeService,
)
from app.utils.permissions import is_admin


class FileService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.file_repo = FileRepository(session)
        self.channel_repo = ChannelRepository(session)

    async def _workspace_is_personal(self, workspace_id: str | None) -> bool:
        if not workspace_id:
            return False
        workspace = await self.session.get(Workspace, workspace_id)
        return bool(workspace and workspace.kind == "personal")

    async def _channel_is_personal_space(self, channel: Channel | None) -> bool:
        return bool(channel and await self._workspace_is_personal(channel.workspace_id))

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
        if await self._channel_is_personal_space(channel):
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
        scope_service = FileScopeService(self.session)
        if rec.channel_id:
            channel = await self.channel_repo.get_by_id(rec.channel_id)
            if channel:
                await scope_service.link_file_to_channel(rec, channel, created_by=uploader.user_id)
        if await self._workspace_is_personal(rec.workspace_id):
            await scope_service.ensure_personal_link(rec)
        await self.session.flush()
        return rec

    async def get_download_url(self, file_id: str, user: User) -> str:
        """Get download url."""
        rec = await self.get_or_404(file_id)
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
        """Remove a file from a user-visible scope, hard-deleting when safe.

        Personal-library deletion never requires deleting channel messages. If
        another scope or message still references the file, remove the user's
        personal link and add a hidden marker so it stays out of the library.
        """
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
            scope_type = SCOPE_PERSONAL
            scope_id = user.user_id
        if not scope_type or not scope_id:
            raise BadRequestError("scope_type and scope_id are required")
        if scope_type not in {SCOPE_PERSONAL, SCOPE_CHANNEL, SCOPE_DM, SCOPE_WORKSPACE, SCOPE_TASK}:
            raise BadRequestError("invalid scope_type")

        await self._require_delete_permission(rec, user, scope_type=scope_type, scope_id=scope_id)

        if scope_type in {SCOPE_CHANNEL, SCOPE_DM} and await self._file_referenced_by_channel_messages(
            file_id,
            scope_id,
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
        message_reference_count = await self._message_reference_count(file_id)
        unlinked = False
        if link:
            await self.session.delete(link)
            unlinked = True

        if scope_type in {SCOPE_CHANNEL, SCOPE_DM} and rec.channel_id == scope_id:
            rec.channel_id = None
            unlinked = True

        await self.session.flush()
        if not await self._visible_scope_link_exists(file_id) and message_reference_count == 0:
            if not await FileRetentionService(self.session).delete_physical_assets(rec):
                rec.last_error = "manual cleanup failed"
                await self.session.flush()
                raise AppError("failed to delete file assets")
            await self.session.execute(delete(FileScopeLink).where(FileScopeLink.file_id == file_id))
            await self.session.delete(rec)
            await self.session.flush()
            return {"deleted": True, "unlinked": unlinked}

        if scope_type == SCOPE_PERSONAL and scope_id == user.user_id and unlinked:
            await FileScopeService(self.session).ensure_link(
                file_id=file_id,
                scope_type=SCOPE_PERSONAL_HIDDEN,
                scope_id=user.user_id,
                workspace_id=rec.workspace_id,
                created_by=user.user_id,
            )

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
        if is_admin(user) or rec.uploader_id == user.user_id:
            return
        if scope_type == SCOPE_PERSONAL and scope_id == user.user_id:
            personal_link = await self.session.scalar(
                select(FileScopeLink.link_id)
                .where(
                    FileScopeLink.file_id == rec.file_id,
                    FileScopeLink.scope_type == SCOPE_PERSONAL,
                    FileScopeLink.scope_id == user.user_id,
                )
                .limit(1)
            )
            if personal_link is not None:
                return
        if scope_type in {SCOPE_CHANNEL, SCOPE_DM}:
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
        return await self._message_reference_count(file_id) > 0

    async def _message_reference_count(self, file_id: str) -> int:
        rows = (
            await self.session.execute(
                select(Message.file_ids).where(Message.file_ids.is_not(None))
            )
        ).scalars().all()
        return sum(1 for file_ids in rows if file_id in (file_ids or []))

    async def _visible_scope_link_exists(self, file_id: str) -> bool:
        link_id = await self.session.scalar(
            select(FileScopeLink.link_id)
            .where(
                FileScopeLink.file_id == file_id,
                FileScopeLink.scope_type != SCOPE_PERSONAL_HIDDEN,
            )
            .limit(1)
        )
        return link_id is not None

    async def clone_to_personal_channel(
        self,
        source: FileRecord,
        *,
        target_channel: Channel,
        owner: User,
    ) -> FileRecord:
        if not await self._channel_is_personal_space(target_channel):
            raise BadRequestError("target channel is not in personal space")
        await FileScopeService(self.session).require_user_access(source, owner)

        now = datetime.utcnow()
        file_id = str(uuid.uuid4())
        original_path = source.original_path
        object_key = None
        storage_bucket = None
        md_path = None

        if source.object_key or source.storage_bucket:
            original_path, object_key, storage_bucket = await self._clone_remote_object(
                source,
                file_id,
            )
            md_path = self._clone_optional_markdown_cache(
                source,
                file_id,
                target_channel.channel_id,
            )
        else:
            original_path = self._clone_local_path(
                source.original_path,
                file_id,
                target_channel.channel_id,
                filename=source.original_filename,
            )
            if source.md_path:
                if self._local_paths_equal(source.md_path, source.original_path):
                    md_path = original_path
                else:
                    md_path = self._clone_optional_markdown_cache(
                        source,
                        file_id,
                        target_channel.channel_id,
                    )

        clone = FileRecord(
            file_id=file_id,
            channel_id=target_channel.channel_id,
            workspace_id=target_channel.workspace_id,
            uploader_id=owner.user_id,
            original_path=original_path,
            object_key=object_key,
            storage_bucket=storage_bucket,
            original_filename=source.original_filename,
            content_type=source.content_type,
            size_bytes=source.size_bytes,
            md_path=md_path,
            status=source.status,
            summary_3lines=source.summary_3lines,
            uploaded_at=now,
            expires_at=file_expires_at(now),
            converted_at=now if md_path else None,
        )
        self.session.add(clone)
        await self.session.flush()
        scope_service = FileScopeService(self.session)
        await scope_service.ensure_personal_link(clone)
        await scope_service.link_file_to_channel(clone, target_channel, created_by=owner.user_id)
        return clone

    async def _clone_remote_object(self, source: FileRecord, file_id: str) -> tuple[str, str, str | None]:
        from app.services.storage.base import StorageObjectRef
        from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

        if not is_storage_enabled():
            raise BadRequestError("对象存储未初始化，无法复制文件")
        storage = get_storage_service()
        scope = "generated" if (source.object_key or "").startswith("generated/") else "uploads"
        if source.object_key:
            obj = await storage.get_object_ref(
                StorageObjectRef(
                    file_id=source.file_id,
                    bucket=source.storage_bucket or settings.storage_s3_bucket,
                    object_key=source.object_key,
                    filename=source.original_filename,
                )
            )
        else:
            obj = await storage.get_object(source.file_id, scope=scope)
        ref = await storage.put_object(
            file_id,
            obj.body,
            source.content_type or obj.head.content_type or "application/octet-stream",
            scope="uploads",
        )
        return ref.object_key, ref.object_key, ref.bucket

    def _clone_optional_markdown_cache(
        self,
        source: FileRecord,
        file_id: str,
        channel_id: str,
    ) -> str | None:
        if not source.md_path:
            return None
        try:
            return self._clone_local_path(
                source.md_path,
                f"{file_id}-cache",
                channel_id,
                filename=f"{file_id}.md",
            )
        except (BadRequestError, OSError, FileNotFoundError):
            return None

    def _local_paths_equal(self, left: str, right: str) -> bool:
        left_path = self._resolve_local_path(left).resolve()
        right_path = self._resolve_local_path(right).resolve()
        return left_path == right_path

    def _clone_local_path(
        self,
        raw_path: str | None,
        file_id: str,
        channel_id: str,
        *,
        filename: str | None = None,
    ) -> str:
        if not raw_path:
            raise BadRequestError("源文件不存在，无法复制")
        source = self._resolve_local_path(raw_path)
        if not source.is_file():
            raise BadRequestError("源文件不存在，无法复制")

        suffix = Path(filename or raw_path).suffix
        target_dir = resolve_data_dir() / "personal-files" / channel_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{file_id}{suffix}"
        shutil.copyfile(source, target)
        return str(target)

    def _resolve_local_path(self, raw_path: str) -> Path:
        source = Path(raw_path)
        if source.is_absolute():
            return source
        return resolve_data_dir() / source
