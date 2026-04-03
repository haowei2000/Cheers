"""Friendship 数据访问层."""
from __future__ import annotations

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Friendship, User


class FriendshipRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_friendship(self, user_id1: str, user_id2: str) -> Friendship | None:
        result = await self.session.execute(
            select(Friendship).where(
                or_(
                    and_(Friendship.user_id == user_id1, Friendship.friend_id == user_id2),
                    and_(Friendship.user_id == user_id2, Friendship.friend_id == user_id1),
                )
            )
        )
        return result.scalar_one_or_none()

    async def list_friends(self, user_id: str) -> list[tuple[Friendship, User]]:
        result = await self.session.execute(
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
        return list(result.all())

    async def create(self, user_id: str, friend_id: str, status: str = "pending") -> Friendship:
        fs = Friendship(user_id=user_id, friend_id=friend_id, status=status)
        self.session.add(fs)
        await self.session.flush()
        return fs

    async def delete(self, friendship: Friendship) -> None:
        await self.session.delete(friendship)
        await self.session.flush()
