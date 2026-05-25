"""End-to-end integration tests for OpenClaw WS protocol, dispatch, and file replies.

Test strategy:
  - Create one isolated temporary agent bridge bot for each test session and
    delete it afterward.
  - Do not touch production bot tokens, which avoids disrupting live plugin
    connections.
  - Add the temporary bot to the cafe channel, then remove and delete it after
    tests finish.

Prerequisites:
  - Docker backend is running at http://localhost:8000.
  - The admin account and cafe channel (ba30fc1a-...) exist.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import uuid
from urllib.parse import urlparse

import httpx
import pytest
import pytest_asyncio
import websockets

BASE = os.getenv("TEST_BASE_URL")
DEFAULT_BASE = "http://localhost:8000"
E2E_BASE = BASE or DEFAULT_BASE
WS_BASE = E2E_BASE.replace("http://", "ws://").replace("https://", "wss://")


def _backend_reachable(url: str, timeout: float = 0.5) -> bool:
    """Fast TCP probe used to skip this E2E module when CI has no live backend."""
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not BASE or not _backend_reachable(E2E_BASE),
    reason=(
        "Agent Bridge live E2E is disabled unless TEST_BASE_URL points to a live server "
        f"(default hint: {DEFAULT_BASE})"
    ),
)

CHANNEL_ID = "ba30fc1a-8324-4a30-86fe-102214114ea0"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _login(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "change-me-admin-password"},
    )
    resp.raise_for_status()
    return resp.json()["data"]["access_token"]


async def _create_test_bot(client: httpx.AsyncClient, jwt: str) -> tuple[str, str, str]:
    """Create a temporary agent bridge bot and return (bot_id, username, bot_token)."""
    name = f"e2e-tmp-{uuid.uuid4().hex[:8]}"
    resp = await client.post(
        "/api/v1/bots",
        json={
            "username": name,
            "display_name": name,
            "binding_type": "agent_bridge",
            "binding_config": {"agent_id": "test"},
            "status": "online",
        },
        headers={"Authorization": f"Bearer {jwt}"},
    )
    resp.raise_for_status()
    bot_id = resp.json()["data"]["bot_id"]

    # Rotate once to obtain the plaintext token.
    r2 = await client.post(
        f"/api/v1/bots/{bot_id}/rotate-token",
        headers={"Authorization": f"Bearer {jwt}"},
    )
    r2.raise_for_status()
    bot_token = r2.json()["data"]["bot_token"]
    return bot_id, name, bot_token


async def _add_bot_to_channel(client: httpx.AsyncClient, jwt: str, bot_id: str) -> None:
    resp = await client.post(
        f"/api/v1/channels/{CHANNEL_ID}/members",
        json={"member_id": bot_id, "member_type": "bot"},
        headers={"Authorization": f"Bearer {jwt}"},
    )
    # 409 = already member, ok
    if resp.status_code not in (200, 201, 409):
        resp.raise_for_status()


async def _delete_test_bot(client: httpx.AsyncClient, jwt: str, bot_id: str) -> None:
    await client.delete(
        f"/api/v1/bots/{bot_id}",
        headers={"Authorization": f"Bearer {jwt}"},
    )


async def _send_user_message(
    client: httpx.AsyncClient, jwt: str, channel_id: str, text: str,
    mention_bot_ids: list[str] | None = None,
) -> str:
    resp = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={
            "content": text,
            "sender_id": ADMIN_USER_ID,
            "sender_type": "user",
            "mention_bot_ids": mention_bot_ids or [],
        },
        headers={"Authorization": f"Bearer {jwt}"},
    )
    resp.raise_for_status()
    return resp.json()["data"]["msg_id"]


async def _upload_binary(
    client: httpx.AsyncClient, bot_token: str, channel_id: str, filename: str, content: bytes,
) -> str:
    resp = await client.post(
        "/api/v1/agent-bridge/files/upload-binary",
        content=content,
        headers={
            "Authorization": f"Bearer {bot_token}",
            "X-Channel-Id": channel_id,
            "X-Filename": filename,
            "Content-Type": "text/plain",
        },
    )
    resp.raise_for_status()
    return resp.json()["data"]["file_id"]


async def _get_messages(client: httpx.AsyncClient, jwt: str, channel_id: str, limit: int = 30) -> list[dict]:
    resp = await client.get(
        f"/api/v1/channels/{channel_id}/messages?limit={limit}",
        headers={"Authorization": f"Bearer {jwt}"},
    )
    resp.raise_for_status()
    return resp.json()["data"]


async def _wait_for_dispatch(ws: websockets.WebSocketClientProtocol, bot_id: str, timeout: float = 10.0) -> dict:
    """Wait for a message dispatch event targeting bot_id."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=2)
            frame = json.loads(raw)
            if frame.get("type") == "message" and frame.get("bot_id") == bot_id:
                return frame
        except asyncio.TimeoutError:
            continue
    raise AssertionError(f"did not receive message dispatch for bot_id={bot_id} within {timeout}s")


