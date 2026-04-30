from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.db.models import TodoItem, User
from app.services.channel_service import ChannelService

router = APIRouter(prefix="/channels/{channel_id}/todos", tags=["todos"])

class TodoCreate(BaseModel):
    content: str
    assignee_id: Optional[str] = None
    assignee_type: Optional[str] = None

class TodoUpdate(BaseModel):
    content: Optional[str] = None
    status: Optional[str] = None
    assignee_id: Optional[str] = None
    assignee_type: Optional[str] = None

class TodoResponse(BaseModel):
    todo_id: str
    channel_id: str
    creator_id: str
    creator_type: str
    assignee_id: Optional[str]
    assignee_type: Optional[str]
    content: str
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

@router.get("/", response_model=List[TodoResponse])
async def list_todos(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    await ChannelService(db).require_channel_member(channel_id, current_user)
    stmt = select(TodoItem).where(TodoItem.channel_id == channel_id).order_by(TodoItem.created_at.desc())
    result = await db.execute(stmt)
    todos = result.scalars().all()

    return [TodoResponse.model_validate(t) for t in todos]

@router.post("/", response_model=TodoResponse)
async def create_todo(
    channel_id: str,
    todo_in: TodoCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    await ChannelService(db).require_channel_member(channel_id, current_user)
    todo = TodoItem(
        channel_id=channel_id,
        creator_id=current_user.user_id,
        creator_type="user",
        assignee_id=todo_in.assignee_id,
        assignee_type=todo_in.assignee_type,
        content=todo_in.content,
        status="pending"
    )
    db.add(todo)
    await db.commit()
    await db.refresh(todo)
    return TodoResponse.model_validate(todo)

@router.put("/{todo_id}", response_model=TodoResponse)
async def update_todo(
    channel_id: str,
    todo_id: str,
    todo_in: TodoUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    await ChannelService(db).require_channel_member(channel_id, current_user)
    todo = await db.get(TodoItem, todo_id)
    if not todo or todo.channel_id != channel_id:
        raise HTTPException(status_code=404, detail="Todo not found")

    if todo_in.content is not None:
        todo.content = todo_in.content
    if todo_in.status is not None:
        todo.status = todo_in.status
    if todo_in.assignee_id is not None:
        todo.assignee_id = todo_in.assignee_id
    if todo_in.assignee_type is not None:
        todo.assignee_type = todo_in.assignee_type

    await db.commit()
    await db.refresh(todo)
    return TodoResponse.model_validate(todo)

@router.delete("/{todo_id}")
async def delete_todo(
    channel_id: str,
    todo_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    await ChannelService(db).require_channel_member(channel_id, current_user)
    todo = await db.get(TodoItem, todo_id)
    if not todo or todo.channel_id != channel_id:
        raise HTTPException(status_code=404, detail="Todo not found")

    await db.delete(todo)
    await db.commit()
    return {"detail": "ok"}
