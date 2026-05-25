"""DingTalk login coverage."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.db.models import AuthExternalIdentity, User
from app.main import app
from app.services.auth.jwt_utils import _get_secret, create_service_token


def _enable_dingtalk(monkeypatch, *, allowed: str = "dingcorp") -> None:
    monkeypatch.setattr(settings, "dingtalk_login_enabled", True)
    monkeypatch.setattr(settings, "dingtalk_client_id", "ding-client")
    monkeypatch.setattr(settings, "dingtalk_client_secret", "ding-secret")
    monkeypatch.setattr(settings, "dingtalk_allowed_corp_ids", allowed)
    monkeypatch.setattr(settings, "dingtalk_default_corp_id", allowed.split(",")[0])
    monkeypatch.setattr(settings, "dingtalk_oauth_authorize_url", "https://dingtalk.test/oauth2/auth")
    monkeypatch.setattr(settings, "dingtalk_oauth_token_url", "https://dingtalk.test/token")
    monkeypatch.setattr(settings, "dingtalk_user_info_url", "https://dingtalk.test/users/me")
    monkeypatch.setattr(settings, "public_base_url", "http://test")


async def _install_dingtalk_mock(token_payload: dict, profile_payload: dict) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(200, json=token_payload)
        if request.url.path == "/users/me":
            assert request.headers["x-acs-dingtalk-access-token"] == token_payload.get("accessToken")
            return httpx.Response(200, json=profile_payload)
        return httpx.Response(404, json={"message": "not found"})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app.state.http_client = http_client
    return http_client


async def _close_dingtalk_mock(http_client: httpx.AsyncClient) -> None:
    await http_client.aclose()
    if hasattr(app.state, "http_client"):
        delattr(app.state, "http_client")


@pytest.mark.asyncio
async def test_dingtalk_in_app_login_creates_member_user(client, db_session, monkeypatch):
    _enable_dingtalk(monkeypatch)
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "dingcorp"},
        {"unionId": "union-001", "openId": "open-001", "nick": "Alice", "avatarUrl": "https://img/a.png"},
    )
    try:
        resp = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
    finally:
        await _close_dingtalk_mock(http_client)

    assert resp.status_code == 200
    payload = resp.json()["data"]
    assert payload["access_token"]
    assert payload["user"]["role"] == "member"
    assert payload["user"]["display_name"] == "Alice"

    identity = (await db_session.execute(select(AuthExternalIdentity))).scalar_one()
    assert identity.provider == "dingtalk"
    assert identity.subject == "union-001"
    assert identity.corp_id == "dingcorp"
    assert identity.user_id == payload["user"]["user_id"]


@pytest.mark.asyncio
async def test_dingtalk_repeated_login_reuses_linked_user(client, db_session, monkeypatch):
    _enable_dingtalk(monkeypatch)
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "dingcorp"},
        {"unionId": "union-repeat", "openId": "open-repeat", "nick": "Repeat"},
    )
    try:
        first = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "one"})
        second = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "two"})
    finally:
        await _close_dingtalk_mock(http_client)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["data"]["user"]["user_id"] == second.json()["data"]["user"]["user_id"]
    count = (
        await db_session.execute(
            select(func.count()).select_from(AuthExternalIdentity).where(AuthExternalIdentity.subject == "union-repeat")
        )
    ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_dingtalk_login_rejects_disallowed_corp(client, monkeypatch):
    _enable_dingtalk(monkeypatch, allowed="allowed-corp")
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "other-corp"},
        {"unionId": "union-corp", "openId": "open-corp", "nick": "Corp"},
    )
    try:
        resp = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
    finally:
        await _close_dingtalk_mock(http_client)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_dingtalk_login_requires_corp_id(client, monkeypatch):
    _enable_dingtalk(monkeypatch)
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access"},
        {"unionId": "union-missing-corp", "openId": "open-missing-corp", "nick": "Missing"},
    )
    try:
        resp = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
    finally:
        await _close_dingtalk_mock(http_client)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_dingtalk_login_requires_identity_subject(client, monkeypatch):
    _enable_dingtalk(monkeypatch)
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "dingcorp"},
        {"nick": "Missing Identity"},
    )
    try:
        resp = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
    finally:
        await _close_dingtalk_mock(http_client)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_dingtalk_login_rejects_deleted_linked_user(client, db_session, monkeypatch):
    _enable_dingtalk(monkeypatch)
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "dingcorp"},
        {"unionId": "union-deleted", "openId": "open-deleted", "nick": "Deleted"},
    )
    try:
        first = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
        user = await db_session.get(User, first.json()["data"]["user"]["user_id"])
        user.is_deleted = True
        await db_session.flush()
        second = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
    finally:
        await _close_dingtalk_mock(http_client)
    assert second.status_code == 401


@pytest.mark.asyncio
async def test_dingtalk_login_uses_deterministic_collision_suffix(client, db_session, monkeypatch):
    _enable_dingtalk(monkeypatch)
    db_session.add(User(user_id="collision-user", username="dt_alice_12345678", password_hash="x"))
    await db_session.flush()
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "dingcorp"},
        {"unionId": "union-12345678", "openId": "open-collision", "nick": "Alice"},
    )
    try:
        resp = await client.post("/api/v1/auth/dingtalk/in-app-login", json={"auth_code": "auth-code"})
    finally:
        await _close_dingtalk_mock(http_client)

    assert resp.status_code == 200
    assert resp.json()["data"]["user"]["username"] == "dt_alice_12345678_1"


@pytest.mark.asyncio
async def test_dingtalk_exchange_rejects_expired_ticket(client, monkeypatch):
    _enable_dingtalk(monkeypatch)
    payload = {
        "typ": "dingtalk_login_ticket",
        "sub": "missing-user",
        "iat": datetime.now(UTC) - timedelta(minutes=10),
        "exp": datetime.now(UTC) - timedelta(minutes=5),
    }
    ticket = jwt.encode(payload, _get_secret(), algorithm=settings.jwt_algorithm)
    resp = await client.post("/api/v1/auth/dingtalk/exchange", json={"ticket": ticket})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_dingtalk_callback_redirects_with_short_lived_ticket(client, monkeypatch):
    _enable_dingtalk(monkeypatch)
    state = create_service_token(
        {"typ": "dingtalk_oauth_state", "redirect_path": "/workspaces/ws1"},
        expires_seconds=60,
    )
    http_client = await _install_dingtalk_mock(
        {"accessToken": "dt-access", "corpId": "dingcorp"},
        {"unionId": "union-web", "openId": "open-web", "nick": "Web"},
    )
    try:
        resp = await client.get(
            "/api/v1/auth/dingtalk/callback",
            params={"authCode": "web-code", "state": state},
            follow_redirects=False,
        )
    finally:
        await _close_dingtalk_mock(http_client)

    assert resp.status_code in (302, 307)
    location = resp.headers["location"]
    assert location.startswith("/auth/dingtalk/callback?ticket=")
    assert "redirect_path=%2Fworkspaces%2Fws1" in location


@pytest.mark.asyncio
async def test_dingtalk_provider_disabled_by_default(client, monkeypatch):
    monkeypatch.setattr(settings, "dingtalk_login_enabled", False)
    resp = await client.get("/api/v1/auth/providers")
    assert resp.status_code == 200
    provider = resp.json()["data"][0]
    assert provider["provider"] == "dingtalk"
    assert provider["enabled"] is False


@pytest.mark.asyncio
async def test_external_identity_provider_subject_unique(db_session):
    user = User(user_id="identity-user", username="identity_user", password_hash="x")
    db_session.add(user)
    await db_session.flush()
    db_session.add_all(
        [
            AuthExternalIdentity(
                provider="dingtalk",
                subject="same-subject",
                user_id=user.user_id,
                corp_id="corp",
            ),
            AuthExternalIdentity(
                provider="dingtalk",
                subject="same-subject",
                user_id=user.user_id,
                corp_id="corp",
            ),
        ]
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()
