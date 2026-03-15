"""好友管理 API 路由."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Friendship, User
from app.db.session import get_session

router = APIRouter(prefix="/api/friends", tags=["friends"])


# ============ Schemas ============


class FriendAddRequest(BaseModel):
    """添加好友请求."""
    user_id: str  # 当前用户ID
    friend_identifier: str  # 用户ID 或 用户名


class FriendRemoveRequest(BaseModel):
    """删除好友请求."""
    user_id: str  # 当前用户ID
    friend_id: str  # 好友用户ID


class FriendInfo(BaseModel):
    """好友信息响应."""
    user_id: str
    username: str
    display_name: str | None = None
    avatar_url: str | None = None
    status: str
    created_at: str | None = None


class UserSearchResult(BaseModel):
    """用户搜索结果."""
    user_id: str
    username: str
    display_name: str | None = None
    avatar_url: str | None = None


# ============ Routes ============


@router.get("/search")
async def search_users(
    query: str = Query(..., min_length=1, description="搜索关键词（用户名或用户ID）"),
    current_user_id: str = Query(..., description="当前用户ID，用于排除自己"),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """搜索用户（通过用户名或ID），排除自己."""
    # 首先尝试通过 ID 精确查找
    result = await session.execute(
        select(User).where(
            and_(
                User.user_id == query,
                User.user_id != current_user_id
            )
        )
    )
    user = result.scalar_one_or_none()
    
    # 如果找不到，通过用户名模糊查找
    if not user:
        result = await session.execute(
            select(User).where(
                and_(
                    User.username.ilike(f"%{query}%"),
                    User.user_id != current_user_id
                )
            )
        )
        users = result.scalars().all()
    else:
        users = [user]
    
    return {
        "status": "success",
        "data": [
            UserSearchResult(
                user_id=u.user_id,
                username=u.username,
                display_name=u.display_name,
                avatar_url=u.avatar_url,
            ).model_dump()
            for u in users
        ],
    }


@router.get("/{user_id}")
async def get_friends(
    user_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取用户的好友列表."""
    # 查询双向好友关系
    result = await session.execute(
        select(Friendship, User).join(
            User,
            or_(
                and_(Friendship.friend_id == User.user_id, Friendship.user_id == user_id),
                and_(Friendship.user_id == User.user_id, Friendship.friend_id == user_id)
            )
        ).where(
            or_(
                and_(Friendship.user_id == user_id, Friendship.status == "accepted"),
                and_(Friendship.friend_id == user_id, Friendship.status == "accepted")
            )
        )
    )
    
    friends = []
    for friendship, user in result.all():
        friends.append(
            FriendInfo(
                user_id=user.user_id,
                username=user.username,
                display_name=user.display_name,
                avatar_url=user.avatar_url,
                status=friendship.status,
                created_at=friendship.created_at.isoformat() if friendship.created_at else None,
            ).model_dump()
        )
    
    return {
        "status": "success",
        "data": friends,
    }


@router.post("")
async def add_friend(
    body: FriendAddRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """添加好友（通过用户ID或用户名）."""
    # 不能添加自己
    if body.user_id == body.friend_identifier:
        raise HTTPException(status_code=400, detail="不能添加自己为好友")
    
    # 查找目标用户
    result = await session.execute(
        select(User).where(
            or_(
                User.user_id == body.friend_identifier,
                User.username == body.friend_identifier
            )
        )
    )
    target_user = result.scalar_one_or_none()
    
    if not target_user:
        raise HTTPException(status_code=404, detail="用户不存在")
    
    friend_id = target_user.user_id
    
    # 检查是否已经是好友
    result = await session.execute(
        select(Friendship).where(
            or_(
                and_(Friendship.user_id == body.user_id, Friendship.friend_id == friend_id),
                and_(Friendship.user_id == friend_id, Friendship.friend_id == body.user_id)
            )
        )
    )
    existing = result.scalar_one_or_none()
    
    if existing:
        if existing.status == "accepted":
            raise HTTPException(status_code=400, detail="已经是好友")
        elif existing.status == "pending":
            # 接受好友请求
            existing.status = "accepted"
            await session.flush()
            return {
                "status": "success",
                "message": "已接受好友请求",
                "data": FriendInfo(
                    user_id=target_user.user_id,
                    username=target_user.username,
                    display_name=target_user.display_name,
                    avatar_url=target_user.avatar_url,
                    status="accepted",
                ).model_dump(),
            }
        else:
            raise HTTPException(status_code=400, detail="无法添加该用户")
    
    # 创建新的好友关系
    friendship = Friendship(
        user_id=body.user_id,
        friend_id=friend_id,
        status="accepted",
    )
    session.add(friendship)
    await session.flush()
    
    return {
        "status": "success",
        "message": "添加好友成功",
        "data": FriendInfo(
            user_id=target_user.user_id,
            username=target_user.username,
            display_name=target_user.display_name,
            avatar_url=target_user.avatar_url,
            status="accepted",
        ).model_dump(),
    }


@router.delete("")
async def remove_friend(
    body: FriendRemoveRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除好友."""
    result = await session.execute(
        select(Friendship).where(
            or_(
                and_(Friendship.user_id == body.user_id, Friendship.friend_id == body.friend_id),
                and_(Friendship.user_id == body.friend_id, Friendship.friend_id == body.user_id)
            )
        )
    )
    friendship = result.scalar_one_or_none()
    
    if not friendship:
        raise HTTPException(status_code=404, detail="好友关系不存在")
    
    await session.delete(friendship)
    await session.flush()
    
    return {"status": "success", "message": "已删除好友"}


@router.get("/check/{user_id}/{friend_id}")
async def check_friendship(
    user_id: str,
    friend_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """检查两个用户是否为好友."""
    result = await session.execute(
        select(Friendship).where(
            or_(
                and_(Friendship.user_id == user_id, Friendship.friend_id == friend_id),
                and_(Friendship.user_id == friend_id, Friendship.friend_id == user_id)
            )
        )
    )
    friendship = result.scalar_one_or_none()
    
    return {
        "status": "success",
        "data": {
            "is_friend": friendship is not None and friendship.status == "accepted",
            "status": friendship.status if friendship else None,
        },
    }
