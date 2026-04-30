"""User profile avatar API."""
from __future__ import annotations

import pytest
from httpx import AsyncClient


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
