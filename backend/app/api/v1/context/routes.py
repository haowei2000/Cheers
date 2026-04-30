"""Context v1 路由（频道记忆 GET/PUT）。

GET 返回完整记忆（结构化层 + 派生层），兼容旧格式。
PUT 仅允许更新派生层的手动覆盖（FILES_INDEX / RECENT），结构化层请使用 /memory/ 路由。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import BadRequestError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import User
from app.repositories.channel_repo import ChannelRepository
from app.services.channel_service import ChannelService
from app.services.memory.channel_memory import ChannelMemory

router = APIRouter(prefix="/channels", tags=["context"])

# 仍然允许 PUT 覆盖派生层（向后兼容，前端仍可能用到）
_PUT_VALID_LAYERS = {"FILES_INDEX", "RECENT"}


class ContextUpdate(BaseModel):
    layer: str
    content: str


@router.get("/{channel_id}/context", response_model=APIResponse[dict])
async def get_context(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    await ChannelService(session).require_channel_member(channel_id, current_user)
    channel_repo = ChannelRepository(session)
    channel = await channel_repo.get_by_id(channel_id)
    if not channel:
        raise NotFoundError("channel not found")
    mem = await ChannelMemory.load(channel_id, session)
    return APIResponse.ok(mem.to_context_dict())


@router.put("/{channel_id}/context", response_model=APIResponse[None])
async def update_context(
    channel_id: str,
    body: ContextUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """更新派生层内容。结构化层 (ANCHOR/DECISIONS/PROGRESS) 请使用 /memory/ CRUD 路由。"""
    layer_upper = body.layer.upper()
    if layer_upper not in _PUT_VALID_LAYERS:
        raise BadRequestError(
            f"PUT on this endpoint only supports derived layers: {', '.join(sorted(_PUT_VALID_LAYERS))}. "
            f"For ANCHOR/DECISIONS/PROGRESS, use the /memory/ entries API."
        )
    channel_repo = ChannelRepository(session)
    channel = await channel_repo.get_by_id(channel_id)
    if not channel:
        raise NotFoundError("channel not found")
    await ChannelService(session).require_channel_admin(channel_id, current_user)
    from app.services.memory.context_store import init_context_db, set_layer
    await init_context_db()
    await set_layer(channel_id, layer_upper, body.content)
    return APIResponse.ok(None)
