"""Integration coverage for bot-created files in the personal file library."""
from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

BASE_URL = (os.getenv("INTEGRATION_BASE_URL") or "").rstrip("/")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not BASE_URL,
        reason="set INTEGRATION_BASE_URL to a running AgentNexus backend",
    ),
]


def _env_value(name: str) -> str | None:
    value = os.getenv(name)
    if value:
        return value
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw = stripped.split("=", 1)
        if key.strip() == name:
            return raw.strip().strip("\"'")
    return None


async def _api(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    token: str | None = None,
    bot_token: str | None = None,
    **kwargs,
) -> dict:
    headers = dict(kwargs.pop("headers", {}) or {})
    bearer = token or bot_token
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    response = await client.request(method, path, headers=headers, **kwargs)
    response.raise_for_status()
    payload = response.json()
    assert payload["status"] == "success"
    return payload["data"]


@pytest.mark.asyncio
async def test_bot_uploaded_file_appears_in_user_personal_library() -> None:
    admin_password = _env_value("INTEGRATION_ADMIN_PASSWORD") or _env_value("ADMIN_PASSWORD")
    if not admin_password:
        pytest.skip("set INTEGRATION_ADMIN_PASSWORD or ADMIN_PASSWORD")
    admin_username = _env_value("INTEGRATION_ADMIN_USERNAME") or "admin"

    bot_id: str | None = None
    file_id: str | None = None
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30) as client:
        login = await _api(
            client,
            "POST",
            "/api/v1/auth/login",
            json={
                "username": admin_username,
                "password": admin_password,
            },
        )
        user_token = login["access_token"]

        try:
            bot = await _api(
                client,
                "POST",
                "/api/v1/bots",
                token=user_token,
                json={
                    "username": f"bridge-file-{uuid4().hex[:8]}",
                    "display_name": "Bridge File Check",
                    "binding_type": "agent_bridge",
                    "binding_config": {"agent_id": "integration-file-library-check"},
                    "status": "online",
                    "scope": "private",
                },
            )
            bot_id = bot["bot_id"]
            bot_token = bot["bot_token"]

            dm = await _api(
                client,
                "POST",
                "/api/v1/dms",
                token=user_token,
                json={
                    "workspace_id": "ignored-by-dm-route",
                    "member_id": bot_id,
                    "member_type": "bot",
                    "create_new": True,
                    "chat_title": "File library check",
                },
            )
            channel_id = dm["channel_id"]

            filename = f"bot-returned-{uuid4().hex[:6]}.txt"
            uploaded = await _api(
                client,
                "POST",
                "/api/v1/agent-bridge/files/upload-binary",
                bot_token=bot_token,
                headers={
                    "X-Channel-Id": channel_id,
                    "X-Filename": filename,
                    "Content-Type": "text/plain",
                },
                content=b"bot generated file visible in personal library",
            )
            file_id = uploaded["file_id"]

            library = await _api(client, "GET", "/api/v1/files/library", token=user_token)
            match = next((item for item in library if item["file_id"] == file_id), None)
            assert match is not None
            assert match["scope_type"] == "personal"
            assert match["channel_id"] == channel_id
            assert match["original_filename"] == filename

            channel_files = await _api(
                client,
                "GET",
                f"/api/v1/files/by-channel/{channel_id}",
                token=user_token,
            )
            assert file_id in {item["file_id"] for item in channel_files}
        finally:
            if file_id:
                await client.delete(
                    f"/api/v1/files/{file_id}",
                    headers={"Authorization": f"Bearer {user_token}"},
                )
            if bot_id:
                await client.delete(
                    f"/api/v1/bots/{bot_id}",
                    headers={"Authorization": f"Bearer {user_token}"},
                )
