"""兼容读取历史管理配置：LLM 功能绑定、助手运行参数和图像生成配置。"""
import asyncio
import concurrent.futures
import json
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit, urlunsplit

from app.config import settings
from app.utils.crypto import decrypt_value

DEFAULT_ORCHESTRATOR_SETTINGS = {
    "orchestrator_auto_takeover": False,
    "child_bot_inherit_context": True,
}

AI_MODEL_PROVIDER_PREFIX = "ai-model:"

_SETTINGS_DB_KEY = "admin_settings"
# Legacy JSON path used only for one-time data migration.
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
                select(SystemSetting)
                .where(SystemSetting.key == _SETTINGS_DB_KEY)
                .with_for_update()
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
            return cast(list[dict[str, Any]], future.result(timeout=10))
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
    channel_bot 为频道内置助手的统一 scope，兼容旧版 assistant_bot / builtin_llm。
    """
    from app.config import settings

    data = load_admin_settings()
    _ensure_llm_structures(data)

    # channel_bot: unified scope for the channel assistant, compatible with legacy assistant_bot/builtin_llm.
    if scope in ("channel_bot", "assistant_bot"):
        # 1. Prefer legacy builtin_llm direct config for backward compatibility.
        builtin = data.get("builtin_llm", {})
        if builtin.get("base_url") or builtin.get("model"):
            return _normalize_provider_config(builtin)
        # 2. New channel_bot binding.
        bindings = data.get("llm_bindings") or {}
        pid = bindings.get("channel_bot")
        if pid:
            p = _get_provider_by_id(pid)
            if p:
                return _normalize_provider_config(p)
        # 3. Fall back to helper_llm_* environment variables.
        if settings.helper_llm_base_url and settings.helper_llm_model:
            return {
                "base_url": settings.helper_llm_base_url.rstrip("/"),
                "model": settings.helper_llm_model,
                "api_key": settings.helper_llm_api_key or None,
                "temperature": float(settings.helper_llm_temperature),
                "max_tokens": int(settings.helper_llm_max_tokens),
            }
        return None

    bindings = data.get("llm_bindings") or {}
    pid = bindings.get(scope)
    if pid:
        p = _get_provider_by_id(pid)
        if p:
            return _normalize_provider_config(p)
    return None


def get_assist_settings() -> dict[str, Any]:
    """获取系统助手配置（LLM 绑定 + 自动接管）。"""
    data = load_admin_settings()
    _ensure_orchestrator_settings(data)
    _ensure_llm_structures(data)
    bindings = data.get("llm_bindings") or {}
    return {
        "llm_provider_id": bindings.get("channel_bot") or "",
        "auto_takeover": bool(data.get("orchestrator_auto_takeover", False)),
        "child_bot_inherit_context": bool(data.get("child_bot_inherit_context", True)),
    }
