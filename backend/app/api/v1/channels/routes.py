"""Channel v1 路由."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.core.schemas import ChannelInResponse
from app.db.models import User
from app.services.channel_service import ChannelService

router = APIRouter(prefix="/channels", tags=["channels"])


class ChannelCreateBody(BaseModel):
    workspace_id: str
    name: str
    type: str = "public"
    purpose: str | None = None
    allow_member_invites: bool | None = None
    allow_bot_adds: bool | None = None


class ChannelUpdateBody(BaseModel):
    name: str | None = None
    purpose: str | None = None
    type: Literal["public", "private"] | None = None
    auto_assist: bool | None = None
    allow_member_invites: bool | None = None
    allow_bot_adds: bool | None = None


class AddMemberBody(BaseModel):
    member_id: str
    member_type: str


class InviteBody(BaseModel):
    identifier: str


class UpdateMemberTemplateBody(BaseModel):
    template_id: str | None = None


class UpdateMemberRoleBody(BaseModel):
    role: str


class ChannelProfileUpdateBody(BaseModel):
    nickname: str | None = None
    bio: str | None = None


async def _channel_response(
    svc: ChannelService,
    channel,
    current_user: User,
    unread_count: int | None = None,
) -> ChannelInResponse:
    item = ChannelInResponse.model_validate(channel)
    item.unread_count = unread_count
    perms = await svc.channel_permission_summary(channel, current_user)
    item.my_role = perms["my_role"]
    item.can_manage = perms["can_manage"]
    item.can_invite_members = perms["can_invite_members"]
    item.can_add_bots = perms["can_add_bots"]
    return item


async def _with_unread(
    svc: ChannelService,
    channels: list,
    unread: dict[str, int],
    current_user: User,
) -> list[ChannelInResponse]:
    out: list[ChannelInResponse] = []
    for c in channels:
        out.append(
            await _channel_response(
                svc, c, current_user, int(unread.get(c.channel_id, 0))
            )
        )
    return out


@router.get("", response_model=APIResponse[list[ChannelInResponse]])
async def list_channels(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    channels = await svc.list_for_user(current_user)
    unread = await svc.unread_counts_for(
        current_user.user_id, [c.channel_id for c in channels]
    )
    return APIResponse.ok(await _with_unread(svc, channels, unread, current_user))


@router.get("/by-workspace/{workspace_id}", response_model=APIResponse[list[ChannelInResponse]])
async def list_channels_by_workspace(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    channels = await svc.list_for_user_in_workspace(workspace_id, current_user)
    unread = await svc.unread_counts_for(
        current_user.user_id, [c.channel_id for c in channels]
    )
    return APIResponse.ok(await _with_unread(svc, channels, unread, current_user))


class MarkReadResponse(BaseModel):
    channel_id: str
    last_read_at: str | None = None


@router.post("/{channel_id}/read", response_model=APIResponse[MarkReadResponse])
async def mark_channel_read(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Advance the caller's read cursor on this channel to "now".
    Idempotent — calling repeatedly just re-stamps the cursor."""
    svc = ChannelService(session)
    ts = await svc.mark_read(channel_id, current_user.user_id)
    if ts is None:
        from app.core.exceptions import ForbiddenError
        raise ForbiddenError("您不是该频道的成员")
    await session.commit()
    return APIResponse.ok(
        MarkReadResponse(
            channel_id=channel_id,
            last_read_at=ts.isoformat() if ts else None,
        )
    )


