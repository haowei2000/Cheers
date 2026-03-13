"""工作空间 REST：列表与创建（供管理表格表单使用）."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, ConfigDict

from app.db.models import Workspace, Channel, ChannelMembership, User, Message
from app.db.session import get_session
from fastapi import APIRouter, Depends, HTTPException

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


class WorkspaceInResponse(BaseModel):
    """工作空间响应."""
    model_config = ConfigDict(from_attributes=True)
    workspace_id: str
    name: str


class WorkspaceCreate(BaseModel):
    """创建工作空间."""
    name: str


@router.post("")
async def create_workspace(
    body: WorkspaceCreate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建工作空间（管理界面表格表单可调用）。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 不能为空")
    ws = Workspace(name=name)
    session.add(ws)
    await session.commit()
    await session.refresh(ws)
    return {
        "status": "success",
        "data": WorkspaceInResponse.model_validate(ws).model_dump(),
    }


@router.get("")
async def list_workspaces(
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取工作空间列表（创建项目时选择）."""
    result = await session.execute(
        select(Workspace).order_by(Workspace.created_at)
    )
    workspaces = result.scalars().all()
    data = [
        WorkspaceInResponse.model_validate(w).model_dump()
        for w in workspaces
    ]
    return {"status": "success", "data": data}


@router.get("/{workspace_id}/members")
async def list_workspace_members(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取工作空间的所有成员（通过频道成员关联）."""
    # 查找该工作空间的所有频道
    result = await session.execute(
        select(Channel).where(Channel.workspace_id == workspace_id)
    )
    channels = result.scalars().all()
    channel_ids = [c.channel_id for c in channels]

    if not channel_ids:
        return {"status": "success", "data": []}

    # 查找所有成员
    result = await session.execute(
        select(ChannelMembership, User)
        .join(User, ChannelMembership.member_id == User.user_id)
        .where(ChannelMembership.channel_id.in_(channel_ids))
        .where(ChannelMembership.member_type == "user")
    )
    rows = result.all()

    # 去重
    seen = set()
    members = []
    for membership, user in rows:
        if user.user_id not in seen:
            seen.add(user.user_id)
            members.append({
                "user_id": user.user_id,
                "username": user.username,
                "display_name": user.display_name,
                "role": user.role,
            })

    return {"status": "success", "data": members}


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除工作空间（同时删除该工作空间下的所有频道及成员关系）."""
    result = await session.execute(
        select(Workspace).where(Workspace.workspace_id == workspace_id)
    )
    ws = result.scalar_one_or_none()
    if not ws:
        raise HTTPException(status_code=404, detail="工作空间不存在")

    # 获取该工作空间下的所有频道
    result = await session.execute(
        select(Channel).where(Channel.workspace_id == workspace_id)
    )
    channels = result.scalars().all()

    # 先删除所有频道的消息、成员关系，再删除频道
    for ch in channels:
        # 删除该频道的所有消息
        result = await session.execute(
            select(Message).where(Message.channel_id == ch.channel_id)
        )
        messages = result.scalars().all()
        for m in messages:
            await session.delete(m)
        
        # 删除该频道的所有成员关系
        result = await session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == ch.channel_id
            )
        )
        memberships = result.scalars().all()
        for m in memberships:
            await session.delete(m)
        
        await session.flush()  # 确保消息和成员关系已删除
        await session.delete(ch)

    await session.delete(ws)
    await session.commit()

    return {"status": "success", "message": "工作空间已删除"}
