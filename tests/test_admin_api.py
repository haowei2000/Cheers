"""Admin API 兼容性测试。"""
from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_post_llm_bind_compat_route_updates_binding(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.admin.settings_store.set_llm_bindings",
        lambda **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.admin.settings_store.get_llm_bindings",
        lambda: {"channel_bot": "ai-model:model-qwen-plus"},
    )

    resp = await client.post(
        "/api/v1/admin/settings/llm/bind",
        json={"scope": "channel_bot", "provider_id": "ai-model:model-qwen-plus"},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["bindings"]["channel_bot"] == "ai-model:model-qwen-plus"


@pytest.mark.asyncio
async def test_post_orchestrator_compat_route_works(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.admin.settings_store.set_assist_settings",
        lambda **kwargs: {"auto_takeover": kwargs.get("auto_takeover", False)},
    )

    resp = await client.put(
        "/api/v1/admin/settings/assist",
        json={"auto_takeover": False},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
