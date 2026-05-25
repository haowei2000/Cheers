"""Document set grouping helpers."""
from __future__ import annotations

import re
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.db.models import DocumentSet, DocumentSetExclusion, DocumentSetItem, FileRecord, User
from app.services.file_retention import active_file_filter
from app.services.file_scope_service import FileScopeService, LibraryFile

DEFAULT_DOCUMENT_SET_RULE = "title_without_digits"
DEFAULT_DOCUMENT_SET_THRESHOLD = 0.9

_DIGITS_RE = re.compile(r"\d+")
_SPACE_RE = re.compile(r"\s+")


def normalize_document_title(filename: str | None) -> str:
    """Normalize a title by removing digits before comparing characters."""
    raw = (filename or "").strip()
    if not raw:
        return ""
    stem = Path(raw).stem or raw
    without_digits = _DIGITS_RE.sub("", stem)
    normalized = _SPACE_RE.sub(" ", without_digits).strip().casefold()
    if normalized:
        return normalized
    return _SPACE_RE.sub(" ", stem).strip().casefold()


def document_title_similarity(left: str | None, right: str | None) -> float:
    left_normalized = normalize_document_title(left)
    right_normalized = normalize_document_title(right)
    if not left_normalized and not right_normalized:
        return 1.0
    if not left_normalized or not right_normalized:
        return 0.0
    return SequenceMatcher(None, left_normalized, right_normalized).ratio()


def _is_non_image_file(record: FileRecord) -> bool:
    return not (record.content_type or "").lower().startswith("image/")


def _document_name(record: FileRecord) -> str:
    filename = record.original_filename or record.file_id
    return Path(filename).stem or filename


def _file_payload(record: FileRecord, channel_id: str) -> dict:
    return {
        "file_id": record.file_id,
        "channel_id": channel_id,
        "original_filename": record.original_filename,
        "content_type": record.content_type,
        "size_bytes": record.size_bytes,
        "status": record.status,
        "summary_3lines": record.summary_3lines,
        "created_at": record.created_at.isoformat() if record.created_at else None,
        "expires_at": record.expires_at.isoformat() if record.expires_at else None,
    }


def _library_file_payload(item: LibraryFile) -> dict:
    record = item.record
    return {
        "file_id": record.file_id,
        "channel_id": item.channel_id,
        "channel_label": item.channel_name,
        "scope_type": item.scope_type,
        "scope_id": item.scope_id,
        "original_filename": record.original_filename,
        "content_type": record.content_type,
        "size_bytes": record.size_bytes,
        "status": record.status,
        "summary_3lines": record.summary_3lines,
        "created_at": record.created_at.isoformat() if record.created_at else None,
        "expires_at": record.expires_at.isoformat() if record.expires_at else None,
    }


