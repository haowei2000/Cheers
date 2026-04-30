"""Shared permission helpers for model visibility and friendship checks."""
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Friendship, User
from app.repositories.friendship_repo import friendship_pair_key


def is_admin(user: User) -> bool:
    return user.role in ("system_admin", "space_admin")


async def get_friend_ids(session: AsyncSession, user_id: str) -> set[str]:
    """Return all accepted friend user_ids for the given user (bidirectional)."""
    result = await session.execute(
        select(Friendship).where(
            or_(
                Friendship.user_id == user_id,
                Friendship.friend_id == user_id,
            ),
            Friendship.status == "accepted",
        )
    )
    ids: set[str] = set()
    for f in result.scalars().all():
        if f.user_id == user_id:
            ids.add(f.friend_id)
        else:
            ids.add(f.user_id)
    return ids


async def get_friendship_between(session: AsyncSession, user_id1: str, user_id2: str) -> Friendship | None:
    result = await session.execute(
        select(Friendship).where(Friendship.pair_key == friendship_pair_key(user_id1, user_id2))
    )
    return result.scalar_one_or_none()


async def are_accepted_friends(session: AsyncSession, user_id1: str, user_id2: str) -> bool:
    friendship = await get_friendship_between(session, user_id1, user_id2)
    return bool(friendship and friendship.status == "accepted")


async def is_blocked_between(session: AsyncSession, user_id1: str, user_id2: str) -> bool:
    friendship = await get_friendship_between(session, user_id1, user_id2)
    return bool(friendship and friendship.status == "blocked")


async def can_access(
    session: AsyncSession,
    current_user: User,
    created_by: str | None,
    is_public: bool,
) -> bool:
    """Return True if current_user may read this model.

    Access rules:
    - Ownerless/system model: always
    - Creator: always
    - Others: never, even if legacy rows still have is_public=True
    """
    _ = session, is_public
    if created_by is None:
        return True
    if created_by == current_user.user_id:
        return True
    return False
