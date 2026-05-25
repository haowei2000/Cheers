"""File scope-link helpers.

FileRecord stores the physical object and upload metadata. FileScopeLink stores
where that file is visible or referenced.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import and_, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db.models import (
    AgentTask,
    Channel,
    ChannelMembership,
    FileRecord,
    FileScopeLink,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.services.file_retention import active_file_filter
from app.utils.permissions import is_admin

SCOPE_PERSONAL = "personal"
SCOPE_WORKSPACE = "workspace"
SCOPE_CHANNEL = "channel"
SCOPE_DM = "dm"
SCOPE_TASK = "task"
SCOPE_PERSONAL_HIDDEN = "personal_hidden"
CHANNEL_SCOPES = {SCOPE_CHANNEL, SCOPE_DM}


@dataclass(frozen=True)
class LibraryFile:
    record: FileRecord
    scope_type: str | None = None
    scope_id: str | None = None
    channel_id: str | None = None
    channel_name: str | None = None


def channel_scope_type(channel: Channel) -> str:
    return SCOPE_DM if channel.type == "dm" else SCOPE_CHANNEL


class FileScopeService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def ensure_link(
        self,
        *,
        file_id: str,
        scope_type: str,
        scope_id: str,
        workspace_id: str | None = None,
        created_by: str | None = None,
    ) -> FileScopeLink:
        existing = (
            await self.session.execute(
                select(FileScopeLink).where(
                    FileScopeLink.file_id == file_id,
                    FileScopeLink.scope_type == scope_type,
                    FileScopeLink.scope_id == scope_id,
                )
            )
        ).scalar_one_or_none()
        if existing:
            return existing
        link = FileScopeLink(
            file_id=file_id,
            scope_type=scope_type,
            scope_id=scope_id,
            workspace_id=workspace_id,
            created_by=created_by,
        )
        self.session.add(link)
        await self.session.flush()
        return link

    async def ensure_personal_link(self, record: FileRecord) -> None:
        await self.ensure_link(
            file_id=record.file_id,
            scope_type=SCOPE_PERSONAL,
            scope_id=record.uploader_id,
            workspace_id=record.workspace_id,
            created_by=record.uploader_id,
        )

    async def _workspace_is_personal(self, workspace_id: str | None) -> bool:
        if not workspace_id:
            return False
        workspace = await self.session.get(Workspace, workspace_id)
        return bool(workspace and workspace.kind == "personal")

    async def _link_personal_library_to_channel_users(
        self,
        record: FileRecord,
        channel: Channel,
        *,
        created_by: str | None = None,
    ) -> None:
        if not await self._workspace_is_personal(channel.workspace_id):
            return
        rows = (
            await self.session.execute(
                select(ChannelMembership.member_id).where(
                    ChannelMembership.channel_id == channel.channel_id,
                    ChannelMembership.member_type == "user",
                )
            )
        ).scalars().all()
        for user_id in dict.fromkeys(rows):
            await self.ensure_link(
                file_id=record.file_id,
                scope_type=SCOPE_PERSONAL,
                scope_id=user_id,
                workspace_id=channel.workspace_id,
                created_by=created_by or record.uploader_id,
            )

    async def link_file_to_channel(
        self,
        record: FileRecord,
        channel: Channel,
        *,
        created_by: str | None = None,
    ) -> None:
        if record.workspace_id is None:
            record.workspace_id = channel.workspace_id
        if record.channel_id is None:
            record.channel_id = channel.channel_id
        await self.ensure_link(
            file_id=record.file_id,
            scope_type=channel_scope_type(channel),
            scope_id=channel.channel_id,
            workspace_id=channel.workspace_id,
            created_by=created_by,
        )
        await self._link_personal_library_to_channel_users(
            record,
            channel,
            created_by=created_by,
        )

    async def link_files_to_channel(
        self,
        *,
        file_ids: list[str],
        channel_id: str,
        created_by: str | None = None,
    ) -> None:
        if not file_ids:
            return
        channel = await self.session.get(Channel, channel_id)
        if channel is None:
            return
        records = (
            await self.session.execute(
                select(FileRecord).where(FileRecord.file_id.in_(file_ids), active_file_filter())
            )
        ).scalars().all()
        for record in records:
            await self.link_file_to_channel(record, channel, created_by=created_by)

    async def file_linked_to_channel(self, *, file_id: str, channel: Channel) -> bool:
        linked = (
            await self.session.execute(
                select(FileScopeLink.link_id)
                .where(
                    FileScopeLink.file_id == file_id,
                    FileScopeLink.scope_type == channel_scope_type(channel),
                    FileScopeLink.scope_id == channel.channel_id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if linked:
            return True
        legacy = (
            await self.session.execute(
                select(FileRecord.file_id)
                .where(
                    FileRecord.file_id == file_id,
                    FileRecord.channel_id == channel.channel_id,
                    active_file_filter(),
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        return bool(legacy)

    async def require_user_access(self, record: FileRecord, current_user: User) -> None:
        from app.core.exceptions import ForbiddenError

        if await self.user_can_access(record, current_user):
            return
        raise ForbiddenError("没有权限访问该文件")

    async def user_can_access(self, record: FileRecord, current_user: User) -> bool:
        if is_admin(current_user) or record.uploader_id == current_user.user_id:
            return True

        personal = (
            await self.session.execute(
                select(FileScopeLink.link_id)
                .where(
                    FileScopeLink.file_id == record.file_id,
                    FileScopeLink.scope_type == SCOPE_PERSONAL,
                    FileScopeLink.scope_id == current_user.user_id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if personal:
            return True

        workspace_membership = (
            await self.session.execute(
                select(WorkspaceMembership.workspace_id)
                .join(
                    FileScopeLink,
                    and_(
                        FileScopeLink.scope_type == SCOPE_WORKSPACE,
                        or_(
                            FileScopeLink.scope_id == WorkspaceMembership.workspace_id,
                            FileScopeLink.workspace_id == WorkspaceMembership.workspace_id,
                        ),
                    ),
                )
                .where(
                    FileScopeLink.file_id == record.file_id,
                    WorkspaceMembership.user_id == current_user.user_id,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if workspace_membership:
            return True

        channel_link = aliased(FileScopeLink)
        membership = (
            await self.session.execute(
                select(ChannelMembership.channel_id)
                .join(
                    channel_link,
                    and_(
                        channel_link.scope_id == ChannelMembership.channel_id,
                        channel_link.scope_type.in_((SCOPE_CHANNEL, SCOPE_DM)),
                    ),
                )
                .where(
                    channel_link.file_id == record.file_id,
                    ChannelMembership.member_id == current_user.user_id,
                    ChannelMembership.member_type == "user",
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if membership:
            return True

        task_channel = (
            await self.session.execute(
                select(ChannelMembership.channel_id)
                .join(AgentTask, AgentTask.channel_id == ChannelMembership.channel_id)
                .join(
                    FileScopeLink,
                    and_(
                        FileScopeLink.scope_type == SCOPE_TASK,
                        FileScopeLink.scope_id == AgentTask.task_id,
                    ),
                )
                .where(
                    FileScopeLink.file_id == record.file_id,
                    ChannelMembership.member_id == current_user.user_id,
                    ChannelMembership.member_type == "user",
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if task_channel:
            return True

        if record.channel_id:
            legacy_membership = (
                await self.session.execute(
                    select(ChannelMembership.channel_id)
                    .where(
                        ChannelMembership.channel_id == record.channel_id,
                        ChannelMembership.member_id == current_user.user_id,
                        ChannelMembership.member_type == "user",
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if legacy_membership:
                return True

        return False

    async def list_for_channel(self, channel_id: str) -> list[FileRecord]:
        channel = await self.session.get(Channel, channel_id)
        if channel is None:
            return []
        linked = (
            await self.session.execute(
                select(FileRecord)
                .join(FileScopeLink, FileScopeLink.file_id == FileRecord.file_id)
                .where(
                    FileScopeLink.scope_type == channel_scope_type(channel),
                    FileScopeLink.scope_id == channel.channel_id,
                    active_file_filter(),
                )
                .order_by(FileRecord.created_at.asc())
            )
        ).scalars().all()
        legacy = (
            await self.session.execute(
                select(FileRecord)
                .where(
                    FileRecord.channel_id == channel.channel_id,
                    active_file_filter(),
                )
                .order_by(FileRecord.created_at.asc())
            )
        ).scalars().all()
        by_id: dict[str, FileRecord] = {}
        for record in [*linked, *legacy]:
            by_id.setdefault(record.file_id, record)
        return list(by_id.values())

    async def list_library_for_user(self, current_user: User) -> list[LibraryFile]:
        channel = aliased(Channel)
        workspace = aliased(Workspace)
        hidden_link = aliased(FileScopeLink)
        hidden_for_user = (
            select(hidden_link.link_id)
            .where(
                hidden_link.file_id == FileRecord.file_id,
                hidden_link.scope_type == SCOPE_PERSONAL_HIDDEN,
                hidden_link.scope_id == current_user.user_id,
            )
            .exists()
            .correlate(FileRecord)
        )
        rows = (
            await self.session.execute(
                select(FileRecord, FileScopeLink, channel)
                .join(
                    FileScopeLink,
                    and_(
                        FileScopeLink.file_id == FileRecord.file_id,
                        FileScopeLink.scope_type == SCOPE_PERSONAL,
                        FileScopeLink.scope_id == current_user.user_id,
                    ),
                )
                .join(workspace, workspace.workspace_id == FileRecord.workspace_id)
                .outerjoin(
                    channel,
                    and_(
                        channel.channel_id == FileRecord.channel_id,
                        channel.workspace_id == workspace.workspace_id,
                    ),
                )
                .where(
                    active_file_filter(),
                    workspace.kind == "personal",
                    ~hidden_for_user,
                )
                .order_by(desc(FileRecord.created_at))
            )
        ).all()
        files: dict[str, LibraryFile] = {}
        for record, link, display_channel in rows:
            files[record.file_id] = LibraryFile(
                record=record,
                scope_type=link.scope_type if link else None,
                scope_id=link.scope_id if link else None,
                channel_id=display_channel.channel_id if display_channel else record.channel_id,
                channel_name=display_channel.name if display_channel else None,
            )
        return list(files.values())
