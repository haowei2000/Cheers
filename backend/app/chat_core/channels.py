"""频道与成员 REST 路由."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    ChannelCreate,
    ChannelInResponse,
    MemberAdd,
    MemberInResponse,
)
from app.db.models import BotAccount, Channel, ChannelMembership, User, Workspace, WorkspaceMembership
from app.db.session import get_session
from app.auth.routes import get_current_user, try_get_current_user
from app.guide.constants import GUIDE_BOT_ID
from app.utils.permissions import is_admin

router = APIRouter(prefix="/api/channels", tags=["channels"])


class MemberInviteRequest(BaseModel):
    """邀请成员请求（支持通过用户ID或用户名）."""
    identifier: str  # 用户ID 或 用户名


class MemberInviteByFriendRequest(BaseModel):
    """通过好友关系邀请成员."""
    friend_id: str  # 好友用户ID


@router.get("")
async def list_channels(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取频道列表：system_admin 见全部，其他用户只见已加入的频道。"""
    if current_user.role == "system_admin":
        result = await session.execute(select(Channel).order_by(Channel.created_at))
        channels = result.scalars().all()
    else:
        result = await session.execute(
            select(Channel)
            .join(ChannelMembership, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
            )
            .order_by(Channel.created_at)
        )
        channels = result.scalars().all()
    return {
        "status": "success",
        "data": [ChannelInResponse.model_validate(c).model_dump() for c in channels],
    }


@router.get("/by-workspace/{workspace_id}")
async def list_channels_by_workspace(
    workspace_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取指定工作空间的频道列表（仅返回当前用户已加入的频道，管理员可见全部）."""
    if is_admin(current_user):
        result = await session.execute(
            select(Channel).where(Channel.workspace_id == workspace_id).order_by(Channel.created_at)
        )
        channels = result.scalars().all()
    else:
        result = await session.execute(
            select(Channel)
            .join(ChannelMembership, Channel.channel_id == ChannelMembership.channel_id)
            .where(
                Channel.workspace_id == workspace_id,
                ChannelMembership.member_id == current_user.user_id,
                ChannelMembership.member_type == "user",
            )
            .order_by(Channel.created_at)
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
    current_user: User | None = Depends(try_get_current_user),
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
    # 自动将内置统一 Bot（@引导）加入新项目
    for builtin_bot_id in (GUIDE_BOT_ID,):
        r = await session.execute(
            select(BotAccount).where(BotAccount.bot_id == builtin_bot_id)
        )
        if r.scalar_one_or_none():
            session.add(
                ChannelMembership(
                    channel_id=ch.channel_id,
                    member_id=builtin_bot_id,
                    member_type="bot",
                )
            )
    # 自动将工作空间所有成员加入新频道
    ws_members_result = await session.execute(
        select(WorkspaceMembership).where(WorkspaceMembership.workspace_id == body.workspace_id)
    )
    existing_member_ids = set()
    for wm in ws_members_result.scalars().all():
        session.add(
            ChannelMembership(
                channel_id=ch.channel_id,
                member_id=wm.user_id,
                member_type="user",
            )
        )
        existing_member_ids.add(wm.user_id)

    # 若创建者不在工作空间成员列表中（如未登录场景）则单独加入
    if current_user and current_user.user_id not in existing_member_ids:
        session.add(
            ChannelMembership(
                channel_id=ch.channel_id,
                member_id=current_user.user_id,
                member_type="user",
            )
        )
    await session.flush()
    return {"status": "success", "data": ChannelInResponse.model_validate(ch).model_dump()}


class ChannelPatch(BaseModel):
    """频道属性更新."""
    auto_assist: bool | None = None


@router.patch("/{channel_id}")
async def patch_channel(
    channel_id: str,
    body: ChannelPatch,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新频道属性（如 auto_assist 开关）."""
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="channel not found")
    if body.auto_assist is not None:
        ch.auto_assist = body.auto_assist
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
            if not bot:
                continue
            username = bot.username
            avatar_url = bot.avatar_url
            display_name = bot.display_name
        elif m.member_type == "user":
            r = await session.execute(
                select(User).where(User.user_id == m.member_id)
            )
            user = r.scalar_one_or_none()
            if not user:
                continue
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


async def _require_channel_member(channel_id: str, current_user: User, session: AsyncSession) -> None:
    """Raise 403 if current_user is not a member of the channel (admins bypass)."""
    if is_admin(current_user):
        return
    r = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id == current_user.user_id,
            ChannelMembership.member_type == "user",
        )
    )
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=403, detail="您不是该频道的成员")


