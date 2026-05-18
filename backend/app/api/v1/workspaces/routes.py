"""Workspaces API routes."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.localization import locale_from_headers
from app.core.responses import APIResponse
from app.db.models import User
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceOut(BaseModel):
    model_config = {"from_attributes": True}

    workspace_id: str
    name: str
    kind: str = "team"  # "team" | "personal"
    avatar_url: str | None = None


class WorkspaceCreateBody(BaseModel):
    name: str
    avatar_url: str | None = None


class WorkspaceUpdateBody(BaseModel):
    name: str | None = None
    avatar_url: str | None = None


class InviteMemberBody(BaseModel):
    identifier: str
    role: Literal["owner", "admin", "member"] = "member"


@router.get("", response_model=APIResponse[list[WorkspaceOut]])
async def list_workspaces(
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    workspaces = await svc.list_for_user(current_user, locale=locale_from_headers(request.headers))
    return APIResponse.ok([WorkspaceOut.model_validate(w) for w in workspaces])


@router.post("", response_model=APIResponse[WorkspaceOut])
async def create_workspace(
    body: WorkspaceCreateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    ws = await svc.create(body.name, creator=current_user, avatar_url=body.avatar_url)
    return APIResponse.ok(WorkspaceOut.model_validate(ws))


@router.put("/{workspace_id}", response_model=APIResponse[WorkspaceOut])
async def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    ws = await svc.update(
        workspace_id,
        current_user,
        name=body.name,
        avatar_url=body.avatar_url,
        avatar_url_provided="avatar_url" in body.model_fields_set,
    )
    return APIResponse.ok(WorkspaceOut.model_validate(ws))


@router.delete("/{workspace_id}", response_model=APIResponse[None])
async def delete_workspace(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    await svc.delete(workspace_id, current_user)
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
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    return APIResponse.ok(await svc.list_members_with_details(workspace_id, current_user))


@router.get("/{workspace_id}/channels", response_model=APIResponse[list[dict]])
async def list_workspace_channels(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    channels = await svc.list_channels(workspace_id, current_user)
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
