"""频道与成员 REST 路由."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    ChannelCreate,
    ChannelInResponse,
    MemberAdd,
    MemberInResponse,
)
from app.db.models import BotAccount, Channel, ChannelMembership, Workspace
from app.db.session import get_session
from app.guide.constants import GUIDE_BOT_ID

router = APIRouter(prefix="/api/channels", tags=["channels"])


@router.get("")
async def list_channels(session: AsyncSession = Depends(get_session)) -> dict:
    """获取频道列表."""
    result = await session.execute(select(Channel).order_by(Channel.created_at))
    channels = result.scalars().all()
    return {
        "status": "success",
        "data": [ChannelInResponse.model_validate(c).model_dump() for c in channels],
    }


@router.get("/by-workspace/{workspace_id}")
async def list_channels_by_workspace(
    workspace_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取指定工作空间的所有频道."""
    result = await session.execute(
        select(Channel).where(Channel.workspace_id == workspace_id).order_by(Channel.created_at)
    )
    channels = result.scalars().all()
    return {
        "status": "success",
        "data": [ChannelInResponse.model_validate(c).model_dump() for c in channels],
    }


@router.post("")
async def create_channel(
    body: ChannelCreate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建频道."""
    result = await session.execute(select(Workspace).where(Workspace.workspace_id == body.workspace_id))
    ws = result.scalar_one_or_none()
    if not ws:
        raise HTTPException(status_code=404, detail="workspace not found")
    ch = Channel(
        workspace_id=body.workspace_id,
        name=body.name,
        type=body.type,
        purpose=body.purpose,
    )
    session.add(ch)
    await session.flush()
    # 自动将引导 Bot 加入新项目，使所有项目内都能 @引导
    r = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == GUIDE_BOT_ID)
    )
    if r.scalar_one_or_none():
        session.add(
            ChannelMembership(
                channel_id=ch.channel_id,
                member_id=GUIDE_BOT_ID,
                member_type="bot",
            )
        )
        await session.flush()
    return {"status": "success", "data": ChannelInResponse.model_validate(ch).model_dump()}


@router.get("/{channel_id}/members")
async def list_members(
    channel_id: str,
    with_username: bool = False,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取频道成员列表。with_username=true 时返回 Bot 的 username 供 @ 选择用。"""
    result = await session.execute(
        select(ChannelMembership).where(ChannelMembership.channel_id == channel_id)
    )
    members = result.scalars().all()
    if not with_username:
        return {
            "status": "success",
            "data": [MemberInResponse.model_validate(m).model_dump() for m in members],
        }
    from app.db.models import User
    out = []
    for m in members:
        username = None
        avatar_url = None
        display_name = None
        if m.member_type == "bot":
            r = await session.execute(
                select(BotAccount).where(BotAccount.bot_id == m.member_id)
            )
            bot = r.scalar_one_or_none()
            if bot:
                username = bot.username
                avatar_url = bot.avatar_url
                display_name = bot.display_name
        elif m.member_type == "user":
            r = await session.execute(
                select(User).where(User.user_id == m.member_id)
            )
            user = r.scalar_one_or_none()
            if user:
                username = user.username
                avatar_url = user.avatar_url
                display_name = user.display_name
        out.append({
            "channel_id": m.channel_id,
            "member_id": m.member_id,
            "member_type": m.member_type,
            "username": username,
            "avatar_url": avatar_url,
            "display_name": display_name,
        })
    return {"status": "success", "data": out}


@router.post("/{channel_id}/members")
async def add_member(
    channel_id: str,
    body: MemberAdd,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """添加频道成员."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")
    m = ChannelMembership(
        channel_id=channel_id,
        member_id=body.member_id,
        member_type=body.member_type,
    )
    session.add(m)
    await session.flush()
    return {"status": "success", "data": MemberInResponse.model_validate(m).model_dump()}


@router.delete("/{channel_id}/members/{member_id}")
async def remove_member(
    channel_id: str,
    member_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """移除频道成员."""
    result = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id == member_id,
        )
    )
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="membership not found")
    await session.delete(m)
    await session.flush()
    return {"status": "success"}


@router.delete("/{channel_id}")
async def delete_channel(
    channel_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除频道（同时删除关联的成员、消息、文件记录）."""
    result = await session.execute(
        select(Channel).where(Channel.channel_id == channel_id)
    )
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="channel not found")

    # 删除关联的成员记录
    result = await session.execute(
        select(ChannelMembership).where(ChannelMembership.channel_id == channel_id)
    )
    memberships = result.scalars().all()
    for m in memberships:
        await session.delete(m)

    # 删除关联的消息记录
    from app.db.models import Message
    result = await session.execute(
        select(Message).where(Message.channel_id == channel_id)
    )
    messages = result.scalars().all()
    for msg in messages:
        await session.delete(msg)

    # 删除关联的文件记录
    from app.db.models import FileRecord
    result = await session.execute(
        select(FileRecord).where(FileRecord.channel_id == channel_id)
    )
    file_records = result.scalars().all()
    for f in file_records:
        await session.delete(f)

    # 删除频道
    await session.delete(ch)
    await session.commit()
    return {"status": "success", "message": "频道已删除"}
