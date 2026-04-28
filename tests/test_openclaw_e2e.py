"""端到端集成测试：OpenClaw WS 协议 + 消息派发 + 文件回传.

测试策略：
  - 每次测试会话创建一个临时 websocket bot（隔离），结束后删除
  - 不触碰任何生产 bot 的 token，避免破坏正在运行的 plugin 连接
  - 临时 bot 被加入 cafe 频道，测试完毕后从频道移除 + 删除 bot

前提：
  - Docker 后端跑在 http://localhost:8002
  - admin 账号和 cafe 频道 (ba30fc1a-...) 存在
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

BASE = os.getenv("TEST_BASE_URL", "http://localhost:8002")
WS_BASE = BASE.replace("http://", "ws://").replace("https://", "wss://")


def _backend_reachable(url: str, timeout: float = 0.5) -> bool:
    """快速 TCP 探测：CI 没有 live backend 时跳过整个 e2e 模块。"""
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _backend_reachable(BASE),
    reason=f"E2E backend not reachable at {BASE}; set TEST_BASE_URL to a live server to enable",
)

CHANNEL_ID = "ba30fc1a-8324-4a30-86fe-102214114ea0"
ADMIN_USER_ID = "admin-0000-0000-0000-000000000001"


# ─── 辅助 ──────────────────────────────────────────────────────────────────────

async def _login(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "change-me-admin-password"},
    )
    resp.raise_for_status()
    return resp.json()["data"]["access_token"]


async def _create_test_bot(client: httpx.AsyncClient, jwt: str) -> tuple[str, str, str]:
    """创建临时 websocket bot，返回 (bot_id, username, bot_token)."""
    name = f"e2e-tmp-{uuid.uuid4().hex[:8]}"
    resp = await client.post(
        "/api/v1/bots",
        json={
            "username": name,
            "display_name": name,
            "binding_type": "websocket",
            "binding_config": {"agent_id": "test"},
            "status": "online",
        },
        headers={"Authorization": f"Bearer {jwt}"},
    )
    resp.raise_for_status()
    bot_id = resp.json()["data"]["bot_id"]

    # 轮换一次拿到明文 token
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
        "/api/v1/openclaw/bridge/files/upload-binary",
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
    """等待针对 bot_id 的 message 派发事件。"""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=2)
            frame = json.loads(raw)
            if frame.get("type") == "message" and frame.get("bot_id") == bot_id:
                return frame
        except asyncio.TimeoutError:
            continue
    raise AssertionError(f"未收到针对 bot_id={bot_id} 的 message 派发事件（超时 {timeout}s）")


# ─── Session-scope fixture：临时 bot（整个测试文件共用，避免反复创建）──────────


@pytest_asyncio.fixture(scope="module")
async def tmp_bot():
    """创建测试专用临时 websocket bot，模块结束后清理。"""
    async with httpx.AsyncClient(base_url=BASE, follow_redirects=True, timeout=30) as client:
        jwt = await _login(client)
        bot_id, username, bot_token = await _create_test_bot(client, jwt)
        await _add_bot_to_channel(client, jwt, bot_id)
        yield {"bot_id": bot_id, "username": username, "bot_token": bot_token, "jwt": jwt, "channel_id": CHANNEL_ID}
        await _delete_test_bot(client, jwt, bot_id)


@pytest_asyncio.fixture
async def http_client():
    async with httpx.AsyncClient(base_url=BASE, follow_redirects=True, timeout=30) as client:
        yield client


# ─── 测试 1：control WS 握手 ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_control_ws_hello(tmp_bot: dict) -> None:
    """control WS 连接后应立刻收到 hello 帧，包含 bot_id 和 memberships."""
    uri = f"{WS_BASE}/ws/openclaw/control"
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


# ─── 测试 2：data WS hello ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_data_ws_hello(tmp_bot: dict) -> None:
    """data WS 连接后应收到 hello 帧，stream=data."""
    uri = f"{WS_BASE}/ws/openclaw/data"
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


# ─── 测试 3：消息派发 + 纯文本回复 ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_message_dispatch_and_reply(tmp_bot: dict, http_client: httpx.AsyncClient) -> None:
    """@mention bot → 派发 message 帧到 data WS → plugin 发 reply → 消息写入频道."""
    bot_id = tmp_bot["bot_id"]
    bot_token = tmp_bot["bot_token"]
    jwt = tmp_bot["jwt"]
    channel_id = tmp_bot["channel_id"]

    uri = f"{WS_BASE}/ws/openclaw/data"
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
        f"未在频道消息里找到 {reply_text!r}\n消息: {contents}"
    )


# ─── 测试 4：二进制文件上传 + 文件回传 ───────────────────────────────────────


@pytest.mark.asyncio
async def test_file_upload_and_reply_with_file(tmp_bot: dict, http_client: httpx.AsyncClient) -> None:
    """plugin 上传文件 → 回复时携带 file_id → 频道消息含 files 字段."""
    bot_id = tmp_bot["bot_id"]
    bot_token = tmp_bot["bot_token"]
    jwt = tmp_bot["jwt"]
    channel_id = tmp_bot["channel_id"]

    file_content = b"# E2E Test Report\n\nGenerated by test_openclaw_e2e.py\n"
    file_id = await _upload_binary(http_client, bot_token, channel_id, "e2e_report.md", file_content)
    assert file_id

    uri = f"{WS_BASE}/ws/openclaw/data"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {bot_token}"},
        open_timeout=10,
    ) as ws:
        await asyncio.wait_for(ws.recv(), timeout=5)

        trigger = f"@{tmp_bot['username']} e2e文件回传测试_{uuid.uuid4().hex[:6]}"
        await _send_user_message(http_client, jwt, channel_id, trigger, mention_bot_ids=[bot_id])

        dispatch = await _wait_for_dispatch(ws, bot_id)
        task_id = dispatch["task_id"]
        placeholder_msg_id = dispatch.get("placeholder_msg_id")

        await ws.send(json.dumps({
            "type": "reply",
            "task_id": task_id,
            "reply_to_msg_id": placeholder_msg_id,
            "channel_id": channel_id,
            "text": "已生成分析报告，请查收附件。",
            "file_ids": [file_id],
        }))
        await asyncio.sleep(1)

    messages = await _get_messages(http_client, jwt, channel_id)
    matched = [
        m for m in messages
        if m.get("sender_type") == "bot" and file_id in (m.get("file_ids") or [])
    ]
    assert matched, f"未找到携带 file_id={file_id} 的 bot 消息"
    files = matched[0].get("files") or []
    assert any(f.get("file_id") == file_id for f in files), f"files 字段缺少 file_id: {files}"


# ─── 测试 5：流式 delta 回复 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_streaming_delta_reply(tmp_bot: dict, http_client: httpx.AsyncClient) -> None:
    """plugin 用 delta 帧流式推送，done 帧收尾 → 消息拼接正确."""
    bot_id = tmp_bot["bot_id"]
    bot_token = tmp_bot["bot_token"]
    jwt = tmp_bot["jwt"]
    channel_id = tmp_bot["channel_id"]

    uri = f"{WS_BASE}/ws/openclaw/data"
    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {bot_token}"},
        open_timeout=10,
    ) as ws:
        await asyncio.wait_for(ws.recv(), timeout=5)

        trigger = f"@{tmp_bot['username']} e2e流式测试_{uuid.uuid4().hex[:6]}"
        await _send_user_message(http_client, jwt, channel_id, trigger, mention_bot_ids=[bot_id])

        dispatch = await _wait_for_dispatch(ws, bot_id)
        msg_id = dispatch.get("placeholder_msg_id")

        chunks = ["这是", "流式", "回复", "测试。"]
        for i, chunk in enumerate(chunks):
            await ws.send(json.dumps({
                "type": "delta",
                "msg_id": msg_id,
                "delta": chunk,
                "seq": i,
            }))
            await asyncio.sleep(0.05)

        await ws.send(json.dumps({"type": "done", "msg_id": msg_id}))
        await asyncio.sleep(1)

    expected = "".join(chunks)
    messages = await _get_messages(http_client, jwt, channel_id)
    bot_msgs = [m for m in messages if m.get("sender_type") == "bot"]
    contents = [m.get("content", "") for m in bot_msgs]
    assert any(expected in c for c in contents), (
        f"未找到流式拼接内容 {expected!r}\n内容: {contents}"
    )
