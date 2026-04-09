"""管理端 LLM 等参数持久化：一层 LLM 设定（增删改列表），二层功能绑定（按功能选 LLM）。"""
import asyncio
import concurrent.futures
import json
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.config import settings
from app.utils.crypto import decrypt_value, encrypt_value

SCOPES = ("channel_bot", "system_llm", "log_analyze", "qa_summarize", "orchestrator")
DEFAULT_CLARIFY_SETTINGS = {
    "clarify_strict_mode": False,
    "clarify_force_rule": True,
    "clarify_threshold": 0.6,
}

DEFAULT_ORCHESTRATOR_SETTINGS = {
    "orchestrator_auto_takeover": False,
}
DEFAULT_IMAGE_GEN_SETTINGS: dict[str, Any] = {
    "base_url": "",
    "api_key": "",
    "default_model": "qwen-image-edit-max",
}

AI_MODEL_PROVIDER_PREFIX = "ai-model:"

_SETTINGS_DB_KEY = "admin_settings"
# 旧 JSON 路径（仅用于一次性数据迁移）
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
_LEGACY_JSON_PATHS = [
    _BACKEND_ROOT / settings.data_dir / "admin_settings.json",
    _BACKEND_ROOT.parent / settings.data_dir / "admin_settings.json",
]


def _run_async(coro) -> Any:
    """在独立线程的新事件循环中运行协程，避免与 FastAPI 事件循环冲突。"""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(asyncio.run, coro).result(timeout=10)


def _make_engine():
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool
    return create_async_engine(settings.database_url, poolclass=NullPool, echo=False)


async def _load_settings_async() -> dict[str, Any]:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.db.models import SystemSetting

    engine = _make_engine()
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with factory() as session:
            row = (await session.execute(
                select(SystemSetting).where(SystemSetting.key == _SETTINGS_DB_KEY)
            )).scalar_one_or_none()
            return dict(row.value) if row and row.value else {}
    finally:
        await engine.dispose()


async def _save_settings_async(data: dict[str, Any]) -> None:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.db.models import SystemSetting

    engine = _make_engine()
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with factory() as session:
            row = (await session.execute(
                select(SystemSetting).where(SystemSetting.key == _SETTINGS_DB_KEY)
            )).scalar_one_or_none()
            if row:
                row.value = data
            else:
                session.add(SystemSetting(key=_SETTINGS_DB_KEY, value=data))
            await session.commit()
    finally:
        await engine.dispose()


def _migrate_from_json() -> dict[str, Any]:
    """读取旧 JSON 文件并写入 DB（仅首次）；读取失败则返回空 dict。"""
    for path in _LEGACY_JSON_PATHS:
        if path.is_file():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                _run_async(_save_settings_async(data))
                return data
            except Exception:
                pass
    return {}


def load_admin_settings() -> dict[str, Any]:
    """从 DB 读取管理端配置；若 DB 中不存在则尝试从旧 JSON 迁移。"""
    try:
        data = _run_async(_load_settings_async())
        if not data:
            data = _migrate_from_json()
        return data
    except Exception:
        return {}


