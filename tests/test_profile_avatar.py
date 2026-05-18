"""User profile avatar API."""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.api.v1.auth.routes import UserOut
from app.config import settings
from app.db.models import User


def test_default_admin_display_name_is_localized_for_legacy_seed_values() -> None:
    user = User(
        user_id="admin-locale-test",
        username=settings.admin_username,
        password_hash="x",
        display_name="系统管理员",
        role="system_admin",
    )

    assert UserOut.from_user(user, "en").display_name == "System Administrator"
    assert UserOut.from_user(user, "zh-CN").display_name == "系统管理员"


def test_custom_admin_display_name_is_not_localized() -> None:
    user = User(
        user_id="admin-custom-name-test",
        username=settings.admin_username,
        password_hash="x",
        display_name="Ops Admin",
        role="system_admin",
    )

    assert UserOut.from_user(user, "en").display_name == "Ops Admin"
    assert UserOut.from_user(user, "zh-CN").display_name == "Ops Admin"


@pytest.mark.asyncio
async def test_user_can_set_and_clear_own_avatar(client: AsyncClient) -> None:
    set_resp = await client.put(
        "/api/v1/auth/users/me",
        json={
            "display_name": "Test Admin",
            "avatar_url": "https://cdn.example.test/me.png",
        },
    )

    assert set_resp.status_code == 200
    assert set_resp.json()["data"]["avatar_url"] == "https://cdn.example.test/me.png"

    clear_resp = await client.put(
        "/api/v1/auth/users/me",
        json={"avatar_url": None},
    )

    assert clear_resp.status_code == 200
    assert clear_resp.json()["data"]["avatar_url"] is None
