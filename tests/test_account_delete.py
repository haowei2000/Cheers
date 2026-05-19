"""Account deactivation tests."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import EmailCode, Friendship, KeychainItem, User

TEST_USER_ID = "a0000000-0000-0000-0000-000000000099"


@pytest.mark.asyncio
async def test_delete_current_account_deactivates_user_and_cleans_private_data(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    user = await db_session.get(User, TEST_USER_ID)
    assert user is not None
    user.email = "delete-me@example.com"
    user.bio = "private bio"
    user.avatar_url = "https://example.com/avatar.png"
    friend = User(
        user_id="account-delete-friend-001",
        username="account_delete_friend",
        password_hash="x",
        display_name="Friend",
        role="member",
    )
    db_session.add_all(
        [
            user,
            friend,
            EmailCode(
                email=user.email,
                code="123456",
                purpose="change_password",
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            ),
            KeychainItem(
                key_id="account-delete-key-001",
                owner_id=user.user_id,
                name="secret",
                value="encrypted",
            ),
            Friendship(
                friendship_id="account-delete-friendship-001",
                user_id=user.user_id,
                friend_id=friend.user_id,
                status="accepted",
            ),
        ]
    )
    await db_session.flush()

    resp = await client.delete("/api/v1/auth/users/me")

    assert resp.status_code == 200
    row = await db_session.get(User, TEST_USER_ID)
    assert row is not None
    assert row.is_deleted is True
    assert row.deleted_at is not None
    assert row.username.startswith("deleted-a0000000-")
    assert row.email is None
    assert row.bio is None
    assert row.avatar_url is None
    assert row.display_name == "Deleted user"
    assert await db_session.scalar(
        select(KeychainItem).where(KeychainItem.owner_id == TEST_USER_ID)
    ) is None
    assert await db_session.scalar(
        select(Friendship).where(Friendship.friendship_id == "account-delete-friendship-001")
    ) is None
    assert await db_session.scalar(
        select(EmailCode).where(EmailCode.email == "delete-me@example.com")
    ) is None