# ─── Session-scope fixture: temporary bot shared by this module ───────────────


@pytest_asyncio.fixture(scope="module")
async def tmp_bot():
    """Create a temporary agent bridge bot for tests and clean it up afterward."""
    async with httpx.AsyncClient(base_url=E2E_BASE, follow_redirects=True, timeout=30) as client:
        jwt = await _login(client)
        bot_id, username, bot_token = await _create_test_bot(client, jwt)
        await _add_bot_to_channel(client, jwt, bot_id)
        yield {"bot_id": bot_id, "username": username, "bot_token": bot_token, "jwt": jwt, "channel_id": CHANNEL_ID}
        await _delete_test_bot(client, jwt, bot_id)


@pytest_asyncio.fixture
async def http_client():
    async with httpx.AsyncClient(base_url=E2E_BASE, follow_redirects=True, timeout=30) as client:
        yield client


# ─── Test 1: control WS handshake ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_control_ws_hello(tmp_bot: dict) -> None:
    """control WS should immediately receive hello with bot_id and memberships."""
    uri = f"{WS_BASE}/ws/agent-bridge/control"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {tmp_bot['bot_token']}"},
        open_timeout=10,
    ) as ws:
        raw = await asyncio.wait_for(ws.recv(), timeout=5)
        frame = json.loads(raw)

    assert frame["type"] == "hello"
    assert frame["bot_id"] == tmp_bot["bot_id"]
    assert isinstance(frame["memberships"], list)
    channel_ids = [m["channel_id"] for m in frame["memberships"]]
    assert CHANNEL_ID in channel_ids


# ─── Test 2: data WS hello ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_data_ws_hello(tmp_bot: dict) -> None:
    """data WS should receive a hello frame with stream=data."""
    uri = f"{WS_BASE}/ws/agent-bridge/data"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {tmp_bot['bot_token']}"},
        open_timeout=10,
    ) as ws:
        raw = await asyncio.wait_for(ws.recv(), timeout=5)
        frame = json.loads(raw)

    assert frame["type"] == "hello"
    assert frame["stream"] == "data"
    assert frame["bot_id"] == tmp_bot["bot_id"]


# ─── Test 3: message dispatch + plain text reply ─────────────────────────────


@pytest.mark.asyncio
async def test_message_dispatch_and_reply(tmp_bot: dict, http_client: httpx.AsyncClient) -> None:
    """@mention bot -> dispatch message frame to data WS -> plugin replies -> message is persisted."""
    bot_id = tmp_bot["bot_id"]
    bot_token = tmp_bot["bot_token"]
    jwt = tmp_bot["jwt"]
    channel_id = tmp_bot["channel_id"]

    uri = f"{WS_BASE}/ws/agent-bridge/data"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {bot_token}"},
        open_timeout=10,
    ) as ws:
        await asyncio.wait_for(ws.recv(), timeout=5)  # hello

        trigger = f"@{tmp_bot['username']} e2e纯文本测试_{uuid.uuid4().hex[:6]}"
        await _send_user_message(http_client, jwt, channel_id, trigger, mention_bot_ids=[bot_id])

        dispatch = await _wait_for_dispatch(ws, bot_id)
        task_id = dispatch["task_id"]
        placeholder_msg_id = dispatch.get("placeholder_msg_id")

        reply_text = f"e2e纯文本回复 task={task_id[:8]}"
        await ws.send(json.dumps({
            "type": "reply",
            "task_id": task_id,
            "reply_to_msg_id": placeholder_msg_id,
            "channel_id": channel_id,
            "text": reply_text,
        }))
        await asyncio.sleep(1)

    messages = await _get_messages(http_client, jwt, channel_id)
    bot_msgs = [m for m in messages if m.get("sender_type") == "bot"]
    contents = [m.get("content", "") for m in bot_msgs]
    assert any(reply_text in c for c in contents), (
        f"did not find {reply_text!r} in channel messages\nmessages: {contents}"
    )


