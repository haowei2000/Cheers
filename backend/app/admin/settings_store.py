"""管理端 LLM 等参数持久化：一层 LLM 设定（增删改列表），二层功能绑定（按功能选 LLM）。"""
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.config import settings

ADMIN_SETTINGS_FILENAME = "admin_settings.json"
SCOPES = ("channel_bot", "system_llm", "log_analyze", "qa_summarize", "orchestrator")
DEFAULT_CLARIFY_SETTINGS = {
    "clarify_strict_mode": False,
    "clarify_force_rule": True,
    "clarify_threshold": 0.6,
}

DEFAULT_ORCHESTRATOR_SETTINGS = {
    "orchestrator_direct_answer": False,
    "orchestrator_auto_takeover": False,
}
DEFAULT_IMAGE_GEN_SETTINGS: dict[str, Any] = {
    "base_url": "",
    "api_key": "",
    "default_model": "qwen-image-edit-max",
}

AI_MODEL_PROVIDER_PREFIX = "ai-model:"

# 与 config 一致：相对 data_dir 基于 backend 根目录（3 个 parent：app/admin -> app -> backend）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


def _settings_path() -> Path:
    base = Path(settings.data_dir)
    if not base.is_absolute():
        base = _BACKEND_ROOT / base
    return base / ADMIN_SETTINGS_FILENAME


def _settings_path_project_root_fallback() -> Path:
    """兼容旧部署：项目根目录下的 data/admin_settings.json。"""
    return _BACKEND_ROOT.parent / settings.data_dir / ADMIN_SETTINGS_FILENAME


def load_admin_settings() -> dict[str, Any]:
    """读取管理端保存的配置，不存在或异常则返回空 dict。优先 backend/data，若无则尝试项目根 data/ 并回写迁移。"""
    path = _settings_path()
    fallback = _settings_path_project_root_fallback()
    try:
        if path.is_file():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        if fallback.is_file():
            with open(fallback, "r", encoding="utf-8") as f:
                data = json.load(f)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def save_admin_settings(data: dict[str, Any]) -> None:
    """写入管理端配置到 JSON 文件。"""
    path = _settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _ensure_llm_structures(data: dict[str, Any]) -> None:
    if "llm_providers" not in data:
        data["llm_providers"] = []
    if "llm_bindings" not in data:
        data["llm_bindings"] = {}


def _ensure_clarify_settings(data: dict[str, Any]) -> None:
    for k, v in DEFAULT_CLARIFY_SETTINGS.items():
        if k not in data:
            data[k] = v


def _ensure_orchestrator_settings(data: dict[str, Any]) -> None:
    for k, v in DEFAULT_ORCHESTRATOR_SETTINGS.items():
        if k not in data:
            data[k] = v


def _rewrite_localhost_base_url(base_url: str) -> str:
    alias = (settings.llm_localhost_alias or "").strip()
    url = (base_url or "").strip()
    if not alias or not url:
        return url
    try:
        parsed = urlsplit(url)
    except ValueError:
        return url
    if (parsed.hostname or "").lower() not in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return url
    netloc = alias
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    return urlunsplit((parsed.scheme or "http", netloc, parsed.path, parsed.query, parsed.fragment))


def _normalize_provider_config(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {
        "base_url": _rewrite_localhost_base_url((payload.get("base_url") or "").strip()),
        "model": (payload.get("model") or "").strip(),
        "api_key": (payload.get("api_key") or "").strip(),
        "temperature": float(payload.get("temperature", 0.7)),
        "max_tokens": int(payload.get("max_tokens", 1000)),
    }
    extra_headers = payload.get("extra_headers")
    if isinstance(extra_headers, dict) and extra_headers:
        normalized["extra_headers"] = {str(k): str(v) for k, v in extra_headers.items()}
    timeout = payload.get("timeout")
    if timeout is not None:
        try:
            normalized["timeout"] = float(timeout)
        except (TypeError, ValueError):
            pass
    return normalized


def _resolve_sqlite_database_path() -> Path | None:
    url = (settings.database_url or "").strip()
    if not url.startswith("sqlite") or "///" not in url:
        return None
    database_path = url.split("///", 1)[1].split("?", 1)[0]
    if not database_path or database_path == ":memory:":
        return None
    path = Path(database_path)
    if not path.is_absolute():
        path = (_BACKEND_ROOT / path).resolve()
    return path


def _parse_json_object(raw_value: Any) -> dict[str, Any]:
    if isinstance(raw_value, dict):
        return raw_value
    if isinstance(raw_value, str) and raw_value.strip():
        try:
            data = json.loads(raw_value)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}
    return {}


