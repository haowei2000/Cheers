"""Workspaces API routes."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.localization import locale_from_headers
from app.core.responses import APIResponse
from app.db.models import BotAccount, User, Workspace
from app.services.bot_service import BotService
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceDefaultBotOut(BaseModel):
    bot_id: str
    username: str
    display_name: str | None = None
    avatar_url: str | None = None


class WorkspaceOut(BaseModel):
    model_config = {"from_attributes": True}

    workspace_id: str
    name: str
    kind: str = "team"  # "team" | "personal"
    avatar_url: str | None = None
    default_bot_id: str | None = None
    default_bot: WorkspaceDefaultBotOut | None = None


class WorkspaceCreateBody(BaseModel):
    name: str
    avatar_url: str | None = None
    initial_member_ids: list[str] = Field(default_factory=list)


class WorkspaceUpdateBody(BaseModel):
    name: str | None = None
    avatar_url: str | None = None
    default_bot_id: str | None = None


class InviteMemberBody(BaseModel):
    identifier: str
    role: Literal["owner", "admin", "member"] = "member"


def _default_bot_payload(bot: BotAccount | None) -> WorkspaceDefaultBotOut | None:
    if not bot:
        return None
    return WorkspaceDefaultBotOut(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        avatar_url=bot.avatar_url,
    )


async def _workspace_out(
    session: AsyncSession,
    workspace: Workspace,
    current_user: User,
) -> WorkspaceOut:
    default_bot = None
    if workspace.default_bot_id:
        loaded_default_bot = getattr(workspace, "default_bot", None)
        default_bot = (
            loaded_default_bot
            if loaded_default_bot and loaded_default_bot.bot_id == workspace.default_bot_id
            else await session.get(BotAccount, workspace.default_bot_id)
        )
    visible_default_bot = (
        default_bot
        if default_bot and await BotService(session).can_use(default_bot, current_user)
        else None
    )
    default_bot_payload = _default_bot_payload(visible_default_bot)
    return WorkspaceOut(
        workspace_id=workspace.workspace_id,
        name=workspace.name,
        kind=workspace.kind,
        avatar_url=workspace.avatar_url,
        default_bot_id=default_bot_payload.bot_id if default_bot_payload else None,
        default_bot=default_bot_payload,
    )


@router.get("", response_model=APIResponse[list[WorkspaceOut]])
async def list_workspaces(
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    workspaces = await svc.list_for_user(current_user, locale=locale_from_headers(request.headers))
    return APIResponse.ok([
        await _workspace_out(session, workspace, current_user)
        for workspace in workspaces
    ])


@router.post("", response_model=APIResponse[WorkspaceOut])
async def create_workspace(
    body: WorkspaceCreateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = WorkspaceService(session)
    ws = await svc.create(
        body.name,
        creator=current_user,
        avatar_url=body.avatar_url,
        initial_member_ids=body.initial_member_ids,
    )
    return APIResponse.ok(await _workspace_out(session, ws, current_user))


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
        default_bot_id=body.default_bot_id,
        default_bot_id_provided="default_bot_id" in body.model_fields_set,
    )
    return APIResponse.ok(await _workspace_out(session, ws, current_user))


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
