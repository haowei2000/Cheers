"""Memory entries CRUD：ANCHOR / DECISIONS / PROGRESS 层的条目级增删改查。"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import asc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.db.models import MemoryEntry, User
from app.features.memory.channel_memory import ENTRY_LAYERS
from app.services.channel_service import ChannelService

router = APIRouter(prefix="/channels/{channel_id}/memory", tags=["memory"])

_VALID_LAYERS = set(ENTRY_LAYERS)


# ── Schemas ───────────────────────────────────────────────────────────────────

class EntryCreate(BaseModel):
    layer: str
    title: Optional[str] = None
    content: str

class EntryUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    sort_order: Optional[int] = None

class EntryResponse(BaseModel):
    entry_id: str
    channel_id: str
    layer: str
    title: Optional[str]
    content: str
    sort_order: int
    created_by: Optional[str]
    creator_type: Optional[str]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]

    model_config = ConfigDict(from_attributes=True)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[EntryResponse])
async def list_entries(
    channel_id: str,
    layer: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """列出频道的记忆条目，可按层筛选。"""
    await ChannelService(db).require_channel_member(channel_id, current_user)
    q = select(MemoryEntry).where(MemoryEntry.channel_id == channel_id)
    if layer:
        layer_upper = layer.upper()
        if layer_upper not in _VALID_LAYERS:
            raise HTTPException(400, f"invalid layer, must be one of: {', '.join(sorted(_VALID_LAYERS))}")
        q = q.where(MemoryEntry.layer == layer_upper)
    q = q.order_by(asc(MemoryEntry.layer), asc(MemoryEntry.sort_order), asc(MemoryEntry.created_at))
    result = await db.execute(q)
    return [EntryResponse.model_validate(e) for e in result.scalars().all()]


@router.post("/", response_model=EntryResponse)
async def create_entry(
    channel_id: str,
    body: EntryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """创建一条记忆条目。"""
    await ChannelService(db).require_channel_admin(channel_id, current_user)
    layer_upper = body.layer.upper()
    if layer_upper not in _VALID_LAYERS:
        raise HTTPException(400, f"invalid layer, must be one of: {', '.join(sorted(_VALID_LAYERS))}")

    # Read the current maximum sort_order for this layer.
    max_order = await db.scalar(
        select(func.max(MemoryEntry.sort_order))
        .where(MemoryEntry.channel_id == channel_id, MemoryEntry.layer == layer_upper)
    )
    next_order = (max_order or 0) + 1

    entry = MemoryEntry(
        channel_id=channel_id,
        layer=layer_upper,
        title=body.title,
        content=body.content,
        sort_order=next_order,
        created_by=current_user.user_id,
        creator_type="user",
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return EntryResponse.model_validate(entry)


@router.put("/{entry_id}", response_model=EntryResponse)
async def update_entry(
    channel_id: str,
    entry_id: str,
    body: EntryUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """更新一条记忆条目。"""
    await ChannelService(db).require_channel_admin(channel_id, current_user)
    entry = await db.get(MemoryEntry, entry_id)
    if not entry or entry.channel_id != channel_id:
        raise HTTPException(404, "entry not found")

    if body.title is not None:
        entry.title = body.title
    if body.content is not None:
        entry.content = body.content
    if body.sort_order is not None:
        entry.sort_order = body.sort_order

    await db.commit()
    await db.refresh(entry)
    return EntryResponse.model_validate(entry)


@router.delete("/{entry_id}")
async def delete_entry(
    channel_id: str,
    entry_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session),
):
    """删除一条记忆条目。"""
    await ChannelService(db).require_channel_admin(channel_id, current_user)
    entry = await db.get(MemoryEntry, entry_id)
    if not entry or entry.channel_id != channel_id:
        raise HTTPException(404, "entry not found")

    await db.delete(entry)
    await db.commit()
    return {"detail": "ok"}
