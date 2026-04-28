"""Workspace 数据访问层."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel, User, Workspace, WorkspaceMembership


class WorkspaceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, workspace_id: str) -> Workspace | None:
        result = await self.session.execute(
            select(Workspace).where(Workspace.workspace_id == workspace_id)
        )
        return result.scalar_one_or_none()

    async def list_for_user(self, user_id: str) -> list[Workspace]:
        result = await self.session.execute(
            select(Workspace)
            .join(WorkspaceMembership, Workspace.workspace_id == WorkspaceMembership.workspace_id)
            .where(WorkspaceMembership.user_id == user_id)
            .order_by(Workspace.created_at)
        )
        return list(result.scalars().all())

    async def list_all(self) -> list[Workspace]:
        result = await self.session.execute(select(Workspace).order_by(Workspace.created_at))
        return list(result.scalars().all())

    async def create(self, name: str, kind: str = "team") -> Workspace:
        ws = Workspace(name=name, kind=kind)
        self.session.add(ws)
        await self.session.flush()
        return ws

    async def update(self, ws: Workspace, **kwargs) -> Workspace:
        for key, value in kwargs.items():
            setattr(ws, key, value)
        self.session.add(ws)
        await self.session.flush()
        return ws

    async def delete(self, ws: Workspace) -> None:
        await self.session.delete(ws)
        await self.session.flush()

    # --- Membership ---

    async def get_membership(self, workspace_id: str, user_id: str) -> WorkspaceMembership | None:
        result = await self.session.execute(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == workspace_id,
                WorkspaceMembership.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_members(self, workspace_id: str) -> list[WorkspaceMembership]:
        result = await self.session.execute(
            select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == workspace_id)
        )
        return list(result.scalars().all())

    async def list_members_with_users(self, workspace_id: str) -> list[tuple[WorkspaceMembership, User]]:
        result = await self.session.execute(
            select(WorkspaceMembership, User)
            .join(User, WorkspaceMembership.user_id == User.user_id)
            .where(WorkspaceMembership.workspace_id == workspace_id)
        )
        return list(result.all())

    async def list_channels(self, workspace_id: str) -> list[Channel]:
        result = await self.session.execute(
            select(Channel).where(Channel.workspace_id == workspace_id).order_by(Channel.name)
        )
        return list(result.scalars())

    async def add_member(self, workspace_id: str, user_id: str, role: str = "member") -> WorkspaceMembership:
        membership = WorkspaceMembership(workspace_id=workspace_id, user_id=user_id, role=role)
        self.session.add(membership)
        await self.session.flush()
        return membership

    async def remove_member(self, membership: WorkspaceMembership) -> None:
        await self.session.delete(membership)
        await self.session.flush()