class DocumentSetService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list_payload(self, channel_id: str) -> dict:
        records = await self._list_channel_files(channel_id)
        payload_by_id = {record.file_id: _file_payload(record, channel_id) for record in records}
        return await self._build_payload(
            records,
            payload_by_id,
            channel_id=channel_id,
            owner_id=None,
        )

    async def list_library_payload(self, current_user: User) -> dict:
        items = await self._list_library_items(current_user)
        records = [item.record for item in items]
        payload_by_id = {item.record.file_id: _library_file_payload(item) for item in items}
        return await self._build_payload(
            records,
            payload_by_id,
            channel_id=None,
            owner_id=current_user.user_id,
        )

    async def auto_classify(self, channel_id: str, *, created_by: str | None = None) -> None:
        records = await self._list_channel_files(channel_id)
        await self._auto_classify_records(
            records,
            channel_id=channel_id,
            owner_id=None,
            created_by=created_by,
        )

    async def auto_classify_library(self, current_user: User) -> None:
        items = await self._list_library_items(current_user)
        await self._auto_classify_records(
            [item.record for item in items],
            channel_id=None,
            owner_id=current_user.user_id,
            created_by=current_user.user_id,
        )

    async def create_set(
        self,
        channel_id: str,
        *,
        name: str,
        file_ids: list[str] | None = None,
        created_by: str | None = None,
    ) -> DocumentSet:
        document_set = await self._create_set(
            name=name,
            channel_id=channel_id,
            owner_id=None,
            created_by=created_by,
        )
        for file_id in list(dict.fromkeys(file_ids or [])):
            await self.move_file_into_set(channel_id, document_set.set_id, file_id, updated_by=created_by)
        return document_set

    async def create_library_set(
        self,
        current_user: User,
        *,
        name: str,
        file_ids: list[str] | None = None,
    ) -> DocumentSet:
        document_set = await self._create_set(
            name=name,
            channel_id=None,
            owner_id=current_user.user_id,
            created_by=current_user.user_id,
        )
        for file_id in list(dict.fromkeys(file_ids or [])):
            await self.move_library_file_into_set(current_user, document_set.set_id, file_id)
        return document_set

    async def rename_set(
        self,
        channel_id: str,
        set_id: str,
        *,
        name: str,
    ) -> DocumentSet:
        document_set = await self._get_set(channel_id=channel_id, owner_id=None, set_id=set_id)
        return await self._rename_loaded_set(document_set, name=name)

    async def rename_library_set(
        self,
        current_user: User,
        set_id: str,
        *,
        name: str,
    ) -> DocumentSet:
        document_set = await self._get_set(channel_id=None, owner_id=current_user.user_id, set_id=set_id)
        return await self._rename_loaded_set(document_set, name=name)

    async def delete_set(
        self,
        channel_id: str,
        set_id: str,
        *,
        updated_by: str | None = None,
    ) -> None:
        await self._delete_set(
            channel_id=channel_id,
            owner_id=None,
            set_id=set_id,
            updated_by=updated_by,
        )

    async def delete_library_set(self, current_user: User, set_id: str) -> None:
        await self._delete_set(
            channel_id=None,
            owner_id=current_user.user_id,
            set_id=set_id,
            updated_by=current_user.user_id,
        )

    async def move_file_into_set(
        self,
        channel_id: str,
        set_id: str,
        file_id: str,
        *,
        updated_by: str | None = None,
    ) -> None:
        await self._get_set(channel_id=channel_id, owner_id=None, set_id=set_id)
        await self._require_file_in_channel(channel_id, file_id)
        await self._remove_file_from_scope_sets(channel_id=channel_id, owner_id=None, file_id=file_id)
        await self._clear_exclusion(channel_id=channel_id, owner_id=None, file_id=file_id)
        await self._add_item(set_id, file_id, added_by=updated_by, is_manual=True)

    async def move_library_file_into_set(self, current_user: User, set_id: str, file_id: str) -> None:
        await self._get_set(channel_id=None, owner_id=current_user.user_id, set_id=set_id)
        await self._require_file_in_library(current_user, file_id)
        await self._remove_file_from_scope_sets(channel_id=None, owner_id=current_user.user_id, file_id=file_id)
        await self._clear_exclusion(channel_id=None, owner_id=current_user.user_id, file_id=file_id)
        await self._add_item(set_id, file_id, added_by=current_user.user_id, is_manual=True)

    async def move_file_out_of_set(
        self,
        channel_id: str,
        set_id: str,
        file_id: str,
        *,
        updated_by: str | None = None,
    ) -> None:
        await self._move_file_out_of_scope_set(
            channel_id=channel_id,
            owner_id=None,
            set_id=set_id,
            file_id=file_id,
            updated_by=updated_by,
        )

    async def move_library_file_out_of_set(self, current_user: User, set_id: str, file_id: str) -> None:
        await self._move_file_out_of_scope_set(
            channel_id=None,
            owner_id=current_user.user_id,
            set_id=set_id,
            file_id=file_id,
            updated_by=current_user.user_id,
        )

    async def _build_payload(
        self,
        records: list[FileRecord],
        payload_by_id: dict[str, dict],
        *,
        channel_id: str | None,
        owner_id: str | None,
    ) -> dict:
        records_by_id = {record.file_id: record for record in records}
        document_sets = await self._list_sets(channel_id=channel_id, owner_id=owner_id)
        items_by_set = await self._active_items_by_set(
            records_by_id,
            channel_id=channel_id,
            owner_id=owner_id,
        )

        grouped_file_ids: set[str] = set()
        sets_payload: list[dict] = []
        for document_set in document_sets:
            files = items_by_set.get(document_set.set_id, [])
            grouped_file_ids.update(record.file_id for record in files)
            sets_payload.append(
                {
                    "set_id": document_set.set_id,
                    "channel_id": document_set.channel_id,
                    "owner_id": document_set.owner_id,
                    "name": document_set.name,
                    "auto_rule": document_set.auto_rule,
                    "similarity_threshold": document_set.similarity_threshold,
                    "file_count": len(files),
                    "created_at": document_set.created_at.isoformat() if document_set.created_at else None,
                    "updated_at": document_set.updated_at.isoformat() if document_set.updated_at else None,
                    "files": [payload_by_id[record.file_id] for record in files if record.file_id in payload_by_id],
                }
            )

        ungrouped_files = [
            payload_by_id[record.file_id]
            for record in records
            if record.file_id not in grouped_file_ids and record.file_id in payload_by_id
        ]
        return {
            "auto_rule": DEFAULT_DOCUMENT_SET_RULE,
            "similarity_threshold": DEFAULT_DOCUMENT_SET_THRESHOLD,
            "sets": sets_payload,
            "ungrouped_files": ungrouped_files,
        }

    async def _auto_classify_records(
        self,
        records: list[FileRecord],
        *,
        channel_id: str | None,
        owner_id: str | None,
        created_by: str | None,
    ) -> None:
        if not records:
            return

        document_sets = await self._list_sets(channel_id=channel_id, owner_id=owner_id)
        assigned_file_ids = await self._assigned_file_ids(channel_id=channel_id, owner_id=owner_id)
        excluded_file_ids = await self._excluded_file_ids(channel_id=channel_id, owner_id=owner_id)
        candidate_records = [
            record
            for record in records
            if record.file_id not in assigned_file_ids and record.file_id not in excluded_file_ids
        ]
        if not candidate_records:
            return

        records_by_id = {record.file_id: record for record in records}
        items_by_set = await self._active_items_by_set(
            records_by_id,
            channel_id=channel_id,
            owner_id=owner_id,
        )
        remaining: list[FileRecord] = []
        for record in candidate_records:
            target = self._best_matching_set(record, document_sets, items_by_set)
            if target:
                await self._add_item(target.set_id, record.file_id, added_by=created_by, is_manual=False)
                assigned_file_ids.add(record.file_id)
                items_by_set[target.set_id].append(record)
            else:
                remaining.append(record)

        for cluster in self._cluster_records(remaining):
            if len(cluster) < 2:
                continue
            document_set = DocumentSet(
                channel_id=channel_id,
                owner_id=owner_id,
                name=_document_name(cluster[0]),
                auto_rule=DEFAULT_DOCUMENT_SET_RULE,
                similarity_threshold=DEFAULT_DOCUMENT_SET_THRESHOLD,
                created_by=created_by,
            )
            self.session.add(document_set)
            await self.session.flush()
            document_sets.append(document_set)
            for record in cluster:
                await self._add_item(document_set.set_id, record.file_id, added_by=created_by, is_manual=False)

    async def _create_set(
        self,
        *,
        name: str,
        channel_id: str | None,
        owner_id: str | None,
        created_by: str | None,
    ) -> DocumentSet:
        clean_name = name.strip()
        if not clean_name:
            raise BadRequestError("document set name is required")
        document_set = DocumentSet(
            channel_id=channel_id,
            owner_id=owner_id,
            name=clean_name[:255],
            auto_rule=DEFAULT_DOCUMENT_SET_RULE,
            similarity_threshold=DEFAULT_DOCUMENT_SET_THRESHOLD,
            created_by=created_by,
        )
        self.session.add(document_set)
        await self.session.flush()
        return document_set

    async def _rename_loaded_set(self, document_set: DocumentSet, *, name: str) -> DocumentSet:
        clean_name = name.strip()
        if not clean_name:
            raise BadRequestError("document set name is required")
        document_set.name = clean_name[:255]
        self.session.add(document_set)
        await self.session.flush()
        return document_set

    async def _delete_set(
        self,
        *,
        channel_id: str | None,
        owner_id: str | None,
        set_id: str,
        updated_by: str | None,
    ) -> None:
        document_set = await self._get_set(channel_id=channel_id, owner_id=owner_id, set_id=set_id)
        file_ids = (
            await self.session.execute(
                select(DocumentSetItem.file_id).where(DocumentSetItem.set_id == set_id)
            )
        ).scalars().all()
        for file_id in file_ids:
            await self._mark_excluded(
                channel_id=channel_id,
                owner_id=owner_id,
                file_id=file_id,
                updated_by=updated_by,
            )
        await self.session.delete(document_set)
        await self.session.flush()

    async def _move_file_out_of_scope_set(
        self,
        *,
        channel_id: str | None,
        owner_id: str | None,
        set_id: str,
        file_id: str,
        updated_by: str | None,
    ) -> None:
        await self._get_set(channel_id=channel_id, owner_id=owner_id, set_id=set_id)
        if channel_id:
            await self._require_file_in_channel(channel_id, file_id)
        else:
            owner = await self.session.get(User, owner_id)
            if owner is None:
                raise NotFoundError("user not found")
            await self._require_file_in_library(owner, file_id)
        await self.session.execute(
            delete(DocumentSetItem).where(
                DocumentSetItem.set_id == set_id,
                DocumentSetItem.file_id == file_id,
            )
        )
        await self._mark_excluded(
            channel_id=channel_id,
            owner_id=owner_id,
            file_id=file_id,
            updated_by=updated_by,
        )
        await self.session.flush()

    async def _list_sets(self, *, channel_id: str | None, owner_id: str | None) -> list[DocumentSet]:
        rows = await self.session.execute(
            select(DocumentSet)
            .where(*self._document_set_scope_conditions(channel_id=channel_id, owner_id=owner_id))
            .order_by(DocumentSet.created_at.asc(), DocumentSet.name.asc())
        )
        return list(rows.scalars().all())

    async def _list_channel_files(self, channel_id: str) -> list[FileRecord]:
        records = await FileScopeService(self.session).list_for_channel(channel_id)
        return sorted(
            [record for record in records if _is_non_image_file(record)],
            key=lambda record: record.created_at,
        )

    async def _list_library_items(self, current_user: User) -> list[LibraryFile]:
        items = await FileScopeService(self.session).list_library_for_user(current_user)
        return [item for item in items if _is_non_image_file(item.record)]

    async def _get_set(self, *, channel_id: str | None, owner_id: str | None, set_id: str) -> DocumentSet:
        document_set = await self.session.get(DocumentSet, set_id)
        if not document_set:
            raise NotFoundError("document set not found")
        if channel_id is not None and document_set.channel_id == channel_id and document_set.owner_id is None:
            return document_set
        if owner_id is not None and document_set.owner_id == owner_id and document_set.channel_id is None:
            return document_set
        raise NotFoundError("document set not found")

    async def _require_file_in_channel(self, channel_id: str, file_id: str) -> FileRecord:
        records = await self._list_channel_files(channel_id)
        record = next((item for item in records if item.file_id == file_id), None)
        if record is None:
            raise NotFoundError("file not found in channel")
        return record

    async def _require_file_in_library(self, current_user: User, file_id: str) -> LibraryFile:
        items = await self._list_library_items(current_user)
        item = next((entry for entry in items if entry.record.file_id == file_id), None)
        if item is None:
            raise NotFoundError("file not found in library")
        return item

    async def _assigned_file_ids(self, *, channel_id: str | None, owner_id: str | None) -> set[str]:
        rows = await self.session.execute(
            select(DocumentSetItem.file_id)
            .join(DocumentSet, DocumentSet.set_id == DocumentSetItem.set_id)
            .where(*self._document_set_scope_conditions(channel_id=channel_id, owner_id=owner_id))
        )
        return set(rows.scalars().all())

    async def _excluded_file_ids(self, *, channel_id: str | None, owner_id: str | None) -> set[str]:
        rows = await self.session.execute(
            select(DocumentSetExclusion.file_id).where(
                *self._exclusion_scope_conditions(channel_id=channel_id, owner_id=owner_id)
            )
        )
        return set(rows.scalars().all())

    async def _active_items_by_set(
        self,
        records_by_id: dict[str, FileRecord],
        *,
        channel_id: str | None,
        owner_id: str | None,
    ) -> dict[str, list[FileRecord]]:
        rows = await self.session.execute(
            select(DocumentSetItem.set_id, FileRecord)
            .join(DocumentSet, DocumentSet.set_id == DocumentSetItem.set_id)
            .join(FileRecord, FileRecord.file_id == DocumentSetItem.file_id)
            .where(
                *self._document_set_scope_conditions(channel_id=channel_id, owner_id=owner_id),
                active_file_filter(),
            )
            .order_by(DocumentSetItem.added_at.asc(), FileRecord.created_at.asc())
        )
        items_by_set: dict[str, list[FileRecord]] = defaultdict(list)
        for set_id, record in rows.all():
            if record.file_id in records_by_id:
                items_by_set[set_id].append(record)
        return items_by_set

    def _best_matching_set(
        self,
        record: FileRecord,
        document_sets: list[DocumentSet],
        items_by_set: dict[str, list[FileRecord]],
    ) -> DocumentSet | None:
        best_set: DocumentSet | None = None
        best_score = 0.0
        for document_set in document_sets:
            names = [item.original_filename or item.file_id for item in items_by_set.get(document_set.set_id, [])]
            if not names:
                names = [document_set.name]
            score = max(
                document_title_similarity(record.original_filename or record.file_id, name)
                for name in names
            )
            if score > best_score:
                best_score = score
                best_set = document_set
        if best_set and best_score >= DEFAULT_DOCUMENT_SET_THRESHOLD:
            return best_set
        return None

    def _cluster_records(self, records: list[FileRecord]) -> list[list[FileRecord]]:
        clusters: list[list[FileRecord]] = []
        for record in records:
            for cluster in clusters:
                if any(
                    document_title_similarity(
                        record.original_filename or record.file_id,
                        item.original_filename or item.file_id,
                    )
                    >= DEFAULT_DOCUMENT_SET_THRESHOLD
                    for item in cluster
                ):
                    cluster.append(record)
                    break
            else:
                clusters.append([record])
        return clusters

    async def _remove_file_from_scope_sets(
        self,
        *,
        channel_id: str | None,
        owner_id: str | None,
        file_id: str,
    ) -> None:
        set_ids = select(DocumentSet.set_id).where(
            *self._document_set_scope_conditions(channel_id=channel_id, owner_id=owner_id)
        )
        await self.session.execute(
            delete(DocumentSetItem).where(
                DocumentSetItem.file_id == file_id,
                DocumentSetItem.set_id.in_(set_ids),
            )
        )

    async def _add_item(
        self,
        set_id: str,
        file_id: str,
        *,
        added_by: str | None,
        is_manual: bool,
    ) -> None:
        existing = await self.session.scalar(
            select(DocumentSetItem).where(
                DocumentSetItem.set_id == set_id,
                DocumentSetItem.file_id == file_id,
            )
        )
        if existing:
            existing.added_by = added_by or existing.added_by
            existing.is_manual = is_manual
            self.session.add(existing)
            await self.session.flush()
            return
        self.session.add(
            DocumentSetItem(
                set_id=set_id,
                file_id=file_id,
                added_by=added_by,
                is_manual=is_manual,
            )
        )
        await self.session.flush()

    async def _mark_excluded(
        self,
        *,
        channel_id: str | None,
        owner_id: str | None,
        file_id: str,
        updated_by: str | None,
    ) -> None:
        existing = await self.session.scalar(
            select(DocumentSetExclusion).where(
                *self._exclusion_scope_conditions(channel_id=channel_id, owner_id=owner_id),
                DocumentSetExclusion.file_id == file_id,
            )
        )
        if existing:
            existing.updated_by = updated_by or existing.updated_by
            self.session.add(existing)
        else:
            self.session.add(
                DocumentSetExclusion(
                    channel_id=channel_id,
                    owner_id=owner_id,
                    file_id=file_id,
                    updated_by=updated_by,
                )
            )
        await self.session.flush()

    async def _clear_exclusion(self, *, channel_id: str | None, owner_id: str | None, file_id: str) -> None:
        await self.session.execute(
            delete(DocumentSetExclusion).where(
                *self._exclusion_scope_conditions(channel_id=channel_id, owner_id=owner_id),
                DocumentSetExclusion.file_id == file_id,
            )
        )

    def _document_set_scope_conditions(self, *, channel_id: str | None, owner_id: str | None) -> list:
        if channel_id is not None:
            return [DocumentSet.channel_id == channel_id, DocumentSet.owner_id.is_(None)]
        if owner_id is not None:
            return [DocumentSet.owner_id == owner_id, DocumentSet.channel_id.is_(None)]
        raise BadRequestError("document set scope is required")

    def _exclusion_scope_conditions(self, *, channel_id: str | None, owner_id: str | None) -> list:
        if channel_id is not None:
            return [DocumentSetExclusion.channel_id == channel_id, DocumentSetExclusion.owner_id.is_(None)]
        if owner_id is not None:
            return [DocumentSetExclusion.owner_id == owner_id, DocumentSetExclusion.channel_id.is_(None)]
        raise BadRequestError("document set scope is required")
