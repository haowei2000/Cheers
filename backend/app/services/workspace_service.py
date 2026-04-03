"""Workspace 业务逻辑层."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError, ForbiddenError
from app.db.models import User, Workspace, WorkspaceMembership
from app.repositories.workspace_repo import WorkspaceRepository
from app.repositories.user_repo import UserRepository


class WorkspaceService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = WorkspaceRepository(session)
        self.user_repo = UserRepository(session)

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
        return await self.repo.list_for_user(user.user_id)

    async def list_all(self) -> list[Workspace]:
        return await self.repo.list_all()

    async def update(self, workspace_id: str, name: str, current_user: User) -> Workspace:
        ws = await self.get_or_404(workspace_id)
        name = name.strip()
        if not name:
            raise BadRequestError("name 不能为空")
        return await self.repo.update(ws, name=name)

    async def delete(self, workspace_id: str, current_user: User) -> None:
        ws = await self.get_or_404(workspace_id)
        await self.repo.delete(ws)

    # --- Membership ---

    async def add_member(
        self, workspace_id: str, user_id: str, role: str, current_user: User
    ) -> WorkspaceMembership:
        await self.get_or_404(workspace_id)
        user = await self.user_repo.get_by_id(user_id)
        if not user:
            raise NotFoundError("user not found")
        existing = await self.repo.get_membership(workspace_id, user_id)
        if existing:
            return existing
        return await self.repo.add_member(workspace_id, user_id, role)

    async def invite_member(
        self, workspace_id: str, identifier: str, role: str, current_user: User
    ) -> WorkspaceMembership:
        await self.get_or_404(workspace_id)
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
        membership = await self.repo.get_membership(workspace_id, user_id)
        if not membership:
            raise NotFoundError("membership not found")
        await self.repo.remove_member(membership)

    async def list_members(self, workspace_id: str) -> list[WorkspaceMembership]:
        await self.get_or_404(workspace_id)
        return await self.repo.list_members(workspace_id)

    async def list_members_with_details(self, workspace_id: str) -> list[dict]:
        rows = await self.repo.list_members_with_users(workspace_id)
        return [
            {"user_id": m.user_id, "username": u.username, "display_name": u.display_name, "role": m.role}
            for m, u in rows
        ]

    async def list_channels(self, workspace_id: str) -> list:
        return await self.repo.list_channels(workspace_id)
