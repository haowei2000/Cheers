"""Contextual global search service."""
from __future__ import annotations

from typing import Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import BadRequestError, ForbiddenError
from app.core.schemas import (
    BotOwnerInResponse,
    SearchBotHit,
    SearchChannelHit,
    SearchFileHit,
    SearchMessageHit,
    SearchResults,
    SearchTaskHit,
    SearchTodoHit,
    SearchUserHit,
    SearchWorkspaceHit,
)
from app.db.models import (
    AgentTask,
    BotAccount,
    Channel,
    ChannelMembership,
    FileRecord,
    FileScopeLink,
    Friendship,
    Message,
    TodoItem,
    User,
    Workspace,
    WorkspaceMembership,
)
from app.services.bot_service import BotService, bot_scope
from app.utils.permissions import is_admin

SearchContext = Literal[
    "global_nav",
    "add_friend",
    "dm_start",
    "workspace_invite",
    "channel_invite",
    "channel_invite_user",
    "channel_invite_bot",
    "file_lookup",
    "todo_lookup",
    "task_monitor",
]

_VALID_CONTEXTS = {
    "global_nav",
    "add_friend",
    "dm_start",
    "workspace_invite",
    "channel_invite",
    "channel_invite_user",
    "channel_invite_bot",
    "file_lookup",
    "todo_lookup",
    "task_monitor",
}

SearchResultType = Literal[
    "workspaces",
    "channels",
    "users",
    "bots",
    "files",
    "todos",
    "tasks",
    "messages",
]

_VALID_TYPES: set[str] = {
    "workspaces",
    "channels",
    "users",
    "bots",
    "files",
    "todos",
    "tasks",
    "messages",
}


