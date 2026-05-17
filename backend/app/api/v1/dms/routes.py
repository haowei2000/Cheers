"""Dms API routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.core.schemas import DMCounterparty, DMCreateRequest, DMInResponse
from app.db.models import User
from app.services.channel_service import ChannelService
from app.services.workspace_service import WorkspaceService

router = APIRouter(prefix="/dms", tags=["dms"])


@router.get("", response_model=APIResponse[list[DMInResponse]])
async def list_dms(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    await WorkspaceService(session).ensure_personal_workspace(current_user)
    svc = ChannelService(session)
    rows = await svc.list_dms_with_counterparty(current_user)
    unread = await svc.unread_counts_for(
        current_user.user_id, [r["channel_id"] for r in rows]
    )
    out: list[DMInResponse] = []
    for r in rows:
        out.append(
            DMInResponse(
                channel_id=r["channel_id"],
                workspace_id=r["workspace_id"],
                counterparty=DMCounterparty(**r["counterparty"]),
                title=r.get("title"),
                project_id=r.get("project_id"),
                project_title=r.get("project_title"),
                chat_title=r.get("chat_title"),
                session_scope_id=r.get("session_scope_id"),
                created_at=r.get("created_at"),
                unread_count=int(unread.get(r["channel_id"], 0)),
            )
        )
    return APIResponse.ok(out)


@router.post("", response_model=APIResponse[DMInResponse])
async def upsert_dm(
    body: DMCreateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Return the DM channel with the named counterparty. Create on first
    call. Regardless of the workspace_id the client sent, the DM always
    lives in the caller's Personal workspace — DMs are a personal-space
    concept in this product."""
    ws_svc = WorkspaceService(session)
    personal = await ws_svc.ensure_personal_workspace(current_user)
    svc = ChannelService(session)
    ch = await svc.get_or_create_dm(
        workspace_id=personal.workspace_id,
        current_user=current_user,
        other_id=body.member_id,
        other_type=body.member_type,
        create_new=body.create_new,
        title=body.title,
        project_id=body.project_id,
        project_title=body.project_title,
        chat_title=body.chat_title,
    )
    await session.commit()

    # Refetch counterparty profile so the response matches GET /dms shape.
    cp_rows = await svc.list_dms_with_counterparty(current_user)
    cp_row = next((r for r in cp_rows if r["channel_id"] == ch.channel_id), None)
    if not cp_row:
        # Defensive — shouldn't happen since we just created/confirmed it.
        return APIResponse.ok(
            DMInResponse(
                channel_id=ch.channel_id,
                workspace_id=ch.workspace_id,
                counterparty=DMCounterparty(
                    member_id=body.member_id, member_type=body.member_type,
                ),
                title=body.chat_title or body.title,
                project_id=body.project_id,
                project_title=body.project_title,
                chat_title=body.chat_title or body.title,
                session_scope_id=(
                    ch.channel_id
                    if ch.name.startswith("dmchat:")
                    else (
                        f"user:{current_user.user_id}:bot:{body.member_id}"
                        if body.member_type == "bot"
                        else None
                    )
                ),
                created_at=ch.created_at,
                unread_count=0,
            )
        )
    unread = await svc.unread_counts_for(current_user.user_id, [ch.channel_id])
    return APIResponse.ok(
        DMInResponse(
            channel_id=ch.channel_id,
            workspace_id=ch.workspace_id,
            counterparty=DMCounterparty(**cp_row["counterparty"]),
            title=cp_row.get("title"),
            project_id=cp_row.get("project_id"),
            project_title=cp_row.get("project_title"),
            chat_title=cp_row.get("chat_title"),
            session_scope_id=cp_row.get("session_scope_id"),
            created_at=cp_row.get("created_at"),
            unread_count=int(unread.get(ch.channel_id, 0)),
        )
    )
