"""Workspace v1 路由（薄层：解析 HTTP → 调 service → 返回 APIResponse）."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session, require_permission, try_get_current_user
from app.core.responses import APIResponse
from app.db.models import User
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceOut(BaseModel):
    model_config = {"from_attributes": True}

    workspace_id: str
    name: str
    kind: str = "team"  # "team" | "personal"


class WorkspaceCreateBody(BaseModel):
    name: str


class AddMemberBody(BaseModel):
    user_id: str
    role: str = "member"


class InviteMemberBody(BaseModel):
    identifier: str
    role: str = "member"


@router.get("", response_model=APIResponse[list[WorkspaceOut]])
async def list_workspaces(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    workspaces = await svc.list_for_user(current_user)
    return APIResponse.ok([WorkspaceOut.model_validate(w) for w in workspaces])


@router.post("", response_model=APIResponse[WorkspaceOut])
async def create_workspace(
    body: WorkspaceCreateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    ws = await svc.create(body.name, creator=current_user)
    return APIResponse.ok(WorkspaceOut.model_validate(ws))


@router.get("/all", response_model=APIResponse[list[WorkspaceOut]])
async def list_all_workspaces(
    _: User = Depends(require_permission("space_management")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    workspaces = await svc.list_all()
    return APIResponse.ok([WorkspaceOut.model_validate(w) for w in workspaces])


@router.delete("/{workspace_id}", response_model=APIResponse[None])
async def delete_workspace(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    await svc.delete(workspace_id, current_user)
    return APIResponse.ok(None)


@router.post("/{workspace_id}/members", response_model=APIResponse[None])
async def add_member(
    workspace_id: str,
    body: AddMemberBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    await svc.add_member(workspace_id, body.user_id, body.role, current_user)
    return APIResponse.ok(None)


@router.post("/{workspace_id}/invite", response_model=APIResponse[None])
async def invite_member(
    workspace_id: str,
    body: InviteMemberBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    await svc.invite_member(workspace_id, body.identifier, body.role, current_user)
    return APIResponse.ok(None)


@router.get("/{workspace_id}/members", response_model=APIResponse[list[dict]])
async def list_workspace_members(
    workspace_id: str,
    _: User | None = Depends(try_get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    return APIResponse.ok(await svc.list_members_with_details(workspace_id))


@router.get("/{workspace_id}/channels", response_model=APIResponse[list[dict]])
async def list_workspace_channels(
    workspace_id: str,
    _: User | None = Depends(try_get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    channels = await svc.list_channels(workspace_id)
    return APIResponse.ok([
        {"channel_id": c.channel_id, "name": c.name, "type": c.type, "purpose": c.purpose}
        for c in channels
    ])


@router.delete("/{workspace_id}/members/{user_id}", response_model=APIResponse[None])
async def remove_member(
    workspace_id: str,
    user_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    await svc.remove_member(workspace_id, user_id, current_user)
    return APIResponse.ok(None)
