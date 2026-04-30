"""Friendship 数据访问层."""
from __future__ import annotations

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Friendship, User

FRIENDSHIP_STATUSES = {"pending", "accepted", "rejected", "blocked"}


def friendship_pair_key(user_id1: str, user_id2: str) -> str:
    left, right = sorted([user_id1, user_id2])
    return f"{left}:{right}"


class FriendshipRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_friendship(self, user_id1: str, user_id2: str) -> Friendship | None:
        return await self.get_by_pair(user_id1, user_id2)

    async def get_by_id(self, friendship_id: str) -> Friendship | None:
        result = await self.session.execute(
            select(Friendship).where(Friendship.friendship_id == friendship_id)
        )
        return result.scalar_one_or_none()

    async def get_by_pair(self, user_id1: str, user_id2: str) -> Friendship | None:
        result = await self.session.execute(
            select(Friendship).where(Friendship.pair_key == friendship_pair_key(user_id1, user_id2))
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

    async def list_requests(self, user_id: str, box: str) -> list[tuple[Friendship, User]]:
        """Return pending requests with the counterparty user.

        box="incoming": current user is receiver.
        box="outgoing": current user is requester.
        """
        if box == "incoming":
            condition = and_(Friendship.friend_id == user_id, Friendship.status == "pending")
            join_on = Friendship.user_id == User.user_id
        else:
            condition = and_(Friendship.user_id == user_id, Friendship.status == "pending")
            join_on = Friendship.friend_id == User.user_id
        result = await self.session.execute(
            select(Friendship, User)
            .join(User, join_on)
            .where(condition)
            .order_by(Friendship.updated_at.desc(), Friendship.created_at.desc())
        )
        return list(result.all())

    async def list_blocked(self, user_id: str) -> list[tuple[Friendship, User]]:
        result = await self.session.execute(
            select(Friendship, User)
            .join(User, Friendship.friend_id == User.user_id)
            .where(Friendship.user_id == user_id, Friendship.status == "blocked")
            .order_by(Friendship.updated_at.desc(), Friendship.created_at.desc())
        )
        return list(result.all())

    async def create(self, user_id: str, friend_id: str, status: str = "pending") -> Friendship:
        if status not in FRIENDSHIP_STATUSES:
            status = "pending"
        fs = Friendship(
            user_id=user_id,
            friend_id=friend_id,
            pair_key=friendship_pair_key(user_id, friend_id),
            status=status,
        )
        self.session.add(fs)
        await self.session.flush()
        return fs

    async def update(self, friendship: Friendship, **kwargs) -> Friendship:
        for key, value in kwargs.items():
            setattr(friendship, key, value)
        friendship.pair_key = friendship_pair_key(friendship.user_id, friendship.friend_id)
        self.session.add(friendship)
        await self.session.flush()
        return friendship

    async def delete(self, friendship: Friendship) -> None:
        await self.session.delete(friendship)
        await self.session.flush()
