"""Admin API 兼容性测试。"""
from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_post_llm_bind_compat_route_updates_binding(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.admin.routes.set_llm_bindings",
        lambda **kwargs: None,
    )
    monkeypatch.setattr(
        "app.admin.routes.get_llm_bindings",
        lambda: {"guide_bot": "ai-model:model-qwen-plus"},
    )

    resp = await client.post(
        "/api/admin/settings/llm/bind",
        json={"scope": "guide_bot", "provider_id": "ai-model:model-qwen-plus"},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["bindings"]["guide_bot"] == "ai-model:model-qwen-plus"


@pytest.mark.asyncio
async def test_post_orchestrator_compat_route_works(client: AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.admin.routes.set_orchestrator_settings",
        lambda **kwargs: {
            "orchestrator_direct_answer": True,
            "orchestrator_auto_takeover": False,
        },
    )

    resp = await client.post(
        "/api/admin/settings/orchestrator",
        json={"orchestrator_direct_answer": True, "orchestrator_auto_takeover": False},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    assert resp.json()["data"]["orchestrator_direct_answer"] is True
