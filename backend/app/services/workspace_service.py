"""Workspace service module."""
from __future__ import annotations

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import Channel, ChannelMembership, User, Workspace, WorkspaceMembership
from app.repositories.user_repo import UserRepository
from app.repositories.workspace_repo import WorkspaceRepository
from app.utils.permissions import is_admin

PERSONAL_WORKSPACE_KIND = "personal"
TEAM_WORKSPACE_KIND = "team"
WORKSPACE_CHANNEL_TYPES = ("public", "workspace")
WORKSPACE_MEMBER_ROLES = {"owner", "admin", "member"}


class WorkspaceService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = WorkspaceRepository(session)
        self.user_repo = UserRepository(session)

    async def _check_workspace_permission(self, workspace_id: str, current_user: User, allowed_roles=("owner", "admin")) -> None:
        """Check workspace permission."""
        if is_admin(current_user):
            return
        membership = await self.repo.get_membership(workspace_id, current_user.user_id)
        if not membership or membership.role not in allowed_roles:
            raise ForbiddenError("没有权限执行此操作（需要工作空间所有者或管理员权限）")

    async def _check_workspace_member(self, workspace_id: str, current_user: User) -> None:
        """Check workspace member."""
        if is_admin(current_user):
            return
        membership = await self.repo.get_membership(workspace_id, current_user.user_id)
        if not membership:
            raise ForbiddenError("您不是该工作空间的成员")

    async def create(self, name: str, creator: User, avatar_url: str | None = None) -> Workspace:
        name = name.strip()
        if not name:
            raise BadRequestError("name 不能为空")
        ws = await self.repo.create(name)
        if avatar_url:
            ws.avatar_url = avatar_url.strip() or None
            self.session.add(ws)
            await self.session.flush()
        await self.repo.add_member(ws.workspace_id, creator.user_id, role="owner")
        return ws

    async def get_or_404(self, workspace_id: str) -> Workspace:
        ws = await self.repo.get_by_id(workspace_id)
        if not ws:
            raise NotFoundError("workspace not found")
        return ws

    async def list_for_user(self, user: User) -> list[Workspace]:
        # Make sure every user has a personal workspace the first time
        # they're observed. This is where DMs land.
        await self.ensure_personal_workspace(user)
        return await self.repo.list_for_user(user.user_id)

    async def get_personal_workspace(self, user: User) -> Workspace | None:
        """Return the caller's personal workspace if it exists, else None."""
        rows = await self.session.execute(
            select(Workspace)
            .join(
                WorkspaceMembership,
                WorkspaceMembership.workspace_id == Workspace.workspace_id,
            )
            .where(
                WorkspaceMembership.user_id == user.user_id,
                Workspace.kind == PERSONAL_WORKSPACE_KIND,
            )
            .limit(1)
        )
        return rows.scalar_one_or_none()

    async def ensure_personal_workspace(self, user: User) -> Workspace:
        """Idempotent: return (creating if necessary) the caller's personal
        workspace. Owner role; the name is simply "Personal" — the UI can
        decorate it however it wants."""
        existing = await self.get_personal_workspace(user)
        if existing:
            return existing
        ws = await self.repo.create("Personal", kind=PERSONAL_WORKSPACE_KIND)
        await self.repo.add_member(ws.workspace_id, user.user_id, role="owner")
        await self.session.flush()
        return ws

    async def ensure_can_manage(
        self,
        workspace_id: str,
        current_user: User,
        allowed_roles=("owner", "admin"),
    ) -> None:
        await self._check_workspace_permission(workspace_id, current_user, allowed_roles=allowed_roles)

    async def update(
        self,
        workspace_id: str,
        current_user: User,
        *,
        name: str | None = None,
        avatar_url: str | None = None,
        avatar_url_provided: bool = False,
    ) -> Workspace:
        ws = await self.get_or_404(workspace_id)
        await self.ensure_can_manage(workspace_id, current_user)
        updates: dict[str, str | None] = {}
        if name is not None:
            name = name.strip()
            if not name:
                raise BadRequestError("name 不能为空")
            updates["name"] = name
        if avatar_url_provided:
            updates["avatar_url"] = avatar_url.strip() if avatar_url else None
        if not updates:
            return ws
        return await self.repo.update(ws, **updates)

    async def delete(self, workspace_id: str, current_user: User) -> None:
        ws = await self.get_or_404(workspace_id)
        # Only owners or global admins can delete workspaces.
        await self._check_workspace_permission(workspace_id, current_user, allowed_roles=("owner",))
        await self.repo.delete(ws)

    # --- Membership ---

    async def invite_member(
        self, workspace_id: str, identifier: str, role: str, current_user: User
    ) -> WorkspaceMembership:
        await self.get_or_404(workspace_id)
        await self._check_workspace_permission(workspace_id, current_user)
        if role not in WORKSPACE_MEMBER_ROLES:
            raise BadRequestError("role must be one of: owner, admin, member")
        identifier = identifier.strip()
        user = await self.user_repo.get_by_id(identifier)
        if not user:
            user = await self.user_repo.get_by_username_or_email(identifier)
        if not user:
            raise NotFoundError(f"用户 '{identifier}' 不存在")
        existing = await self.repo.get_membership(workspace_id, user.user_id)
        if existing:
            await self._ensure_workspace_channel_memberships(
                workspace_id,
                user.user_id,
                workspace_role=existing.role,
                added_by=current_user.user_id,
            )
            return existing
        membership = await self.repo.add_member(workspace_id, user.user_id, role)
        await self._ensure_workspace_channel_memberships(
            workspace_id,
            user.user_id,
            workspace_role=membership.role,
            added_by=current_user.user_id,
        )
        return membership

    async def _ensure_workspace_channel_memberships(
        self,
        workspace_id: str,
        user_id: str,
        *,
        workspace_role: str,
        added_by: str | None,
    ) -> None:
        """Backfill membership for workspace-scope channels.

        The database still stores legacy "public" for channels that are now
        described in the UI as "workspace" channels.
        """
        rows = await self.session.execute(
            select(Channel.channel_id)
            .where(
                Channel.workspace_id == workspace_id,
                Channel.type.in_(WORKSPACE_CHANNEL_TYPES),
            )
            .order_by(Channel.created_at)
        )
        channel_ids = rows.scalars().all()
        if not channel_ids:
            return

        channel_role = "admin" if workspace_role in ("owner", "admin") else "member"
        for channel_id in channel_ids:
            existing = await self.session.execute(
                select(ChannelMembership).where(
                    ChannelMembership.channel_id == channel_id,
                    ChannelMembership.member_id == user_id,
                    ChannelMembership.member_type == "user",
                )
            )
            if existing.scalar_one_or_none():
                continue
            self.session.add(
                ChannelMembership(
                    channel_id=channel_id,
                    member_id=user_id,
                    member_type="user",
                    role=channel_role,
                    added_by=added_by,
                )
            )
        await self.session.flush()

    async def remove_member(
        self, workspace_id: str, user_id: str, current_user: User
    ) -> None:
        await self.get_or_404(workspace_id)
        # Allow admin operations, or let users leave a workspace if they are not the last owner.
        if user_id != current_user.user_id:
            await self._check_workspace_permission(workspace_id, current_user)

        membership = await self.repo.get_membership(workspace_id, user_id)
        if not membership:
            raise NotFoundError("membership not found")
        await self.repo.remove_member(membership)

    async def list_members(self, workspace_id: str) -> list[WorkspaceMembership]:
        await self.get_or_404(workspace_id)
        return await self.repo.list_members(workspace_id)

    async def list_members_with_details(self, workspace_id: str, current_user: User) -> list[dict]:
        await self.get_or_404(workspace_id)
        await self._check_workspace_member(workspace_id, current_user)
        rows = await self.repo.list_members_with_users(workspace_id)
        return [
            {"user_id": m.user_id, "username": u.username, "display_name": u.display_name, "role": m.role}
            for m, u in rows
        ]

    async def list_channels(self, workspace_id: str, current_user: User) -> list:
        await self.get_or_404(workspace_id)
        membership = await self.repo.get_membership(workspace_id, current_user.user_id)
        if not membership and not is_admin(current_user):
            raise ForbiddenError("您不是该工作空间的成员")

        if is_admin(current_user) or (membership and membership.role in ("owner", "admin")):
            rows = await self.session.execute(
                select(Channel)
                .where(
                    Channel.workspace_id == workspace_id,
                    Channel.type != "dm",
                )
                .order_by(Channel.name)
            )
            return list(rows.scalars().all())

        rows = await self.session.execute(
            select(Channel)
            .outerjoin(
                ChannelMembership,
                and_(
                    ChannelMembership.channel_id == Channel.channel_id,
                    ChannelMembership.member_id == current_user.user_id,
                    ChannelMembership.member_type == "user",
                ),
            )
            .where(
                Channel.workspace_id == workspace_id,
                Channel.type != "dm",
                or_(
                    Channel.type.in_(WORKSPACE_CHANNEL_TYPES),
                    ChannelMembership.channel_id.is_not(None),
                ),
            )
            .order_by(Channel.name)
        )
        return list(rows.scalars().all())
