"""工作空间 REST：列表与创建（供管理表格表单使用）."""
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, ConfigDict

from app.db.models import Workspace, Channel, ChannelMembership, User, Message, WorkspaceMembership
from app.db.session import get_session
from app.auth.routes import get_current_user, require_permission
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


class AddWorkspaceMemberRequest(BaseModel):
    user_id: str
    role: str = "member"


class InviteWorkspaceMemberRequest(BaseModel):
    """邀请工作空间成员（支持通过用户名或 user_id 搜索）."""
    identifier: str  # 用户名 或 user_id
    role: str = "member"


@router.post("")
async def create_workspace(
    body: WorkspaceCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建工作空间，并将创建者自动加为 owner。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 不能为空")
    ws = Workspace(name=name)
    session.add(ws)
    await session.flush()  # 获取 workspace_id

    # 创建者自动成为 owner
    session.add(WorkspaceMembership(
        workspace_id=ws.workspace_id,
        user_id=current_user.user_id,
        role="owner",
    ))
    await session.commit()
    await session.refresh(ws)
    return {
        "status": "success",
        "data": WorkspaceInResponse.model_validate(ws).model_dump(),
    }


@router.get("")
async def list_workspaces(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取工作空间列表：仅返回用户已加入的工作空间。"""
    result = await session.execute(
        select(Workspace)
        .join(WorkspaceMembership, Workspace.workspace_id == WorkspaceMembership.workspace_id)
        .where(WorkspaceMembership.user_id == current_user.user_id)
        .order_by(Workspace.created_at)
    )
    workspaces = result.scalars().all()

    data = [WorkspaceInResponse.model_validate(w).model_dump() for w in workspaces]
    return {"status": "success", "data": data}


@router.get("/{workspace_id}/members")
async def list_workspace_members(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取工作空间的直接成员列表（WorkspaceMembership）。"""
    ws_result = await session.execute(
        select(Workspace).where(Workspace.workspace_id == workspace_id)
    )
    if not ws_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="工作空间不存在")

    # 必须是该工作空间成员
    mem = await session.execute(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == current_user.user_id,
        )
    )
    if not mem.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="权限不足")

    result = await session.execute(
        select(WorkspaceMembership, User)
        .join(User, WorkspaceMembership.user_id == User.user_id)
        .where(WorkspaceMembership.workspace_id == workspace_id)
    )
    members = [
        {
            "user_id": user.user_id,
            "username": user.username,
            "display_name": user.display_name,
            "role": user.role,
            "workspace_role": wm.role,
        }
        for wm, user in result.all()
    ]
    return {"status": "success", "data": members}


@router.post("/{workspace_id}/members")
async def add_workspace_member(
    workspace_id: str,
    body: AddWorkspaceMemberRequest,
    _: User = Depends(require_permission("space_management")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """添加工作空间成员（需要 space_management 权限）。"""
    if not (await session.execute(select(Workspace).where(Workspace.workspace_id == workspace_id))).scalar_one_or_none():
        raise HTTPException(status_code=404, detail="工作空间不存在")

    if not (await session.execute(select(User).where(User.user_id == body.user_id))).scalar_one_or_none():
        raise HTTPException(status_code=404, detail="用户不存在")

    existing = await session.execute(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == body.user_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="用户已是工作空间成员")

    session.add(WorkspaceMembership(
        workspace_id=workspace_id,
        user_id=body.user_id,
        role=body.role,
    ))
    await session.commit()
    return {"status": "success", "message": "成员已添加"}


@router.delete("/{workspace_id}/members/{user_id}")
async def remove_workspace_member(
    workspace_id: str,
    user_id: str,
    _: User = Depends(require_permission("space_management")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """移除工作空间成员（需要 space_management 权限）。"""
    result = await session.execute(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    if not membership:
        raise HTTPException(status_code=404, detail="成员不存在")

    await session.delete(membership)
    await session.commit()
    return {"status": "success", "message": "成员已移除"}


@router.post("/{workspace_id}/invite")
async def invite_workspace_member(
    workspace_id: str,
    body: InviteWorkspaceMemberRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """邀请成员加入工作空间，并自动将其加入该工作空间下所有频道。
    需要调用者是 system_admin、space_admin，或该工作空间的 owner/admin。
    """
    # 验证工作空间存在
    ws = (await session.execute(
        select(Workspace).where(Workspace.workspace_id == workspace_id)
    )).scalar_one_or_none()
    if not ws:
        raise HTTPException(status_code=404, detail="工作空间不存在")

    # 权限检查：system_admin/space_admin 或工作空间 owner/admin
    if current_user.role not in ("system_admin", "space_admin"):
        caller_membership = (await session.execute(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == workspace_id,
                WorkspaceMembership.user_id == current_user.user_id,
            )
        )).scalar_one_or_none()
        if not caller_membership or caller_membership.role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail="权限不足，仅工作空间管理员可邀请成员")

    # 查找被邀请用户（支持 username 或 user_id）
    target_user = (await session.execute(
        select(User).where(
            or_(User.user_id == body.identifier, User.username == body.identifier)
        )
    )).scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 检查是否已是工作空间成员
    existing = (await session.execute(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.user_id == target_user.user_id,
        )
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="用户已是工作空间成员")

    # 加入工作空间
    session.add(WorkspaceMembership(
        workspace_id=workspace_id,
        user_id=target_user.user_id,
        role=body.role,
    ))

    # 获取该工作空间所有频道
    channels_result = await session.execute(
        select(Channel).where(Channel.workspace_id == workspace_id)
    )
    channels = channels_result.scalars().all()

    # 将用户加入所有频道（跳过已在其中的）
    for ch in channels:
        already_in = (await session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == ch.channel_id,
                ChannelMembership.member_id == target_user.user_id,
            )
        )).scalar_one_or_none()
        if not already_in:
            session.add(ChannelMembership(
                channel_id=ch.channel_id,
                member_id=target_user.user_id,
                member_type="user",
                added_by=current_user.user_id,
            ))

    await session.commit()
    return {
        "status": "success",
        "message": f"已邀请 @{target_user.username} 加入工作空间及其下 {len(channels)} 个频道",
        "data": {
            "user_id": target_user.user_id,
            "username": target_user.username,
            "display_name": target_user.display_name,
            "channels_joined": len(channels),
        },
    }


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: str,
    _: User = Depends(get_current_user),
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
        result = await session.execute(
            select(Message).where(Message.channel_id == ch.channel_id)
        )
        for m in result.scalars().all():
            await session.delete(m)

        result = await session.execute(
            select(ChannelMembership).where(
                ChannelMembership.channel_id == ch.channel_id
            )
        )
        for m in result.scalars().all():
            await session.delete(m)

        await session.flush()
        await session.delete(ch)

    # 删除工作空间成员关系
    ws_members = await session.execute(
        select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == workspace_id)
    )
    for wm in ws_members.scalars().all():
        await session.delete(wm)

    await session.delete(ws)
    await session.commit()

    return {"status": "success", "message": "工作空间已删除"}
