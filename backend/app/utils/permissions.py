"""Shared permission helpers for bot/model visibility and friendship checks."""
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Friendship, User


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


async def can_access(
    session: AsyncSession,
    current_user: User,
    created_by: str | None,
    is_public: bool,
) -> bool:
    """Return True if current_user may read this bot/model.

    Access rules:
    - Admin: always
    - Creator: always
    - Others: only if is_public AND the creator is an accepted friend
    """
    if is_admin(current_user):
        return True
    if created_by == current_user.user_id:
        return True
    if is_public and created_by:
        friend_ids = await get_friend_ids(session, current_user.user_id)
        return created_by in friend_ids
    return False