class SearchService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def search(
        self,
        *,
        q: str,
        current_user: User,
        context: str = "global_nav",
        limit: int = 5,
        workspace_id: str | None = None,
        channel_id: str | None = None,
        types: str | None = None,
    ) -> SearchResults:
        q = (q or "").strip()
        context = (context or "global_nav").strip()
        if context not in _VALID_CONTEXTS:
            raise BadRequestError("未知搜索上下文")
        limit = max(1, min(int(limit or 5), 20))
        requested_types = self._parse_types(types)

        empty = SearchResults(q=q, context=context)
        if not q:
            return empty

        if context == "workspace_invite":
            await self._require_workspace(workspace_id, current_user)
            selected = self._selected_types(requested_types, {"users"})
            return SearchResults(
                q=q,
                context=context,
                users=(
                    await self._search_users(
                        q,
                        current_user=current_user,
                        limit=limit,
                        workspace_id=workspace_id,
                        exclude_workspace_members=True,
                    )
                    if "users" in selected
                    else []
                ),
            )

        if context == "channel_invite":
            await self._require_channel(channel_id, current_user)
            selected = self._selected_types(requested_types, {"users", "bots"})
            return SearchResults(
                q=q,
                context=context,
                users=(
                    await self._search_users(
                        q,
                        current_user=current_user,
                        limit=limit,
                        channel_id=channel_id,
                        exclude_channel_members=True,
                    )
                    if "users" in selected
                    else []
                ),
                bots=(
                    await self._search_bots(
                        q,
                        current_user=current_user,
                        limit=limit,
                        channel_id=channel_id,
                        exclude_channel_members=True,
                    )
                    if "bots" in selected
                    else []
                ),
            )

        if context == "channel_invite_user":
            await self._require_channel(channel_id, current_user)
            selected = self._selected_types(requested_types, {"users"})
            return SearchResults(
                q=q,
                context=context,
                users=(
                    await self._search_users(
                        q,
                        current_user=current_user,
                        limit=limit,
                        channel_id=channel_id,
                        exclude_channel_members=True,
                    )
                    if "users" in selected
                    else []
                ),
            )

        if context == "channel_invite_bot":
            await self._require_channel(channel_id, current_user)
            selected = self._selected_types(requested_types, {"bots"})
            return SearchResults(
                q=q,
                context=context,
                bots=(
                    await self._search_bots(
                        q,
                        current_user=current_user,
                        limit=limit,
                        channel_id=channel_id,
                        exclude_channel_members=True,
                    )
                    if "bots" in selected
                    else []
                ),
            )

        if context == "add_friend":
            selected = self._selected_types(requested_types, {"users"})
            return SearchResults(
                q=q,
                context=context,
                users=(
                    await self._search_users(
                        q,
                        current_user=current_user,
                        limit=limit,
                        exclude_friend_ids=True,
                    )
                    if "users" in selected
                    else []
                ),
            )

        if context == "dm_start":
            selected = self._selected_types(requested_types, {"users", "bots"})
            return SearchResults(
                q=q,
                context=context,
                users=(
                    await self._search_users(q, current_user=current_user, limit=limit)
                    if "users" in selected
                    else []
                ),
                bots=(
                    await self._search_bots(q, current_user=current_user, limit=limit)
                    if "bots" in selected
                    else []
                ),
            )

        if context == "file_lookup":
            selected = self._selected_types(requested_types, {"files"})
            return SearchResults(
                q=q,
                context=context,
                files=(
                    await self._search_files(
                        q,
                        current_user=current_user,
                        limit=limit,
                        workspace_id=workspace_id,
                        channel_id=channel_id,
                    )
                    if "files" in selected
                    else []
                ),
            )

        if context == "todo_lookup":
            await self._require_channel(channel_id, current_user)
            selected = self._selected_types(requested_types, {"todos"})
            return SearchResults(
                q=q,
                context=context,
                todos=(
                    await self._search_todos(
                        q,
                        current_user=current_user,
                        limit=limit,
                        channel_id=channel_id,
                    )
                    if "todos" in selected
                    else []
                ),
            )

        if context == "task_monitor":
            selected = self._selected_types(requested_types, {"tasks"})
            return SearchResults(
                q=q,
                context=context,
                tasks=(
                    await self._search_tasks(
                        q,
                        current_user=current_user,
                        limit=limit,
                        workspace_id=workspace_id,
                        channel_id=channel_id,
                        admin_all=current_user.role == "system_admin",
                    )
                    if "tasks" in selected
                    else []
                ),
            )

        selected = self._selected_types(requested_types, _VALID_TYPES)
        return SearchResults(
            q=q,
            context=context,
            workspaces=(
                await self._search_workspaces(q, current_user=current_user, limit=limit)
                if "workspaces" in selected
                else []
            ),
            channels=(
                await self._search_channels(
                    q,
                    current_user=current_user,
                    limit=limit,
                    workspace_id=workspace_id,
                )
                if "channels" in selected
                else []
            ),
            users=(
                await self._search_users(q, current_user=current_user, limit=limit)
                if "users" in selected
                else []
            ),
            bots=(
                await self._search_bots(q, current_user=current_user, limit=limit)
                if "bots" in selected
                else []
            ),
            files=(
                await self._search_files(
                    q,
                    current_user=current_user,
                    limit=limit,
                    workspace_id=workspace_id,
                    channel_id=channel_id,
                )
                if "files" in selected
                else []
            ),
            todos=(
                await self._search_todos(
                    q,
                    current_user=current_user,
                    limit=limit,
                    workspace_id=workspace_id,
                )
                if "todos" in selected
                else []
            ),
            tasks=(
                await self._search_tasks(
                    q,
                    current_user=current_user,
                    limit=limit,
                    workspace_id=workspace_id,
                )
                if "tasks" in selected
                else []
            ),
            messages=(
                await self._search_messages(
                    q,
                    current_user=current_user,
                    limit=limit,
                    workspace_id=workspace_id,
                    channel_id=channel_id,
                )
                if "messages" in selected
                else []
            ),
        )

    def _parse_types(self, raw: str | None) -> set[str] | None:
        if not raw:
            return None
        selected = {part.strip() for part in raw.split(",") if part.strip()}
        if not selected:
            return None
        invalid = selected - _VALID_TYPES
        if invalid:
            raise BadRequestError(f"未知搜索类型: {', '.join(sorted(invalid))}")
        return selected

    def _selected_types(
        self,
        requested: set[str] | None,
        allowed: set[str],
    ) -> set[str]:
        if requested is None:
            return set(allowed)
        return requested & allowed

    async def _require_workspace(self, workspace_id: str | None, current_user: User) -> None:
        if not workspace_id:
            raise BadRequestError("workspace_id 必填")
        if is_admin(current_user):
            return
        membership = await self.session.get(
            WorkspaceMembership,
            {"workspace_id": workspace_id, "user_id": current_user.user_id},
        )
        if not membership:
            raise ForbiddenError("您不是该工作空间的成员")

    async def _require_channel(self, channel_id: str | None, current_user: User) -> None:
        if not channel_id:
            raise BadRequestError("channel_id 必填")
        if is_admin(current_user):
            return
        membership = await self.session.get(
            ChannelMembership,
            {
                "channel_id": channel_id,
                "member_id": current_user.user_id,
            },
        )
        if not membership or membership.member_type != "user":
            raise ForbiddenError("您不是该频道的成员")

    def _pattern(self, q: str) -> str:
        return f"%{q}%"

    def _matches_id_or_text(self, q: str, *cols):
        pattern = self._pattern(q)
        return or_(*(col.ilike(pattern) for col in cols))

    async def _search_workspaces(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
    ) -> list[SearchWorkspaceHit]:
        stmt = (
            select(Workspace)
            .join(WorkspaceMembership, WorkspaceMembership.workspace_id == Workspace.workspace_id)
            .where(
                WorkspaceMembership.user_id == current_user.user_id,
                self._matches_id_or_text(q, Workspace.workspace_id, Workspace.name),
            )
            .order_by(Workspace.created_at.desc())
            .limit(limit)
        )
        rows = (await self.session.execute(stmt)).scalars().all()
        return [
            SearchWorkspaceHit(workspace_id=w.workspace_id, name=w.name, kind=w.kind)
            for w in rows
        ]

    async def _search_channels(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        workspace_id: str | None = None,
    ) -> list[SearchChannelHit]:
        stmt = (
            select(Channel)
            .join(ChannelMembership, ChannelMembership.channel_id == Channel.channel_id)
            .where(
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
                Channel.type != "dm",
                self._matches_id_or_text(q, Channel.channel_id, Channel.name),
            )
        )
        if workspace_id:
            stmt = stmt.where(Channel.workspace_id == workspace_id)
        rows = (
            await self.session.execute(stmt.order_by(Channel.created_at.desc()).limit(limit))
        ).scalars().all()
        return [
            SearchChannelHit(
                channel_id=c.channel_id,
                name=c.name,
                workspace_id=c.workspace_id,
                type=c.type,
            )
            for c in rows
        ]

    async def _search_users(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        workspace_id: str | None = None,
        channel_id: str | None = None,
        exclude_friend_ids: bool = False,
        exclude_workspace_members: bool = False,
        exclude_channel_members: bool = False,
    ) -> list[SearchUserHit]:
        stmt = select(User).where(
            User.user_id != current_user.user_id,
            User.is_deleted == False,  # noqa: E712
            self._matches_id_or_text(q, User.user_id, User.username, User.display_name),
        )

        if exclude_friend_ids:
            friend_ids = await self._accepted_friend_ids(current_user.user_id)
            if friend_ids:
                stmt = stmt.where(User.user_id.notin_(friend_ids))

        if exclude_workspace_members and workspace_id:
            member_ids = await self._workspace_member_ids(workspace_id)
            if member_ids:
                stmt = stmt.where(User.user_id.notin_(member_ids))

        if exclude_channel_members and channel_id:
            member_ids = await self._channel_member_ids(channel_id, member_type="user")
            if member_ids:
                stmt = stmt.where(User.user_id.notin_(member_ids))

        rows = (
            await self.session.execute(
                stmt.order_by(User.display_name, User.username).limit(limit)
            )
        ).scalars().all()
        return [
            SearchUserHit(
                user_id=u.user_id,
                username=u.username,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
            )
            for u in rows
        ]

    async def _search_bots(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        channel_id: str | None = None,
        exclude_channel_members: bool = False,
    ) -> list[SearchBotHit]:
        visible_bots = await BotService(self.session).list_visible(current_user)
        q_lower = q.lower()
        bot_rows = [
            b
            for b in visible_bots
            if q_lower in (b.bot_id or "").lower()
            or q_lower in (b.username or "").lower()
            or q_lower in (b.display_name or "").lower()
            or q_lower in (b.description or "").lower()
        ]

        if exclude_channel_members and channel_id:
            member_ids = await self._channel_member_ids(channel_id, member_type="bot")
            bot_rows = [b for b in bot_rows if b.bot_id not in member_ids]

        bot_rows.sort(key=lambda b: (b.display_name or b.username or "").lower())
        bot_rows = bot_rows[:limit]

        owner_ids = {b.created_by for b in bot_rows if b.created_by}
        owners = await self._users_by_id(owner_ids)
        return [
            SearchBotHit(
                bot_id=b.bot_id,
                username=b.username,
                display_name=b.display_name,
                avatar_url=b.avatar_url,
                scope=bot_scope(b),
                owner=self._owner_payload(owners.get(b.created_by or "")),
            )
            for b in bot_rows
        ]

    async def _search_messages(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        workspace_id: str | None = None,
        channel_id: str | None = None,
    ) -> list[SearchMessageHit]:
        stmt = (
            select(Message)
            .join(ChannelMembership, ChannelMembership.channel_id == Message.channel_id)
            .where(
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
                Message.content.ilike(self._pattern(q)),
                Message.is_secret == False,  # noqa: E712
                Message.is_deleted == False,  # noqa: E712
            )
        )
        if workspace_id:
            stmt = stmt.join(Channel, Channel.channel_id == Message.channel_id).where(
                Channel.workspace_id == workspace_id
            )
        if channel_id:
            stmt = stmt.where(Message.channel_id == channel_id)
        result = await self.session.execute(stmt.order_by(Message.created_at.desc()).limit(limit))
        rows = list(result.scalars().all())
        return await self._message_hits(rows, q, current_user=current_user)

    async def _search_files(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        workspace_id: str | None = None,
        channel_id: str | None = None,
    ) -> list[SearchFileHit]:
        link_channel = aliased(Channel)
        link_membership = aliased(ChannelMembership)
        legacy_channel = aliased(Channel)
        legacy_membership = aliased(ChannelMembership)
        workspace_membership = aliased(WorkspaceMembership)
        task = aliased(AgentTask)
        task_channel = aliased(Channel)
        task_membership = aliased(ChannelMembership)
        stmt = (
            select(FileRecord, link_channel, task_channel, legacy_channel)
            .outerjoin(FileScopeLink, FileScopeLink.file_id == FileRecord.file_id)
            .outerjoin(
                link_channel,
                and_(
                    link_channel.channel_id == FileScopeLink.scope_id,
                    FileScopeLink.scope_type.in_(("channel", "dm")),
                ),
            )
            .outerjoin(
                link_membership,
                and_(
                    link_membership.channel_id == link_channel.channel_id,
                    link_membership.member_id == current_user.user_id,
                    link_membership.member_type == "user",
                ),
            )
            .outerjoin(legacy_channel, legacy_channel.channel_id == FileRecord.channel_id)
            .outerjoin(
                legacy_membership,
                and_(
                    legacy_membership.channel_id == legacy_channel.channel_id,
                    legacy_membership.member_id == current_user.user_id,
                    legacy_membership.member_type == "user",
                ),
            )
            .outerjoin(
                workspace_membership,
                and_(
                    FileScopeLink.scope_type == "workspace",
                    or_(
                        FileScopeLink.scope_id == workspace_membership.workspace_id,
                        FileScopeLink.workspace_id == workspace_membership.workspace_id,
                    ),
                    workspace_membership.user_id == current_user.user_id,
                ),
            )
            .outerjoin(
                task,
                and_(
                    FileScopeLink.scope_type == "task",
                    FileScopeLink.scope_id == task.task_id,
                ),
            )
            .outerjoin(task_channel, task_channel.channel_id == task.channel_id)
            .outerjoin(
                task_membership,
                and_(
                    task_membership.channel_id == task.channel_id,
                    task_membership.member_id == current_user.user_id,
                    task_membership.member_type == "user",
                ),
            )
            .where(
                or_(
                    FileRecord.file_id.ilike(self._pattern(q)),
                    FileRecord.original_filename.ilike(self._pattern(q)),
                    FileRecord.content_type.ilike(self._pattern(q)),
                    FileRecord.status.ilike(self._pattern(q)),
                    FileRecord.summary_3lines.ilike(self._pattern(q)),
                ),
                or_(
                    FileRecord.uploader_id == current_user.user_id,
                    and_(
                        FileScopeLink.scope_type == "personal",
                        FileScopeLink.scope_id == current_user.user_id,
                    ),
                    link_membership.member_id.is_not(None),
                    legacy_membership.member_id.is_not(None),
                    workspace_membership.user_id.is_not(None),
                    task_membership.member_id.is_not(None),
                ),
            )
        )
        if workspace_id:
            stmt = stmt.where(
                or_(
                    FileRecord.workspace_id == workspace_id,
                    FileScopeLink.workspace_id == workspace_id,
                    link_channel.workspace_id == workspace_id,
                    task_channel.workspace_id == workspace_id,
                    legacy_channel.workspace_id == workspace_id,
                )
            )
        if channel_id:
            stmt = stmt.where(
                or_(
                    FileRecord.channel_id == channel_id,
                    and_(
                        FileScopeLink.scope_type.in_(("channel", "dm")),
                        FileScopeLink.scope_id == channel_id,
                    ),
                    task.channel_id == channel_id,
                )
            )
        rows = (
            await self.session.execute(stmt.order_by(FileRecord.created_at.desc()).limit(limit))
        ).all()
        hits: list[SearchFileHit] = []
        seen: set[str] = set()
        q_lower = q.lower()
        for rec, linked_channel, linked_task_channel, legacy in rows:
            if rec.file_id in seen:
                continue
            seen.add(rec.file_id)
            channel = linked_channel or linked_task_channel or legacy
            filename = rec.original_filename or rec.file_id
            summary = rec.summary_3lines or ""
            snippet_source = summary if q_lower in summary.lower() else filename
            hits.append(
                SearchFileHit(
                    file_id=rec.file_id,
                    channel_id=channel.channel_id if channel else (rec.channel_id or ""),
                    channel_name=channel.name if channel else "Files",
                    original_filename=rec.original_filename,
                    content_type=rec.content_type,
                    size_bytes=rec.size_bytes,
                    status=rec.status,
                    snippet=self._snippet(snippet_source, q, width=120),
                    created_at=rec.created_at,
                )
            )
        return hits

    async def _search_todos(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        workspace_id: str | None = None,
        channel_id: str | None = None,
    ) -> list[SearchTodoHit]:
        stmt = (
            select(TodoItem, Channel)
            .join(Channel, Channel.channel_id == TodoItem.channel_id)
            .join(ChannelMembership, ChannelMembership.channel_id == TodoItem.channel_id)
            .where(
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
                or_(
                    TodoItem.todo_id.ilike(self._pattern(q)),
                    TodoItem.content.ilike(self._pattern(q)),
                    TodoItem.status.ilike(self._pattern(q)),
                ),
            )
        )
        if workspace_id:
            stmt = stmt.where(Channel.workspace_id == workspace_id)
        if channel_id:
            stmt = stmt.where(TodoItem.channel_id == channel_id)
        rows = (
            await self.session.execute(stmt.order_by(TodoItem.created_at.desc()).limit(limit))
        ).all()
        return [
            SearchTodoHit(
                todo_id=todo.todo_id,
                channel_id=todo.channel_id,
                channel_name=channel.name,
                content=self._snippet(todo.content, q, width=120),
                status=todo.status,
                assignee_id=todo.assignee_id,
                assignee_type=todo.assignee_type,
                created_at=todo.created_at,
                updated_at=todo.updated_at,
            )
            for todo, channel in rows
        ]

    async def _search_tasks(
        self,
        q: str,
        *,
        current_user: User,
        limit: int,
        workspace_id: str | None = None,
        channel_id: str | None = None,
        admin_all: bool = False,
    ) -> list[SearchTaskHit]:
        trigger_msg = aliased(Message)
        response_msg = aliased(Message)
        stmt = (
            select(AgentTask, Channel, BotAccount, trigger_msg, response_msg)
            .join(Channel, Channel.channel_id == AgentTask.channel_id)
            .outerjoin(BotAccount, BotAccount.bot_id == AgentTask.bot_id)
            .outerjoin(trigger_msg, trigger_msg.msg_id == AgentTask.trigger_msg_id)
            .outerjoin(response_msg, response_msg.msg_id == AgentTask.response_msg_id)
        )
        if not admin_all:
            stmt = stmt.join(
                ChannelMembership,
                ChannelMembership.channel_id == AgentTask.channel_id,
            ).where(
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
            )
        where_clauses = [
            or_(
                AgentTask.task_id.ilike(self._pattern(q)),
                AgentTask.bot_id.ilike(self._pattern(q)),
                AgentTask.trigger_msg_id.ilike(self._pattern(q)),
                AgentTask.response_msg_id.ilike(self._pattern(q)),
                AgentTask.feedback.ilike(self._pattern(q)),
                Channel.name.ilike(self._pattern(q)),
                BotAccount.username.ilike(self._pattern(q)),
                BotAccount.display_name.ilike(self._pattern(q)),
                trigger_msg.content.ilike(self._pattern(q)),
                response_msg.content.ilike(self._pattern(q)),
            )
        ]
        if workspace_id:
            where_clauses.append(Channel.workspace_id == workspace_id)
        if channel_id:
            where_clauses.append(AgentTask.channel_id == channel_id)
        stmt = stmt.where(and_(*where_clauses)).order_by(AgentTask.created_at.desc()).limit(limit)
        rows = (await self.session.execute(stmt)).all()

        hits: list[SearchTaskHit] = []
        for task, channel, bot, trigger, response in rows:
            snippet_source = ""
            if trigger and trigger.content:
                snippet_source = trigger.content
            elif response and response.content:
                snippet_source = response.content
            hits.append(
                SearchTaskHit(
                    task_id=task.task_id,
                    channel_id=task.channel_id,
                    channel_name=channel.name,
                    bot_id=task.bot_id,
                    bot_name=(bot.display_name or bot.username) if bot else None,
                    trigger_msg_id=task.trigger_msg_id,
                    response_msg_id=task.response_msg_id,
                    latency_ms=task.latency_ms,
                    feedback=task.feedback,
                    snippet=self._snippet(snippet_source, q, width=120),
                    created_at=task.created_at,
                )
            )
        return hits

    async def _message_hits(
        self,
        rows: list[Message],
        q: str,
        *,
        current_user: User,
    ) -> list[SearchMessageHit]:
        channel_ids = {m.channel_id for m in rows}
        channel_name_by_id: dict[str, str] = {}
        if channel_ids:
            for c in (
                await self.session.execute(select(Channel).where(Channel.channel_id.in_(channel_ids)))
            ).scalars():
                channel_name_by_id[c.channel_id] = c.name

        sender_user_ids = {m.sender_id for m in rows if m.sender_type == "user"}
        sender_bot_ids = {m.sender_id for m in rows if m.sender_type == "bot"}
        user_label: dict[str, str] = {}
        bot_label: dict[str, str] = {}
        if sender_user_ids:
            users = await self._users_by_id(sender_user_ids)
            user_label = {
                uid: user.display_name or user.username or "user"
                for uid, user in users.items()
            }
        if sender_bot_ids:
            bots = (
                await self.session.execute(
                    select(BotAccount).where(BotAccount.bot_id.in_(sender_bot_ids))
                )
            ).scalars()
            bot_label = {b.bot_id: b.display_name or b.username or "Bot" for b in bots}

        return [
            SearchMessageHit(
                msg_id=m.msg_id,
                channel_id=m.channel_id,
                channel_name=channel_name_by_id.get(m.channel_id, ""),
                sender_label=(
                    "me"
                    if m.sender_id == current_user.user_id
                    else bot_label.get(m.sender_id)
                    or user_label.get(m.sender_id)
                    or "user"
                ),
                snippet=self._snippet(m.content, q),
                created_at=m.created_at,
            )
            for m in rows
        ]

    async def _accepted_friend_ids(self, user_id: str) -> set[str]:
        result = await self.session.execute(
            select(Friendship).where(
                or_(Friendship.user_id == user_id, Friendship.friend_id == user_id),
                Friendship.status == "accepted",
            )
        )
        ids: set[str] = set()
        for friendship in result.scalars().all():
            ids.add(
                friendship.friend_id
                if friendship.user_id == user_id
                else friendship.user_id
            )
        return ids

    async def _workspace_member_ids(self, workspace_id: str) -> set[str]:
        result = await self.session.execute(
            select(WorkspaceMembership.user_id).where(
                WorkspaceMembership.workspace_id == workspace_id
            )
        )
        return {row[0] for row in result.all()}

    async def _channel_member_ids(
        self,
        channel_id: str,
        *,
        member_type: str,
    ) -> set[str]:
        result = await self.session.execute(
            select(ChannelMembership.member_id).where(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_type == member_type,
            )
        )
        return {row[0] for row in result.all()}

    async def _users_by_id(self, user_ids: set[str]) -> dict[str, User]:
        if not user_ids:
            return {}
        rows = (
            await self.session.execute(select(User).where(User.user_id.in_(user_ids)))
        ).scalars()
        return {u.user_id: u for u in rows}

    def _owner_payload(self, owner: User | None) -> BotOwnerInResponse | None:
        if not owner:
            return None
        return BotOwnerInResponse(
            user_id=owner.user_id,
            username=owner.username,
            display_name=owner.display_name,
        )

    def _snippet(self, text: str | None, needle: str, width: int = 80) -> str:
        if not text:
            return ""
        t = text.replace("\n", " ").strip()
        idx = t.lower().find(needle.lower())
        if idx < 0:
            return t[:width] + ("..." if len(t) > width else "")
        start = max(0, idx - width // 3)
        end = min(len(t), start + width)
        out = t[start:end]
        if start > 0:
            out = "..." + out
        if end < len(t):
            out = out + "..."
        return out
