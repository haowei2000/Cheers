"""Workspace 业务逻辑层."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.db.models import User, Workspace, WorkspaceMembership
from app.repositories.user_repo import UserRepository
from app.repositories.workspace_repo import WorkspaceRepository
from app.utils.permissions import is_admin

PERSONAL_WORKSPACE_KIND = "personal"
TEAM_WORKSPACE_KIND = "team"


class WorkspaceService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = WorkspaceRepository(session)
        self.user_repo = UserRepository(session)

    async def _check_workspace_permission(self, workspace_id: str, current_user: User, allowed_roles=("owner", "admin")) -> None:
        """检查用户是否有权限在工作空间内执行操作."""
        if is_admin(current_user):
            return
        membership = await self.repo.get_membership(workspace_id, current_user.user_id)
        if not membership or membership.role not in allowed_roles:
            raise ForbiddenError("没有权限执行此操作（需要工作空间所有者或管理员权限）")

    async def _check_workspace_member(self, workspace_id: str, current_user: User) -> None:
        """检查用户是否可读取工作空间内成员/频道等基础信息."""
        if is_admin(current_user):
            return
        membership = await self.repo.get_membership(workspace_id, current_user.user_id)
        if not membership:
            raise ForbiddenError("您不是该工作空间的成员")

    async def create(self, name: str, creator: User) -> Workspace:
        name = name.strip()
        if not name:
            raise BadRequestError("name 不能为空")
        ws = await self.repo.create(name)
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

    async def update(self, workspace_id: str, name: str, current_user: User) -> Workspace:
        ws = await self.get_or_404(workspace_id)
        await self._check_workspace_permission(workspace_id, current_user)
        name = name.strip()
        if not name:
            raise BadRequestError("name 不能为空")
        return await self.repo.update(ws, name=name)

    async def delete(self, workspace_id: str, current_user: User) -> None:
        ws = await self.get_or_404(workspace_id)
        # 只有 owner 或全局 admin 能删除
        await self._check_workspace_permission(workspace_id, current_user, allowed_roles=("owner",))
        await self.repo.delete(ws)

    # --- Membership ---

    async def invite_member(
        self, workspace_id: str, identifier: str, role: str, current_user: User
    ) -> WorkspaceMembership:
        await self.get_or_404(workspace_id)
        await self._check_workspace_permission(workspace_id, current_user)
        user = await self.user_repo.get_by_username_or_email(identifier)
        if not user:
            raise NotFoundError(f"用户 '{identifier}' 不存在")
        existing = await self.repo.get_membership(workspace_id, user.user_id)
        if existing:
            return existing
        return await self.repo.add_member(workspace_id, user.user_id, role)

    async def remove_member(
        self, workspace_id: str, user_id: str, current_user: User
    ) -> None:
        await self.get_or_404(workspace_id)
        # 允许管理员操作，或者允许用户自己退出工作空间（如果不是最后一个 owner）
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
        await self._check_workspace_member(workspace_id, current_user)
        return await self.repo.list_channels(workspace_id)
