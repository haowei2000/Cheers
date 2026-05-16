"""Contextual global search."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.core.schemas import SearchResults
from app.db.models import User
from app.services.search_service import SearchService

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=APIResponse[SearchResults])
async def global_search(
    q: str = Query("", description="query, 1+ chars; empty -> no hits"),
    context: str = Query("global_nav", description="workflow context for server-side filtering"),
    limit: int = Query(5, ge=1, le=20),
    workspace_id: str | None = Query(None),
    channel_id: str | None = Query(None),
    types: str | None = Query(
        None,
        description="comma-separated result groups: workspaces,channels,users,bots,files,todos,tasks,messages",
    ),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    results = await SearchService(session).search(
        q=q,
        context=context,
        limit=limit,
        workspace_id=workspace_id,
        channel_id=channel_id,
        types=types,
        current_user=current_user,
    )
    return APIResponse.ok(results)
