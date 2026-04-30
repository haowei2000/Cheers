"""AI model ownership and visibility API tests."""
from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user
from app.core.dependencies import get_session as get_session_core
from app.db.models import AIModel, PromptTemplate, User
from app.db.session import get_session as get_session_db
from app.main import app


async def _request_as(
    db_session: AsyncSession,
    user: User,
    method: str,
    path: str,
    *,
    json: dict | None = None,
) -> Response:
    async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
        yield db_session

    async def override_get_current_user() -> User:
        return user

    app.dependency_overrides[get_session_core] = override_get_session
    app.dependency_overrides[get_session_db] = override_get_session
    app.dependency_overrides[get_current_user] = override_get_current_user
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            return await ac.request(method, path, json=json)
    finally:
        app.dependency_overrides.clear()


def _user(user_id: str, username: str, role: str = "member") -> User:
    return User(
        user_id=user_id,
        username=username,
        password_hash="x",
        role=role,
    )


def _model(model_id: str, owner_id: str, *, name: str | None = None) -> AIModel:
    return AIModel(
        model_id=model_id,
        name=name or model_id,
        provider="openai",
        model_name="gpt-test",
        base_url="http://llm.test/v1",
        is_enabled=True,
        is_builtin=False,
        is_public=True,
        config={},
        created_by=owner_id,
    )


@pytest.mark.asyncio
async def test_member_can_create_model_and_created_model_is_private(
    db_session: AsyncSession,
) -> None:
    user = _user("model-user-create", "model_user_create")
    db_session.add(user)
    await db_session.flush()

    resp = await _request_as(
        db_session,
        user,
        "POST",
        "/api/v1/admin/models",
        json={
            "name": "Member Model",
            "provider": "openai",
            "model_name": "gpt-test",
            "base_url": "http://llm.test/v1",
            "api_key": "sk-test",
            "is_public": True,
            "config": {"temperature": 0.2},
        },
    )

    assert resp.status_code == 200
    payload = resp.json()["data"]
    assert payload["name"] == "Member Model"
    assert payload["is_public"] is False

    saved = await db_session.get(AIModel, payload["model_id"])
    assert saved is not None
    assert saved.created_by == user.user_id
    assert saved.is_public is False


@pytest.mark.asyncio
async def test_models_are_visible_and_usable_only_by_owner(
    db_session: AsyncSession,
) -> None:
    owner = _user("model-owner-visibility", "model_owner_visibility")
    stranger = _user("model-stranger-visibility", "model_stranger_visibility")
    owner_model = _model("owner-private-model", owner.user_id, name="Owner Private")
    stranger_model = _model("stranger-private-model", stranger.user_id, name="Stranger Private")
    template = PromptTemplate(
        template_id="model-visibility-template",
        name="Model Visibility Template",
        system_prompt="system",
        user_template="{{message}}",
        variables=["message"],
        is_builtin=True,
    )
    db_session.add_all([owner, stranger, owner_model, stranger_model, template])
    await db_session.flush()

    owner_list = await _request_as(
        db_session,
        owner,
        "GET",
        "/api/v1/admin/models?include_disabled=true",
    )
    assert owner_list.status_code == 200
    owner_ids = {item["model_id"] for item in owner_list.json()["data"]}
    assert owner_model.model_id in owner_ids
    assert stranger_model.model_id not in owner_ids

    stranger_get = await _request_as(
        db_session,
        stranger,
        "GET",
        f"/api/v1/admin/models/{owner_model.model_id}",
    )
    assert stranger_get.status_code == 404

    stranger_bot = await _request_as(
        db_session,
        stranger,
        "POST",
        "/api/v1/bots",
        json={
            "username": "stranger_model_bot",
            "model_id": owner_model.model_id,
            "template_id": template.template_id,
        },
    )
    assert stranger_bot.status_code == 403

    owner_bot = await _request_as(
        db_session,
        owner,
        "POST",
        "/api/v1/bots",
        json={
            "username": "owner_model_bot",
            "model_id": owner_model.model_id,
            "template_id": template.template_id,
        },
    )
    assert owner_bot.status_code == 200
