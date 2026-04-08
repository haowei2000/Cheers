"""Friendship 业务逻辑层."""
from __future__ import annotations

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestError, NotFoundError
from app.db.models import Friendship, User
from app.repositories.friendship_repo import FriendshipRepository
from app.repositories.user_repo import UserRepository


class FriendshipService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = FriendshipRepository(session)
        self.user_repo = UserRepository(session)

    async def search_users(self, query: str, current_user_id: str) -> list[User]:
        """搜索用户（按 ID 或用户名模糊匹配），排除当前用户."""
        # 1. 精确匹配 ID
        user = await self.user_repo.get_by_id(query)
        if user and user.user_id != current_user_id:
            return [user]
        
        # 2. 模糊匹配用户名
        result = await self.session.execute(
            select(User).where(
                and_(User.username.ilike(f"%{query}%"), User.user_id != current_user_id)
            )
        )
        return list(result.scalars().all())

    async def list_friends(self, user_id: str) -> list[dict]:
        """获取用户的好友列表及状态."""
        friends_data = await self.repo.list_friends(user_id)
        return [
            {
                "user_id": u.user_id,
                "username": u.username,
                "display_name": u.display_name,
                "avatar_url": u.avatar_url,
                "status": fs.status,
                "created_at": fs.created_at.isoformat() if fs.created_at else None,
            }
            for fs, u in friends_data
        ]

    async def add_friend(self, user_id: str, friend_identifier: str) -> dict:
        """添加好友（支持 ID 或用户名），包含状态机逻辑."""
        if user_id == friend_identifier:
            raise BadRequestError("不能添加自己为好友")

        # 查找目标用户
        target_user = await self.user_repo.get_by_id(friend_identifier)
        if not target_user:
            target_user = await self.user_repo.get_by_username(friend_identifier)
        
        if not target_user:
            raise NotFoundError("用户不存在")
        
        friend_id = target_user.user_id
        if user_id == friend_id:
            raise BadRequestError("不能添加自己为好友")

        existing = await self.repo.get_friendship(user_id, friend_id)
        if existing:
            if existing.status == "accepted":
                raise BadRequestError("已经是好友")
            if existing.status == "pending":
                # 如果已有待处理请求，直接升级为 accepted (状态机简化)
                existing.status = "accepted"
                await self.session.flush()
                return {
                    "user_id": target_user.user_id,
                    "username": target_user.username,
                    "display_name": target_user.display_name,
                    "avatar_url": target_user.avatar_url,
                    "status": "accepted",
                    "action": "accepted_existing"
                }
            raise BadRequestError("无法添加该用户")

        # 创建新关系（当前逻辑直接 accepted，也可改为 pending）
        await self.repo.create(user_id, friend_id, status="accepted")
        return {
            "user_id": target_user.user_id,
            "username": target_user.username,
            "display_name": target_user.display_name,
            "avatar_url": target_user.avatar_url,
            "status": "accepted",
            "action": "created_new"
        }

    async def remove_friend(self, user_id: str, friend_id: str) -> None:
        """删除好友关系."""
        friendship = await self.repo.get_friendship(user_id, friend_id)
        if not friendship:
            raise NotFoundError("好友关系不存在")
        await self.repo.delete(friendship)

    async def check_friendship(self, user_id: str, friend_id: str) -> dict:
        """检查两个用户之间的好友状态."""
        friendship = await self.repo.get_friendship(user_id, friend_id)
        return {
            "is_friend": friendship is not None and friendship.status == "accepted",
            "status": friendship.status if friendship else None,
        }
