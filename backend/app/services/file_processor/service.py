"""文件上传与解析服务：封装 presign、校验、对象读取与文本解析。"""
from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import FileRecord
from app.services.file_processor.convert import (
    ALL_SUPPORTED_TYPES,
    SUPPORTED_DOCUMENT_TYPES,
    FileParseError,
    ParsedDocument,
    UnsupportedFileTypeError,
    is_image_type,
    parse_document_bytes,
)
from app.services.file_retention import active_file_filter, file_expires_at
from app.services.storage.base import (
    StorageClientInitError,
    StorageObject,
    StorageObjectHead,
    StorageObjectNotFoundError,
    StorageProvider,
)
from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

logger = logging.getLogger("app.services.file_processor.service")


class FileFlowError(Exception):
    """文件链路业务异常。"""

    def __init__(self, detail: str, *, status_code: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class FileUploadReservation:
    """前端直传所需的完整信息。"""

    file_id: str
    object_key: str
    upload_url: str
    headers: dict[str, str]
    expires_in: int


class FilePipelineService:
    """复用存储抽象层，完成文件上传前校验与推理前准备。"""

    def __init__(
        self,
        storage: StorageProvider | None = None,
        *,
        app_settings=settings,
    ) -> None:
        self.storage = storage or (get_storage_service() if is_storage_enabled() else None)
        self.settings = app_settings

    def create_presigned_upload(
        self,
        *,
        channel_id: str,
        uploader_id: str,
        filename: str,
        content_type: str,
        size_bytes: int,
    ) -> tuple[FileRecord, FileUploadReservation, dict[str, str]]:
        if self.storage is None:
            raise FileFlowError("对象存储未初始化，无法生成上传凭证", status_code=503)
        normalized_name, normalized_type = self._validate_upload_request(
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
        )
        file_id = str(uuid.uuid4())
        upload = self.storage.create_presigned_put_url(
            file_id,
            content_type=normalized_type,
            filename=normalized_name,
        )
        record = FileRecord(
            file_id=file_id,
            channel_id=channel_id,
            uploader_id=uploader_id,
            original_path=upload.object_key,
            object_key=upload.object_key,
            storage_bucket=upload.bucket,
            original_filename=normalized_name,
            content_type=normalized_type,
            size_bytes=size_bytes,
            status="pending_upload",
            expires_at=file_expires_at(),
        )
        metadata = {
            "channel_id": channel_id,
            "uploader_id": uploader_id,
            "filename": normalized_name,
            "content_type": normalized_type,
            "size_bytes": str(size_bytes),
        }
        return record, FileUploadReservation(
            file_id=upload.file_id,
            object_key=upload.object_key,
            upload_url=upload.upload_url,
            headers=upload.headers,
            expires_in=upload.expires_in,
        ), metadata

    async def write_upload_metadata(self, file_id: str, metadata: dict[str, str]) -> None:
        if self.storage is None:
            return
        await self.storage.put_metadata_if_needed(file_id, metadata)

    async def validate_message_files(
        self,
        session: AsyncSession,
        *,
        channel_id: str,
        file_ids: list[str],
    ) -> list[FileRecord]:
        records = await self._load_records(session, channel_id=channel_id, file_ids=file_ids)
        for record in records:
            await self._ensure_object_ready(record)
        return records

    async def prepare_attachments(
        self,
        session: AsyncSession,
        *,
        channel_id: str,
        file_ids: list[str],
    ) -> list[dict[str, str]]:
        """Fully load attachments, including body text.

        Documents prefer the disk cache to avoid repeated download and parsing.
        """
        records = await self._load_records(session, channel_id=channel_id, file_ids=file_ids)
        attachments: list[dict[str, str]] = []
        for record in records:
            record.status = "processing"

            # Image file: read bytes and base64-encode them for Vision LLM use.
            if is_image_type(record.content_type or ""):
                await self._ensure_object_ready(record)
                image_b64 = ""
                try:
                    obj = await self._load_record_object(record)
                    if obj.body:
                        image_b64 = base64.b64encode(obj.body).decode("ascii")
                except Exception:
                    logger.warning("failed to load image for vision file_id=%s", record.file_id, exc_info=True)
                record.status = "ready"
                record.last_error = None
                record.converted_at = datetime.utcnow()
                if not record.uploaded_at:
                    record.uploaded_at = datetime.utcnow()
                attachments.append({
                    "file_id": record.file_id,
                    "filename": record.original_filename or record.file_id,
                    "content_type": record.content_type or "",
                    "is_image": "true",
                    "image_b64": image_b64,
                    "summary": "",
                    "content": "",
                    "truncated": "false",
                })
                continue

            # Document file: prefer disk cache written by _persist_parsed_cache.
            if record.md_path:
                try:
                    cache_path = Path(record.md_path)
                    if await asyncio.to_thread(cache_path.exists):
                        text = await asyncio.to_thread(cache_path.read_text, encoding="utf-8")
                        record.status = "ready"
                        if not record.uploaded_at:
                            record.uploaded_at = datetime.utcnow()
                        await session.flush()
                        attachments.append({
                            "file_id": record.file_id,
                            "filename": record.original_filename or record.file_id,
                            "content_type": record.content_type or "",
                            "is_image": "false",
                            "summary": record.summary_3lines or "",
                            "content": text,
                            "truncated": "false",
                        })
                        logger.debug("prepare_attachments: cache hit file_id=%s", record.file_id)
                        continue
                except Exception:
                    logger.warning("prepare_attachments: cache read failed file_id=%s, falling back to storage", record.file_id)

            # Cache miss: download from storage and parse.
            try:
                await self._ensure_object_ready(record)
                obj = await self._load_record_object(record)
                if not obj.body:
                    raise FileFlowError(f"文件 {record.original_filename or record.file_id} 为空，无法推理")
                parsed = await asyncio.to_thread(
                    parse_document_bytes,
                    obj.body,
                    filename=record.original_filename or f"{record.file_id}.txt",
                    content_type=record.content_type or obj.head.content_type,
                    max_chars=self.file_parse_max_chars,
                )
            except StorageObjectNotFoundError as exc:
                await self._mark_failed(
                    session,
                    record,
                    "对象存储中找不到已上传文件，请重新上传后再试",
                )
                raise FileFlowError("对象存储中找不到已上传文件，请重新上传后再试") from exc
            except UnsupportedFileTypeError as exc:
                await self._mark_failed(session, record, str(exc))
                raise FileFlowError("当前仅支持 pdf / docx / xlsx / txt / md / html 文件") from exc
            except FileParseError as exc:
                await self._mark_failed(
                    session,
                    record,
                    f"文件解析失败: {exc}",
                )
                raise FileFlowError(f"文件 {record.original_filename or record.file_id} 解析失败：{exc}") from exc

            await self._persist_parsed_cache(record, parsed)
            record.summary_3lines = parsed.summary or None
            record.last_error = None
            record.status = "ready"
            record.converted_at = datetime.utcnow()
            if not record.uploaded_at:
                record.uploaded_at = datetime.utcnow()
            attachments.append(
                {
                    "file_id": record.file_id,
                    "filename": record.original_filename or record.file_id,
                    "content_type": record.content_type or obj.head.content_type or "",
                    "is_image": "false",
                    "summary": parsed.summary,
                    "content": parsed.text,
                    "truncated": "true" if parsed.truncated else "false",
                }
            )
        return attachments

    async def prepare_metadata_only(
        self,
        session: AsyncSession,
        *,
        channel_id: str,
        file_ids: list[str],
    ) -> list[dict[str, str]]:
        """Load lightweight metadata for orchestrator file reference prompts.

        - Images are fully processed because Vision LLMs need base64.
        - Documents only read DB metadata (filename, content_type, summary_3lines)
          and do not download body text. This reduces storage I/O and token use;
          agents can fetch body text on demand through the read_file tool.
        """
        records = await self._load_records(session, channel_id=channel_id, file_ids=file_ids)
        attachments: list[dict[str, str]] = []
        for record in records:
            if is_image_type(record.content_type or ""):
                # Images still need full processing because Vision LLMs need base64.
                record.status = "processing"
                image_b64 = ""
                try:
                    await self._ensure_object_ready(record)
                    obj = await self._load_record_object(record)
                    if obj.body:
                        image_b64 = base64.b64encode(obj.body).decode("ascii")
                except Exception:
                    logger.warning("prepare_metadata_only: failed to load image file_id=%s", record.file_id, exc_info=True)
                record.status = "ready"
                record.last_error = None
                record.converted_at = datetime.utcnow()
                if not record.uploaded_at:
                    record.uploaded_at = datetime.utcnow()
                attachments.append({
                    "file_id": record.file_id,
                    "filename": record.original_filename or record.file_id,
                    "content_type": record.content_type or "",
                    "is_image": "true",
                    "image_b64": image_b64,
                    "summary": "",
                    "content": "",
                    "truncated": "false",
                })
            else:
                # Documents return DB metadata only and do not download body text.
                attachments.append({
                    "file_id": record.file_id,
                    "filename": record.original_filename or record.file_id,
                    "content_type": record.content_type or "",
                    "is_image": "false",
                    "summary": record.summary_3lines or "",
                    "content": "",
                    "truncated": "false",
                    "preview_url": f"/api/v1/files/{record.file_id}/preview",
                    "download_url": f"/api/v1/files/{record.file_id}/download",
                })
        return attachments

    @property
    def file_parse_max_chars(self) -> int:
        value = getattr(self.settings, "file_parse_max_chars", 12000)
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = 12000
        return max(parsed, 1000)

    def _validate_upload_request(
        self,
        *,
        filename: str,
        content_type: str,
        size_bytes: int,
    ) -> tuple[str, str]:
        normalized_name = Path((filename or "").strip()).name
        if not normalized_name or normalized_name in {".", ".."}:
            raise FileFlowError("文件名不能为空")
        suffix = Path(normalized_name).suffix.lower()
        if suffix not in ALL_SUPPORTED_TYPES:
            raise FileFlowError("当前仅支持 pdf / docx / xlsx / txt / md / html / png / jpg / jpeg / webp / gif 文件")

        # allowed_mime_types = self.allowed_mime_types
        normalized_type = (content_type or "").split(";", 1)[0].strip().lower()
        if not normalized_type:
            normalized_type = self._default_content_type_for_suffix(suffix)
        if normalized_type not in ALL_SUPPORTED_TYPES[suffix]:
            raise FileFlowError(f"文件类型与扩展名不匹配：{normalized_name}")

        if size_bytes <= 0:
            raise FileFlowError("空文件无法上传")
        if size_bytes > self.max_upload_bytes:
            raise FileFlowError(f"文件大小超过限制：最大 {self.max_upload_bytes} 字节")

        return normalized_name, normalized_type

    @property
    def max_upload_bytes(self) -> int:
        value = getattr(self.settings, "file_upload_max_bytes", 25 * 1024 * 1024)
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = 25 * 1024 * 1024
        return max(parsed, 1)

    @property
    def allowed_mime_types(self) -> set[str]:
        raw = (getattr(self.settings, "file_upload_allowed_types", "") or "").strip()
        if not raw:
            values = {mime for mime_types in SUPPORTED_DOCUMENT_TYPES.values() for mime in mime_types}
            return values
        return {part.strip().lower() for part in raw.split(",") if part.strip()}

    async def _load_records(
        self,
        session: AsyncSession,
        *,
        channel_id: str,
        file_ids: list[str],
    ) -> list[FileRecord]:
        unique_ids = [file_id.strip() for file_id in file_ids if file_id and file_id.strip()]
        if not unique_ids:
            return []

        result = await session.execute(
            select(FileRecord).where(
                FileRecord.channel_id == channel_id,
                FileRecord.file_id.in_(unique_ids),
                active_file_filter(),
            )
        )
        by_id = {record.file_id: record for record in result.scalars().all()}
        ordered: list[FileRecord] = []
        missing: list[str] = []
        for file_id in unique_ids:
            record = by_id.get(file_id)
            if record is None:
                missing.append(file_id)
                continue
            ordered.append(record)
        if missing:
            raise FileFlowError(f"存在无效 file_id：{', '.join(missing)}")
        return ordered

    async def _ensure_object_ready(self, record: FileRecord) -> StorageObjectHead:
        if record.object_key or record.storage_bucket:
            return await self._ensure_remote_object_ready(record)
        return await self._ensure_local_object_ready(record)

    async def _ensure_remote_object_ready(self, record: FileRecord) -> StorageObjectHead:
        if self.storage is None:
            raise FileFlowError("对象存储未初始化，无法读取上传文件", status_code=503)
        # Infer scope from the object_key prefix: generated/ or uploads/.
        scope = "generated" if (record.object_key or "").startswith("generated/") else "uploads"
        try:
            if record.object_key:
                from app.config import settings
                from app.services.storage.base import StorageObjectRef

                head = await self.storage.head_object_ref(
                    StorageObjectRef(
                        file_id=record.file_id,
                        bucket=record.storage_bucket or settings.storage_s3_bucket,
                        object_key=record.object_key,
                        filename=record.original_filename,
                    )
                )
            else:
                head = await self.storage.head_object(record.file_id, scope=scope)
        except StorageObjectNotFoundError as exc:
            record.status = "pending_upload"
            record.last_error = "object not found"
            raise FileFlowError("上传文件尚未完成，或对象已不存在，请重新上传") from exc
        except StorageClientInitError as exc:
            logger.exception("failed to head file object file_id=%s", record.file_id)
            raise FileFlowError("对象存储访问失败，请稍后重试", status_code=503) from exc

        if head.content_length <= 0:
            record.status = "failed"
            record.last_error = "empty object"
            raise FileFlowError("空文件无法推理，请重新上传有效内容")
        if head.content_length > self.max_upload_bytes:
            record.status = "failed"
            record.last_error = "object exceeds upload limit"
            raise FileFlowError("上传文件超过系统允许大小")

        record.status = "uploaded"
        record.last_error = None
        record.uploaded_at = record.uploaded_at or datetime.utcnow()
        record.size_bytes = head.content_length
        if head.content_type:
            record.content_type = head.content_type
        return head

    async def _ensure_local_object_ready(self, record: FileRecord) -> StorageObjectHead:
        path = self._resolve_local_path(record.original_path)
        exists = await asyncio.to_thread(path.exists)
        if not exists:
            record.status = "failed"
            record.last_error = "local file not found"
            raise FileFlowError("找不到已上传文件，请重新上传后再试")

        size = await asyncio.to_thread(lambda: path.stat().st_size)
        if size <= 0:
            record.status = "failed"
            record.last_error = "empty local file"
            raise FileFlowError("空文件无法推理，请重新上传有效内容")
        if size > self.max_upload_bytes:
            record.status = "failed"
            record.last_error = "local file exceeds upload limit"
            raise FileFlowError("上传文件超过系统允许大小")

        content_type = record.content_type or self._guess_content_type(record, path)
        record.status = "uploaded"
        record.last_error = None
        record.uploaded_at = record.uploaded_at or datetime.utcnow()
        record.size_bytes = size
        record.content_type = content_type
        return StorageObjectHead(
            file_id=record.file_id,
            bucket=record.storage_bucket or "local",
            object_key=record.object_key or str(path),
            content_length=size,
            content_type=content_type,
        )

    async def _mark_failed(self, session: AsyncSession, record: FileRecord, message: str) -> None:
        record.status = "failed"
        record.last_error = message
        await session.flush()

    async def _load_record_object(self, record: FileRecord) -> StorageObject:
        if record.object_key or record.storage_bucket:
            if self.storage is None:
                raise FileFlowError("对象存储未初始化，无法读取上传文件", status_code=503)
            scope = "generated" if (record.object_key or "").startswith("generated/") else "uploads"
            if record.object_key:
                from app.config import settings
                from app.services.storage.base import StorageObjectRef

                return await self.storage.get_object_ref(
                    StorageObjectRef(
                        file_id=record.file_id,
                        bucket=record.storage_bucket or settings.storage_s3_bucket,
                        object_key=record.object_key,
                        filename=record.original_filename,
                    )
                )
            return await self.storage.get_object(record.file_id, scope=scope)
        return await self._load_local_object(record)

    async def _load_local_object(self, record: FileRecord) -> StorageObject:
        head = await self._ensure_local_object_ready(record)
        path = self._resolve_local_path(record.original_path)
        return StorageObject(head=head, body=await asyncio.to_thread(path.read_bytes))

    def _resolve_local_path(self, original_path: str) -> Path:
        path = Path(original_path)
        if path.is_absolute():
            return path
        return (Path(__file__).resolve().parent.parent.parent / path).resolve()

    def _guess_content_type(self, record: FileRecord, path: Path) -> str:
        guessed, _ = mimetypes.guess_type(record.original_filename or path.name)
        if guessed:
            return guessed
        suffix = (record.original_filename or path.name).lower()
        if suffix.endswith(".txt"):
            return "text/plain"
        if suffix.endswith(".md"):
            return "text/markdown"
        if suffix.endswith(".html") or suffix.endswith(".htm"):
            return "text/html"
        if suffix.endswith(".docx"):
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if suffix.endswith(".pdf"):
            return "application/pdf"
        return "application/octet-stream"

    def _default_content_type_for_suffix(self, suffix: str) -> str:
        if suffix == ".txt":
            return "text/plain"
        if suffix == ".md":
            return "text/markdown"
        if suffix in {".html", ".htm"}:
            return "text/html"
        if suffix == ".docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if suffix == ".pdf":
            return "application/pdf"
        return "application/octet-stream"

    async def _persist_parsed_cache(self, record: FileRecord, parsed: ParsedDocument) -> None:
        base = Path(self.settings.data_dir)
        if not base.is_absolute():
            base = Path(__file__).resolve().parent.parent.parent / base
        cache_dir = base / "converted" / record.channel_id
        cache_path = cache_dir / f"{record.file_id}.md"
        await asyncio.to_thread(cache_dir.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(cache_path.write_text, parsed.text, encoding="utf-8")
        record.md_path = str(cache_path)