@router.post("/{channel_id}/members")
async def add_member(
    channel_id: str,
    body: MemberAdd,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """添加频道成员。

    规则：
    - 操作者须为频道成员（或管理员）
    - 添加 bot 时：只能添加自己创建的 Bot 或系统内置 Bot（管理员除外）
    - 添加 user 时：需为好友关系（管理员除外）
    """
    result = await session.execute(select(Channel).where(Channel.channel_id == channel_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="channel not found")

    await _require_channel_member(channel_id, current_user, session)

    if body.member_type == "bot" and not is_admin(current_user):
        bot_result = await session.execute(
            select(BotAccount).where(BotAccount.bot_id == body.member_id)
        )
        bot = bot_result.scalar_one_or_none()
        if not bot:
            raise HTTPException(status_code=404, detail="Bot 不存在")
        
        # 允许添加内置 Bot (GUIDE_BOT_ID) 或自己创建的 Bot
        if bot.bot_id != GUIDE_BOT_ID and bot.created_by != current_user.user_id:
            raise HTTPException(status_code=403, detail="只能将内置助手或自己创建的 Bot 添加到频道")

    m = ChannelMembership(
        channel_id=channel_id,
        member_id=body.member_id,
        member_type=body.member_type,
        added_by=current_user.user_id,
    )
    session.add(m)
    await session.flush()
    return {"status": "success", "data": MemberInResponse.model_validate(m).model_dump()}


@router.delete("/{channel_id}/members/{member_id}")
async def remove_member(
    channel_id: str,
    member_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """移除频道成员。

    规则：
    - 移除自己：任意频道成员均可
    - 移除内置 Bot：仅管理员
    - 移除自己的 Bot：Bot 创建者可以操作
    - 移除其他用户/Bot：仅管理员
    """
    result = await session.execute(
        select(ChannelMembership).where(
            ChannelMembership.channel_id == channel_id,
            ChannelMembership.member_id == member_id,
        )
    )
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="membership not found")

    if not is_admin(current_user):
        # 即使是内置助手，普通用户也禁止移除
        if member_id == GUIDE_BOT_ID:
            raise HTTPException(status_code=403, detail="内置助手只能由管理员移除")

        if m.member_type == "user" and member_id != current_user.user_id:
            raise HTTPException(status_code=403, detail="只能移除自己")
        if m.member_type == "bot":
            bot_result = await session.execute(
                select(BotAccount).where(BotAccount.bot_id == member_id)
            )
            bot = bot_result.scalar_one_or_none()
            if not bot or bot.created_by != current_user.user_id:
                raise HTTPException(status_code=403, detail="只能移除自己创建的 Bot")

    await session.delete(m)
    await session.flush()
    return {"status": "success"}


@router.post("/{channel_id}/invite")
async def invite_member_by_identifier(
    channel_id: str,
    body: MemberInviteRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """通过用户ID或用户名邀请用户加入频道（邀请者须为频道成员）."""
    result = await session.execute(
        select(Channel).where(Channel.channel_id == channel_id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="频道不存在")

    await _require_channel_member(channel_id, current_user, session)

    result = await session.execute(
        select(User).where(
            or_(
                User.user_id == body.identifier,
                User.username == body.identifier
            )
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    result = await session.execute(
        select(ChannelMembership).where(
            and_(
                ChannelMembership.channel_id == channel_id,
                ChannelMembership.member_id == user.user_id
            )
        )
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="用户已在频道中")

    membership = ChannelMembership(
        channel_id=channel_id,
        member_id=user.user_id,
        member_type="user",
        added_by=current_user.user_id,
    )
    session.add(membership)
    await session.flush()

    return {
        "status": "success",
        "message": f"已邀请 @{user.username} 加入频道",
        "data": {
            "user_id": user.user_id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
        },
    }


@router.get("/{channel_id}/friends-to-invite")
async def get_friends_to_invite(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取可以邀请加入频道的好友列表（排除已在频道中的）."""
    from app.db.models import Friendship

    user_id = current_user.user_id

    result = await session.execute(
        select(ChannelMembership.member_id).where(
            ChannelMembership.channel_id == channel_id
        )
    )
    member_ids = {row[0] for row in result.all()}

    result = await session.execute(
        select(Friendship, User).join(
            User,
            or_(
                and_(Friendship.friend_id == User.user_id, Friendship.user_id == user_id),
                and_(Friendship.user_id == User.user_id, Friendship.friend_id == user_id)
            )
        ).where(
            and_(
                or_(
                    and_(Friendship.user_id == user_id, Friendship.status == "accepted"),
                    and_(Friendship.friend_id == user_id, Friendship.status == "accepted")
                ),
                User.user_id.notin_(member_ids) if member_ids else True
            )
        )
    )

    friends = []
    for friendship, user in result.all():
        friends.append({
            "user_id": user.user_id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
        })

    return {
        "status": "success",
        "data": friends,
    }


class ChannelProfileUpdate(BaseModel):
    """频道内个性资料更新."""
    nickname: Optional[str] = None
    bio: Optional[str] = None


@router.get("/{channel_id}/my-profile")
async def get_my_channel_profile(
    channel_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取当前用户在指定频道的个性化资料."""
    from app.db.models import ChannelProfile
    result = await session.execute(
        select(ChannelProfile).where(
            ChannelProfile.channel_id == channel_id,
            ChannelProfile.user_id == current_user.user_id,
        )
    )
    profile = result.scalar_one_or_none()
    return {
        "status": "success",
        "data": {
            "channel_id": channel_id,
            "user_id": current_user.user_id,
            "nickname": profile.nickname if profile else None,
            "bio": profile.bio if profile else None,
        },
    }


@router.put("/{channel_id}/my-profile")
async def update_my_channel_profile(
    channel_id: str,
    body: ChannelProfileUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新当前用户在指定频道的个性化资料（昵称、简介）."""
    from app.db.models import ChannelProfile
    result = await session.execute(
        select(ChannelProfile).where(
            ChannelProfile.channel_id == channel_id,
            ChannelProfile.user_id == current_user.user_id,
        )
    )
    profile = result.scalar_one_or_none()
    if not profile:
        profile = ChannelProfile(
            channel_id=channel_id,
            user_id=current_user.user_id,
        )
        session.add(profile)
    if body.nickname is not None:
        profile.nickname = body.nickname or None
    if body.bio is not None:
        profile.bio = body.bio or None
    await session.flush()
    return {
        "status": "success",
        "data": {
            "channel_id": channel_id,
            "user_id": current_user.user_id,
            "nickname": profile.nickname,
            "bio": profile.bio,
        },
    }


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