@router.post("", response_model=APIResponse[ChannelInResponse])
async def create_channel(
    body: ChannelCreateBody,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> APIResponse:
    svc = ChannelService(session)
    ch = await svc.create(
        workspace_id=body.workspace_id,
        name=body.name,
        type=body.type,
        purpose=body.purpose,
        allow_member_invites=body.allow_member_invites,
        allow_bot_adds=body.allow_bot_adds,
        creator=current_user,
    )
    return APIResponse.ok(await _channel_response(svc, ch, current_user))


@router.get("/{channel_id}", response_model=APIResponse[ChannelInResponse])
async def get_channel(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    await svc.require_channel_member(channel_id, current_user)
    ch = await svc.get_or_404(channel_id)
    return APIResponse.ok(await _channel_response(svc, ch, current_user))


@router.patch("/{channel_id}", response_model=APIResponse[ChannelInResponse])
async def update_channel(
    channel_id: str,
    body: ChannelUpdateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    ch = await svc.update(channel_id, current_user, **updates)
    return APIResponse.ok(await _channel_response(svc, ch, current_user))


@router.get("/{channel_id}/settings", response_model=APIResponse[dict])
async def get_channel_settings(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    await svc.require_channel_member(channel_id, current_user)
    ch = await svc.get_or_404(channel_id)
    perms = await svc.channel_permission_summary(ch, current_user)
    members = await svc.list_members_with_details(channel_id, current_user)
    return APIResponse.ok(
        {
            "channel": (await _channel_response(svc, ch, current_user)).model_dump(),
            "permissions": perms,
            "members": members,
        }
    )


@router.patch("/{channel_id}/settings", response_model=APIResponse[ChannelInResponse])
async def update_channel_settings(
    channel_id: str,
    body: ChannelUpdateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    ch = await svc.update(channel_id, current_user, **updates)
    return APIResponse.ok(await _channel_response(svc, ch, current_user))


@router.delete("/{channel_id}", response_model=APIResponse[None])
async def delete_channel(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    await svc.delete(channel_id, current_user)
    return APIResponse.ok(None)


@router.get("/{channel_id}/members", response_model=APIResponse[list[dict]])
async def list_members(
    channel_id: str,
    with_username: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    await svc.require_channel_member(channel_id, current_user)
    if with_username:
        members = await svc.list_members_with_details(channel_id, current_user)
        return APIResponse.ok(members)
    memberships = await svc.repo.list_memberships(channel_id)
    return APIResponse.ok([
        {
            "channel_id": m.channel_id,
            "member_id": m.member_id,
            "member_type": m.member_type,
            "role": m.role or "member",
            "joined_at": m.joined_at.isoformat() if m.joined_at else None,
        }
        for m in memberships
    ])


@router.post("/{channel_id}/members", response_model=APIResponse[dict])
async def add_member(
    channel_id: str,
    body: AddMemberBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    m = await svc.add_member(channel_id, body.member_id, body.member_type, current_user)
    return APIResponse.ok({
        "channel_id": m.channel_id,
        "member_id": m.member_id,
        "member_type": m.member_type,
        "role": m.role or "member",
    })


@router.delete("/{channel_id}/members/{member_id}", response_model=APIResponse[None])
async def remove_member(
    channel_id: str,
    member_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    await svc.remove_member(channel_id, member_id, current_user)
    return APIResponse.ok(None)


@router.patch("/{channel_id}/members/{member_id}/template", response_model=APIResponse[dict])
async def update_member_template(
    channel_id: str,
    member_id: str,
    body: UpdateMemberTemplateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    result = await svc.update_member_template(channel_id, member_id, body.template_id, current_user)
    return APIResponse.ok(result)


@router.patch("/{channel_id}/members/{member_id}/role", response_model=APIResponse[dict])
async def update_member_role(
    channel_id: str,
    member_id: str,
    body: UpdateMemberRoleBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    result = await svc.update_member_role(channel_id, member_id, body.role, current_user)
    return APIResponse.ok(result)


@router.post("/{channel_id}/invite", response_model=APIResponse[dict])
async def invite_member(
    channel_id: str,
    body: InviteBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    result = await svc.invite_by_identifier(channel_id, body.identifier, current_user)
    return APIResponse.ok(result)


@router.get("/{channel_id}/friends-to-invite", response_model=APIResponse[list[dict]])
async def get_friends_to_invite(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    friends = await svc.get_friends_to_invite(channel_id, current_user)
    return APIResponse.ok(friends)


@router.get("/{channel_id}/my-profile", response_model=APIResponse[dict])
async def get_my_profile(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    profile = await svc.get_my_profile(channel_id, current_user.user_id)
    return APIResponse.ok(profile)


@router.put("/{channel_id}/my-profile", response_model=APIResponse[dict])
async def update_my_profile(
    channel_id: str,
    body: ChannelProfileUpdateBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = ChannelService(session)
    profile = await svc.update_my_profile(
        channel_id,
        current_user.user_id,
        nickname=body.nickname,
        bio=body.bio,
    )
    return APIResponse.ok(profile)
