"""频道 Context Store REST：GET/PUT 四层记忆."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Channel
from app.db.session import get_session
from app.memory.manager import load, save_layer

router = APIRouter(prefix="/api/channels", tags=["context"])


@router.get("/{channel_id}/context")
async def get_context(
    channel_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """读取频道四层 Context Store."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    data = await load(channel_id)
    return {"status": "success", "data": data}


class ContextUpdate(BaseModel):
    layer: str  # ANCHOR | DECISIONS | FILES_INDEX | RECENT
    content: str


@router.put("/{channel_id}/context")
async def update_context(
    channel_id: str,
    body: ContextUpdate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新频道某一层 Context Store."""
    if body.layer not in ("ANCHOR", "DECISIONS", "FILES_INDEX", "RECENT", "PROGRESS"):
        raise HTTPException(status_code=400, detail="invalid layer")
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    await save_layer(channel_id, body.layer, body.content)
    return {"status": "success"}