def _load_ai_model_providers() -> list[dict[str, Any]]:
    db_path = _resolve_sqlite_database_path()
    if not db_path or not db_path.is_file():
        return []

    query = """
        SELECT model_id, name, provider, model_name, base_url, api_key, config
        FROM ai_models
        WHERE is_enabled = 1
        ORDER BY datetime(created_at) DESC, name ASC
    """
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(query).fetchall()
    except sqlite3.Error:
        return []
    finally:
        if conn is not None:
            conn.close()

    providers: list[dict[str, Any]] = []
    for row in rows:
        config = _parse_json_object(row["config"])
        extra_headers = config.get("extra_headers")
        provider: dict[str, Any] = {
            "id": f"{AI_MODEL_PROVIDER_PREFIX}{row['model_id']}",
            "model_id": row["model_id"],
            "name": row["name"] or row["model_name"] or "未命名模型",
            "base_url": (row["base_url"] or "").strip(),
            "model": (row["model_name"] or "").strip(),
            "api_key": (row["api_key"] or "").strip(),
            "temperature": float(config.get("temperature", 0.7)),
            "max_tokens": int(config.get("max_tokens", 1000)),
            "source": "ai_model",
            "provider": (row["provider"] or "").strip(),
        }
        if isinstance(extra_headers, dict) and extra_headers:
            provider["extra_headers"] = extra_headers
        timeout = config.get("timeout")
        if timeout is not None:
            provider["timeout"] = timeout
        providers.append(provider)
    return providers


# 预设本地模型（Ollama，OpenAI 兼容）
PRESET_LLM_BASE_URL = "http://localhost:11434/v1"
PRESET_LLM_API_KEY = "ollama"
PRESET_LLM_PROVIDERS = [
    {"id": "preset-llama", "name": "Llama 3.3 70B", "model": "llama3.3:70b"},
    {"id": "preset-gemma", "name": "Gemma 3 27B", "model": "gemma3:27b"},
    {"id": "preset-qwen", "name": "Qwen3 32B", "model": "qwen3:32b"},
    {"id": "preset-mistral", "name": "Mistral latest", "model": "mistral:latest"},
]


def ensure_preset_llm_providers() -> None:
    """若当前无任何 LLM 设定，则写入预设的本地 Ollama 模型（仅执行一次）。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    if not data["llm_providers"]:
        for p in PRESET_LLM_PROVIDERS:
            data["llm_providers"].append({
                "id": p["id"],
                "name": p["name"],
                "base_url": PRESET_LLM_BASE_URL,
                "model": p["model"],
                "api_key": PRESET_LLM_API_KEY,
                "temperature": 0.7,
                "max_tokens": 1000,
            })
    if not (data.get("llm_bindings") or {}) and data["llm_providers"]:
        default_provider_id = data["llm_providers"][0]["id"]
        for scope in ("channel_bot", "orchestrator", "system_llm"):
            data["llm_bindings"][scope] = default_provider_id
    save_admin_settings(data)


def get_llm_providers_list() -> list[dict[str, Any]]:
    """返回 LLM 列表（不含 api_key 明文，仅 api_key_set）。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    out = []
    providers = _load_ai_model_providers() + list(data["llm_providers"])
    for p in providers:
        out.append({
            "id": p.get("id", ""),
            "name": p.get("name", ""),
            "base_url": p.get("base_url", ""),
            "model": p.get("model", ""),
            "api_key_set": bool(p.get("api_key")),
            "temperature": float(p.get("temperature", 0.7)),
            "max_tokens": int(p.get("max_tokens", 1000)),
        })
    return out


