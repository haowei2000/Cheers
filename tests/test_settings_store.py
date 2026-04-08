"""admin.settings_store 回退逻辑测试。"""
from __future__ import annotations

from app.services.admin.settings_store import get_llm_providers_list, get_provider_for_scope
from app.config import settings


def test_get_provider_for_scope_uses_existing_provider_when_bindings_empty(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.admin.settings_store.load_admin_settings",
        lambda: {
            "llm_providers": [
                {
                    "id": "provider-1",
                    "name": "Local Ollama",
                    "base_url": "http://localhost:11434/v1",
                    "model": "llama3.2",
                    "api_key": "ollama",
                    "temperature": 0.7,
                    "max_tokens": 1000,
                }
            ],
            "llm_bindings": {"guide_bot": "provider-1"},
        },
    )
    monkeypatch.setattr(settings, "llm_localhost_alias", "host.docker.internal", raising=False)

    provider = get_provider_for_scope("guide_bot")

    assert provider is not None
    assert provider["base_url"] == "http://host.docker.internal:11434/v1"
    assert provider["model"] == "llama3.2"


def test_get_llm_providers_list_includes_enabled_ai_models(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.admin.settings_store.load_admin_settings",
        lambda: {"llm_providers": [], "llm_bindings": {}},
    )
    monkeypatch.setattr(
        "app.services.admin.settings_store._load_ai_model_providers",
        lambda: [
            {
                "id": "ai-model:model-qwen-plus",
                "model_id": "model-qwen-plus",
                "name": "Qwen3.5 Plus",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model": "qwen-plus",
                "api_key": "sk-test",
                "temperature": 0.3,
                "max_tokens": 4096,
            }
        ],
    )

    providers = get_llm_providers_list()

    assert len(providers) == 1
    assert providers[0]["id"] == "ai-model:model-qwen-plus"
    assert providers[0]["name"] == "Qwen3.5 Plus"
    assert providers[0]["api_key_set"] is True


def test_get_provider_for_scope_supports_ai_model_binding(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.admin.settings_store.load_admin_settings",
        lambda: {"llm_providers": [], "llm_bindings": {"guide_bot": "ai-model:model-qwen-plus"}},
    )
    monkeypatch.setattr(
        "app.services.admin.settings_store._load_ai_model_providers",
        lambda: [
            {
                "id": "ai-model:model-qwen-plus",
                "model_id": "model-qwen-plus",
                "name": "Qwen3.5 Plus",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model": "qwen-plus",
                "api_key": "sk-test",
                "temperature": 0.2,
                "max_tokens": 8192,
                "extra_headers": {"X-Test": "yes"},
            }
        ],
    )

    provider = get_provider_for_scope("guide_bot")

    assert provider is not None
    assert provider["base_url"] == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert provider["model"] == "qwen-plus"
    assert provider["api_key"] == "sk-test"
    assert provider["extra_headers"] == {"X-Test": "yes"}