# ─── Test 4: binary file upload + file reply ─────────────────────────────────


@pytest.mark.asyncio
async def test_file_upload_and_reply_with_file(tmp_bot: dict, http_client: httpx.AsyncClient) -> None:
    """Plugin uploads a file, replies with file_id, and channel message includes files."""
    bot_id = tmp_bot["bot_id"]
    bot_token = tmp_bot["bot_token"]
    jwt = tmp_bot["jwt"]
    channel_id = tmp_bot["channel_id"]

    file_content = b"# E2E Test Report\n\nGenerated by test_openclaw_e2e.py\n"
    file_id = await _upload_binary(http_client, bot_token, channel_id, "e2e_report.md", file_content)
    assert file_id

    uri = f"{WS_BASE}/ws/agent-bridge/data"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {bot_token}"},
        open_timeout=10,
    ) as ws:
        await asyncio.wait_for(ws.recv(), timeout=5)

        trigger = f"@{tmp_bot['username']} e2e_file_reply_test_{uuid.uuid4().hex[:6]}"
        await _send_user_message(http_client, jwt, channel_id, trigger, mention_bot_ids=[bot_id])

        dispatch = await _wait_for_dispatch(ws, bot_id)
        task_id = dispatch["task_id"]
        placeholder_msg_id = dispatch.get("placeholder_msg_id")

        await ws.send(json.dumps({
            "type": "reply",
            "task_id": task_id,
            "reply_to_msg_id": placeholder_msg_id,
            "channel_id": channel_id,
            "text": "Analysis report generated. Please see the attachment.",
            "file_ids": [file_id],
        }))
        await asyncio.sleep(1)

    messages = await _get_messages(http_client, jwt, channel_id)
    matched = [
        m for m in messages
        if m.get("sender_type") == "bot" and file_id in (m.get("file_ids") or [])
    ]
    assert matched, f"did not find bot message with file_id={file_id}"
    files = matched[0].get("files") or []
    assert any(f.get("file_id") == file_id for f in files), f"files field is missing file_id: {files}"


# ─── Test 5: streaming delta reply ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_streaming_delta_reply(tmp_bot: dict, http_client: httpx.AsyncClient) -> None:
    """Plugin streams delta frames and closes with done, producing correct concatenation."""
    bot_id = tmp_bot["bot_id"]
    bot_token = tmp_bot["bot_token"]
    jwt = tmp_bot["jwt"]
    channel_id = tmp_bot["channel_id"]

    uri = f"{WS_BASE}/ws/agent-bridge/data"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {bot_token}"},
        open_timeout=10,
    ) as ws:
        await asyncio.wait_for(ws.recv(), timeout=5)

        trigger = f"@{tmp_bot['username']} e2e_stream_test_{uuid.uuid4().hex[:6]}"
        await _send_user_message(http_client, jwt, channel_id, trigger, mention_bot_ids=[bot_id])

        dispatch = await _wait_for_dispatch(ws, bot_id)
        msg_id = dispatch.get("placeholder_msg_id")

        chunks = ["This ", "is ", "a streaming ", "reply test."]
        for i, chunk in enumerate(chunks):
            await ws.send(json.dumps({
                "type": "delta",
                "msg_id": msg_id,
                "delta": chunk,
                "seq": i,
            }))
            await asyncio.sleep(0.05)

        client_msg_id = f"done-{uuid.uuid4().hex}"
        await ws.send(json.dumps({"type": "done", "client_msg_id": client_msg_id, "msg_id": msg_id}))
        ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        assert ack.get("type") == "terminal_ack"
        assert ack.get("client_msg_id") == client_msg_id
        assert ack.get("ok") is True
        assert ack.get("msg_id") == msg_id
        await asyncio.sleep(1)

    expected = "".join(chunks)
    messages = await _get_messages(http_client, jwt, channel_id)
    bot_msgs = [m for m in messages if m.get("sender_type") == "bot"]
    contents = [m.get("content", "") for m in bot_msgs]
    assert any(expected in c for c in contents), (
        f"未找到流式拼接内容 {expected!r}\n内容: {contents}"
    )