def get_llm_bindings() -> dict[str, str]:
    """返回各功能绑定的 provider id。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    return dict(data.get("llm_bindings", {}) or {})


def _get_provider_by_id(provider_id: str) -> dict[str, Any] | None:
    data = load_admin_settings()
    _ensure_llm_structures(data)
    for p in data["llm_providers"]:
        if p.get("id") == provider_id:
            return p
    for p in _load_ai_model_providers():
        if p.get("id") == provider_id or p.get("model_id") == provider_id:
            return p
    return None


def get_provider_for_scope(scope: str) -> dict[str, Any] | None:
    """
    按功能范围返回当前绑定的 LLM 配置（base_url, model, api_key, temperature, max_tokens）。
    channel_bot 为频道内置助手的统一 scope，兼容旧版 guide_bot / assistant_bot / builtin_llm。
    """
    data = load_admin_settings()
    _ensure_llm_structures(data)

    # channel_bot：频道助手统一 scope（兼容旧版 guide_bot / assistant_bot / builtin_llm）
    if scope in ("channel_bot", "guide_bot", "assistant_bot"):
        # 1. 旧版 builtin_llm 直接配置优先（向后兼容，界面已迁移到绑定方式）
        builtin = data.get("builtin_llm", {})
        if builtin.get("base_url") or builtin.get("model"):
            return _normalize_provider_config(builtin)
        # 2. 新版 channel_bot 绑定
        bindings = data.get("llm_bindings") or {}
        pid = bindings.get("channel_bot") or bindings.get("guide_bot")
        if pid:
            p = _get_provider_by_id(pid)
            if p:
                return _normalize_provider_config(p)
        # 3. 回退到第一个可用 provider
        if data["llm_providers"]:
            return _normalize_provider_config(data["llm_providers"][0])
        # 4. 最终回退：env 配置（兼容旧部署）
        from app.config import settings as s
        base = (data.get("guide_llm_base_url") or s.guide_llm_base_url or "").strip()
        model = (data.get("guide_llm_model") or s.guide_llm_model or "").strip()
        if base and model:
            return _normalize_provider_config({
                "base_url": base,
                "model": model,
                "api_key": (data.get("guide_llm_api_key") or s.guide_llm_api_key or "").strip(),
                "temperature": float(data.get("guide_llm_temperature", s.guide_llm_temperature)),
                "max_tokens": int(data.get("guide_llm_max_tokens", s.guide_llm_max_tokens)),
            })
        return None

    bindings = data.get("llm_bindings") or {}
    pid = bindings.get(scope)
    if pid:
        p = _get_provider_by_id(pid)
        if p:
            return _normalize_provider_config(p)
    if data["llm_providers"]:
        return _normalize_provider_config(data["llm_providers"][0])
    if scope in ("system_llm", "log_analyze", "qa_summarize", "orchestrator"):
        from app.config import settings as s
        return _normalize_provider_config({
            "base_url": (data.get("system_llm_base_url") or s.system_llm_base_url or "").strip(),
            "model": (data.get("system_llm_model") or s.system_llm_model or "gpt-4o-mini").strip(),
            "api_key": (data.get("system_llm_api_key") or s.system_llm_api_key or "").strip(),
            "temperature": 0.5,
            "max_tokens": 1500,
        })
    return None


def create_llm_provider(
    name: str,
    base_url: str,
    model: str,
    api_key: str = "",
    temperature: float = 0.7,
    max_tokens: int = 1000,
) -> str:
    """新增一个 LLM 配置，返回 id。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    pid = str(uuid.uuid4())
    data["llm_providers"].append({
        "id": pid,
        "name": (name or "").strip() or "未命名",
        "base_url": (base_url or "").strip(),
        "model": (model or "").strip(),
        "api_key": (api_key or "").strip(),
        "temperature": temperature,
        "max_tokens": max_tokens,
    })
    save_admin_settings(data)
    return pid


