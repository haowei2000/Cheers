"""Context v1 路由（四层记忆 GET/PUT）."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_session
from app.core.exceptions import BadRequestError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import Channel
from app.memory.manager import load, save_layer

router = APIRouter(prefix="/channels", tags=["context"])

_VALID_LAYERS = {"ANCHOR", "DECISIONS", "FILES_INDEX", "RECENT", "PROGRESS"}


class ContextUpdate(BaseModel):
    layer: str
    content: str


@router.get("/{channel_id}/context", response_model=APIResponse[dict])
async def get_context(
    channel_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise NotFoundError("channel not found")
    data = await load(channel_id)
    return APIResponse.ok(data)


@router.put("/{channel_id}/context", response_model=APIResponse[None])
async def update_context(
    channel_id: str,
    body: ContextUpdate,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    if body.layer not in _VALID_LAYERS:
        raise BadRequestError(f"invalid layer, must be one of: {', '.join(_VALID_LAYERS)}")
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise NotFoundError("channel not found")
    await save_layer(channel_id, body.layer, body.content)
    return APIResponse.ok(None)
