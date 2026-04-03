"""Friends v1 路由（好友管理）."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import BadRequestError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import Friendship, User

router = APIRouter(prefix="/friends", tags=["friends"])


class FriendAddBody(BaseModel):
    user_id: str
    friend_identifier: str


class FriendRemoveBody(BaseModel):
    user_id: str
    friend_id: str


@router.get("/search", response_model=APIResponse[list[dict]])
async def search_users(
    query: str = Query(..., min_length=1),
    current_user_id: str = Query(...),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(User).where(and_(User.user_id == query, User.user_id != current_user_id))
    )
    user = result.scalar_one_or_none()
    if not user:
        result = await session.execute(
            select(User).where(and_(User.username.ilike(f"%{query}%"), User.user_id != current_user_id))
        )
        users = result.scalars().all()
    else:
        users = [user]
    return APIResponse.ok([
        {"user_id": u.user_id, "username": u.username, "display_name": u.display_name, "avatar_url": u.avatar_url}
        for u in users
    ])


@router.get("/{user_id}", response_model=APIResponse[list[dict]])
async def get_friends(
    user_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(Friendship, User).join(
            User,
            or_(
                and_(Friendship.friend_id == User.user_id, Friendship.user_id == user_id),
                and_(Friendship.user_id == User.user_id, Friendship.friend_id == user_id),
            )
        ).where(
            or_(
                and_(Friendship.user_id == user_id, Friendship.status == "accepted"),
                and_(Friendship.friend_id == user_id, Friendship.status == "accepted"),
            )
        )
    )
    friends = [
        {
            "user_id": u.user_id,
            "username": u.username,
            "display_name": u.display_name,
            "avatar_url": u.avatar_url,
            "status": fs.status,
            "created_at": fs.created_at.isoformat() if fs.created_at else None,
        }
        for fs, u in result.all()
    ]
    return APIResponse.ok(friends)


@router.post("", response_model=APIResponse[dict])
async def add_friend(
    body: FriendAddBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    if body.user_id == body.friend_identifier:
        raise BadRequestError("不能添加自己为好友")
    result = await session.execute(
        select(User).where(or_(User.user_id == body.friend_identifier, User.username == body.friend_identifier))
    )
    target_user = result.scalar_one_or_none()
    if not target_user:
        raise NotFoundError("用户不存在")
    friend_id = target_user.user_id
    result = await session.execute(
        select(Friendship).where(
            or_(
                and_(Friendship.user_id == body.user_id, Friendship.friend_id == friend_id),
                and_(Friendship.user_id == friend_id, Friendship.friend_id == body.user_id),
            )
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        if existing.status == "accepted":
            raise BadRequestError("已经是好友")
        if existing.status == "pending":
            existing.status = "accepted"
            await session.flush()
            return APIResponse.ok(
                {"user_id": target_user.user_id, "username": target_user.username, "display_name": target_user.display_name, "avatar_url": target_user.avatar_url, "status": "accepted"},
                message="已接受好友请求",
            )
        raise BadRequestError("无法添加该用户")
    friendship = Friendship(user_id=body.user_id, friend_id=friend_id, status="accepted")
    session.add(friendship)
    await session.flush()
    return APIResponse.ok(
        {"user_id": target_user.user_id, "username": target_user.username, "display_name": target_user.display_name, "avatar_url": target_user.avatar_url, "status": "accepted"},
        message="添加好友成功",
    )


@router.delete("", response_model=APIResponse[None])
async def remove_friend(
    body: FriendRemoveBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(Friendship).where(
            or_(
                and_(Friendship.user_id == body.user_id, Friendship.friend_id == body.friend_id),
                and_(Friendship.user_id == body.friend_id, Friendship.friend_id == body.user_id),
            )
        )
    )
    friendship = result.scalar_one_or_none()
    if not friendship:
        raise NotFoundError("好友关系不存在")
    await session.delete(friendship)
    await session.flush()
    return APIResponse.ok(None, message="已删除好友")


@router.get("/check/{user_id}/{friend_id}", response_model=APIResponse[dict])
async def check_friendship(
    user_id: str,
    friend_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(Friendship).where(
            or_(
                and_(Friendship.user_id == user_id, Friendship.friend_id == friend_id),
                and_(Friendship.user_id == friend_id, Friendship.friend_id == user_id),
            )
        )
    )
    friendship = result.scalar_one_or_none()
    return APIResponse.ok({
        "is_friend": friendship is not None and friendship.status == "accepted",
        "status": friendship.status if friendship else None,
    })