def save_admin_settings(data: dict[str, Any]) -> None:
    """将管理端配置写入 DB。"""
    try:
        _run_async(_save_settings_async(data))
    except Exception:
        pass


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
    raw_key = (payload.get("api_key") or "").strip()
    normalized = {
        "base_url": _rewrite_localhost_base_url((payload.get("base_url") or "").strip()),
        "model": (payload.get("model") or "").strip(),
        "api_key": decrypt_value(raw_key),
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


async def _fetch_ai_models_async() -> list[dict[str, Any]]:
    """从数据库异步加载已启用的 AI 模型列表。在独立事件循环中运行，使用独立引擎。"""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.db.models import AIModel

    engine = create_async_engine(settings.database_url, poolclass=NullPool, echo=False)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with factory() as session:
            result = await session.execute(
                select(AIModel)
                .where(AIModel.is_enabled == True)  # noqa: E712
                .order_by(AIModel.created_at.desc(), AIModel.name.asc())
            )
            rows = result.scalars().all()
    finally:
        await engine.dispose()

    providers: list[dict[str, Any]] = []
    for row in rows:
        config = _parse_json_object(row.config)
        extra_headers = config.get("extra_headers")
        provider: dict[str, Any] = {
            "id": f"{AI_MODEL_PROVIDER_PREFIX}{row.model_id}",
            "model_id": row.model_id,
            "name": row.name or row.model_name or "未命名模型",
            "base_url": (row.base_url or "").strip(),
            "model": (row.model_name or "").strip(),
            "api_key": (row.api_key or "").strip(),
            "temperature": float(config.get("temperature", 0.7)),
            "max_tokens": int(config.get("max_tokens", 1000)),
            "source": "ai_model",
            "provider": (row.provider or "").strip(),
        }
        if isinstance(extra_headers, dict) and extra_headers:
            provider["extra_headers"] = extra_headers
        timeout = config.get("timeout")
        if timeout is not None:
            provider["timeout"] = timeout
        providers.append(provider)
    return providers


def _load_ai_model_providers() -> list[dict[str, Any]]:
    """同步包装器：在独立线程中运行异步查询，避免嵌套事件循环冲突。"""
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(asyncio.run, _fetch_ai_models_async())
            return future.result(timeout=10)
    except Exception:
        return []



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
        return None

    bindings = data.get("llm_bindings") or {}
    pid = bindings.get(scope)
    if pid:
        p = _get_provider_by_id(pid)
        if p:
            return _normalize_provider_config(p)
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
    plain_key = (api_key or "").strip()
    data["llm_providers"].append({
        "id": pid,
        "name": (name or "").strip() or "未命名",
        "base_url": (base_url or "").strip(),
        "model": (model or "").strip(),
        "api_key": encrypt_value(plain_key) if plain_key else "",
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
                p["api_key"] = encrypt_value(api_key.strip())
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


def get_assist_settings() -> dict[str, Any]:
    """获取系统助手配置（LLM 绑定 + 自动接管）。"""
    data = load_admin_settings()
    _ensure_orchestrator_settings(data)
    _ensure_llm_structures(data)
    bindings = data.get("llm_bindings") or {}
    return {
        "llm_provider_id": bindings.get("channel_bot") or bindings.get("guide_bot") or "",
        "auto_takeover": bool(data.get("orchestrator_auto_takeover", False)),
    }


def set_assist_settings(
    llm_provider_id: str | None = None,
    auto_takeover: bool | None = None,
) -> dict[str, Any]:
    """更新系统助手配置并返回最新值。"""
    data = load_admin_settings()
    _ensure_orchestrator_settings(data)
    _ensure_llm_structures(data)
    if llm_provider_id is not None:
        bindings = data.get("llm_bindings") or {}
        bindings["channel_bot"] = (llm_provider_id or "").strip()
        data["llm_bindings"] = bindings
    if auto_takeover is not None:
        data["orchestrator_auto_takeover"] = bool(auto_takeover)
    save_admin_settings(data)
    return get_assist_settings()


# ---------- 图片 API 设置 ----------


def get_image_gen_settings() -> dict[str, Any]:
    """返回图片 API 设置（api_key 脱敏）。"""
    data = load_admin_settings()
    raw = data.get("image_gen", {})
    plain_key = decrypt_value(raw.get("api_key") or "")
    return {
        "base_url": raw.get("base_url", ""),
        "api_key_set": bool(plain_key),
        "api_key_masked": ("****" + plain_key[-6:]) if plain_key and len(plain_key) > 6 else ("****" if plain_key else ""),
        "default_model": raw.get("default_model", "qwen-image-edit-max"),
    }


def get_image_gen_effective_config() -> tuple[str, str, str]:
    """返回生效的 (base_url, api_key, default_model)，admin 设置优先于 env。"""
    data = load_admin_settings()
    admin = data.get("image_gen", {})
    base_url = (admin.get("base_url") or "").strip() or settings.image_gen_base_url
    stored_key = decrypt_value((admin.get("api_key") or "").strip())
    api_key = stored_key or settings.image_gen_api_key
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
        plain = api_key.strip()
        current["api_key"] = encrypt_value(plain) if plain else ""
    if default_model is not None:
        current["default_model"] = default_model.strip()
    data["image_gen"] = current
    save_admin_settings(data)
    return get_image_gen_settings()