def update_llm_provider(
    provider_id: str,
    name: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    api_key: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> bool:
    """更新指定 LLM；api_key 传空串表示不修改。返回是否找到并更新。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    for p in data["llm_providers"]:
        if p.get("id") == provider_id:
            if name is not None:
                p["name"] = (name or "").strip() or "未命名"
            if base_url is not None:
                p["base_url"] = (base_url or "").strip()
            if model is not None:
                p["model"] = (model or "").strip()
            if api_key is not None and (api_key or "").strip():
                p["api_key"] = api_key.strip()
            if temperature is not None:
                p["temperature"] = temperature
            if max_tokens is not None:
                p["max_tokens"] = max_tokens
            save_admin_settings(data)
            return True
    return False


def delete_llm_provider(provider_id: str) -> bool:
    """删除指定 LLM；并清除使用该 id 的绑定。返回是否找到并删除。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    before = len(data["llm_providers"])
    data["llm_providers"] = [p for p in data["llm_providers"] if p.get("id") != provider_id]
    found = len(data["llm_providers"]) < before
    if found:
        bindings = data.get("llm_bindings") or {}
        for k in list(bindings.keys()):
            if bindings[k] == provider_id:
                del bindings[k]
        data["llm_bindings"] = bindings
        save_admin_settings(data)
        return True
    return False


def set_llm_bindings(
    channel_bot: str | None = None,
    system_llm: str | None = None,
    log_analyze: str | None = None,
    qa_summarize: str | None = None,
    orchestrator: str | None = None,
) -> None:
    """更新功能绑定；传空串表示取消绑定。"""
    data = load_admin_settings()
    _ensure_llm_structures(data)
    bindings = data.get("llm_bindings") or {}
    if channel_bot is not None:
        bindings["channel_bot"] = (channel_bot or "").strip() or ""
    if system_llm is not None:
        bindings["system_llm"] = (system_llm or "").strip() or ""
    if log_analyze is not None:
        bindings["log_analyze"] = (log_analyze or "").strip() or ""
    if qa_summarize is not None:
        bindings["qa_summarize"] = (qa_summarize or "").strip() or ""
    if orchestrator is not None:
        bindings["orchestrator"] = (orchestrator or "").strip() or ""
    data["llm_bindings"] = {k: v for k, v in bindings.items() if v}
    save_admin_settings(data)


# ---------- 兼容旧版：无 provider 时仍可从扁平键读取 ----------


def get_effective_llm_value(env_value: str, key: str) -> str:
    """兼容旧版：获取单项 LLM 配置（admin 文件优先，否则 env）。"""
    overrides = load_admin_settings()
    if key in overrides and overrides[key] is not None:
        return str(overrides[key]).strip()
    return (env_value or "").strip()


def get_effective_llm_number(env_value: float | int, key: str, default: float | int) -> float | int:
    """兼容旧版：获取单项数值配置。"""
    overrides = load_admin_settings()
    if key in overrides and overrides[key] is not None:
        try:
            return float(overrides[key]) if isinstance(env_value, float) else int(overrides[key])
        except (TypeError, ValueError):
            pass
    return env_value if env_value is not None else default


def get_clarify_settings() -> dict[str, Any]:
    """获取澄清策略配置（含默认值，且做范围兜底）。"""
    data = load_admin_settings()
    _ensure_clarify_settings(data)
    threshold = data.get("clarify_threshold", DEFAULT_CLARIFY_SETTINGS["clarify_threshold"])
    try:
        threshold_f = float(threshold)
    except (TypeError, ValueError):
        threshold_f = float(DEFAULT_CLARIFY_SETTINGS["clarify_threshold"])
    threshold_f = max(0.0, min(1.0, threshold_f))
    return {
        "clarify_strict_mode": bool(data.get("clarify_strict_mode", DEFAULT_CLARIFY_SETTINGS["clarify_strict_mode"])),
        "clarify_force_rule": bool(data.get("clarify_force_rule", DEFAULT_CLARIFY_SETTINGS["clarify_force_rule"])),
        "clarify_threshold": threshold_f,
    }


def set_clarify_settings(
    clarify_strict_mode: bool | None = None,
    clarify_force_rule: bool | None = None,
    clarify_threshold: float | None = None,
) -> dict[str, Any]:
    """更新澄清策略配置并返回最新值。"""
    data = load_admin_settings()
    _ensure_clarify_settings(data)
    if clarify_strict_mode is not None:
        data["clarify_strict_mode"] = bool(clarify_strict_mode)
    if clarify_force_rule is not None:
        data["clarify_force_rule"] = bool(clarify_force_rule)
    if clarify_threshold is not None:
        try:
            t = float(clarify_threshold)
        except (TypeError, ValueError):
            t = float(DEFAULT_CLARIFY_SETTINGS["clarify_threshold"])
        data["clarify_threshold"] = max(0.0, min(1.0, t))
    save_admin_settings(data)
    return get_clarify_settings()


def get_orchestrator_settings() -> dict[str, Any]:
    """获取 Orchestrator 配置（直接回答、自动接手）。"""
    data = load_admin_settings()
    _ensure_orchestrator_settings(data)
    return {
        "orchestrator_direct_answer": bool(data.get("orchestrator_direct_answer", False)),
        "orchestrator_auto_takeover": bool(data.get("orchestrator_auto_takeover", False)),
    }


def set_orchestrator_settings(
    orchestrator_direct_answer: bool | None = None,
    orchestrator_auto_takeover: bool | None = None,
) -> dict[str, Any]:
    """更新 Orchestrator 配置并返回最新值。"""
    data = load_admin_settings()
    _ensure_orchestrator_settings(data)
    if orchestrator_direct_answer is not None:
        data["orchestrator_direct_answer"] = bool(orchestrator_direct_answer)
    if orchestrator_auto_takeover is not None:
        data["orchestrator_auto_takeover"] = bool(orchestrator_auto_takeover)
    save_admin_settings(data)
    return get_orchestrator_settings()


# ---------- 图片 API 设置 ----------


def get_image_gen_settings() -> dict[str, Any]:
    """返回图片 API 设置（api_key 脱敏）。"""
    data = load_admin_settings()
    raw = data.get("image_gen", {})
    return {
        "base_url": raw.get("base_url", ""),
        "api_key_set": bool(raw.get("api_key")),
        "api_key_masked": ("****" + raw["api_key"][-6:]) if raw.get("api_key") and len(raw["api_key"]) > 6 else ("****" if raw.get("api_key") else ""),
        "default_model": raw.get("default_model", "qwen-image-edit-max"),
    }


def get_image_gen_effective_config() -> tuple[str, str, str]:
    """返回生效的 (base_url, api_key, default_model)，admin 设置优先于 env。"""
    data = load_admin_settings()
    admin = data.get("image_gen", {})
    base_url = (admin.get("base_url") or "").strip() or settings.image_gen_base_url
    api_key = (admin.get("api_key") or "").strip() or settings.image_gen_api_key
    default_model = (admin.get("default_model") or "").strip() or settings.image_gen_default_model
    return base_url, api_key, default_model


def set_image_gen_settings(
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    default_model: str | None = None,
) -> dict[str, Any]:
    """更新图片 API 设置并返回脱敏后的最新值。"""
    data = load_admin_settings()
    current = data.get("image_gen", {})
    if base_url is not None:
        current["base_url"] = base_url.strip()
    if api_key is not None:
        current["api_key"] = api_key.strip()
    if default_model is not None:
        current["default_model"] = default_model.strip()
    data["image_gen"] = current
    save_admin_settings(data)
    return get_image_gen_settings()
