"""Admin v1 路由（AIModel / PromptTemplate / 系统设置 / 日志 / 用户管理 / 健康检查）."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.admin.log_buffer import get_formatted_log_excerpt, get_recent_logs
from app.core.schemas import (
    AIModelCreate, AIModelInResponse, AIModelUpdate,
    PromptTemplateCreate, PromptTemplateInResponse, PromptTemplateUpdate,
)
from app.core.dependencies import get_session, require_permission
from app.core.exceptions import BadRequestError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import AIModel, PromptTemplate, User
from app.services.admin_service import (
    AIModelService, LogAnalysisService, PromptTemplateService, SettingsService,
)
from app.utils.crypto import decrypt_value

logger = logging.getLogger("app.services.admin")

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_permission("system_settings"))],
)

_model_router = APIRouter(prefix="/models")
_template_router = APIRouter(prefix="/templates")


def _model_out(m: AIModel) -> dict:
    d = AIModelInResponse.model_validate(m).model_dump()
    if m.created_at:
        d["created_at"] = m.created_at.isoformat()
    raw_key = m.api_key or ""
    if raw_key:
        try:
            raw_key = decrypt_value(raw_key)
        except Exception:
            pass
    d["api_key_masked"] = ("****" + raw_key[-4:]) if len(raw_key) > 4 else ("****" if raw_key else None)
    return d


def _template_out(t: PromptTemplate) -> dict:
    d = PromptTemplateInResponse.model_validate(t).model_dump()
    if t.created_at:
        d["created_at"] = t.created_at.isoformat()
    return d


# ---- AIModel routes ----

@_model_router.get("", response_model=APIResponse[list[dict]])
async def list_models(session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = AIModelService(session)
    return APIResponse.ok([_model_out(m) for m in await svc.list_all()])


@_model_router.get("/{model_id}", response_model=APIResponse[dict])
async def get_model(model_id: str, session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = AIModelService(session)
    model = await svc.get_or_404(model_id)
    return APIResponse.ok(_model_out(model))


@_model_router.post("", response_model=APIResponse[dict])
async def create_model(
    body: AIModelCreate,
    current_user: User = Depends(require_permission("system_settings")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.utils.crypto import encrypt_value
    svc = AIModelService(session)
    api_key = encrypt_value(body.api_key) if body.api_key else None
    model = await svc.create(
        name=body.name,
        provider=body.provider,
        model_name=body.model_name,
        base_url=body.base_url,
        api_key=api_key,
        description=body.description,
        is_public=body.is_public,
        config=body.config,
        created_by=current_user.user_id,
    )
    return APIResponse.ok(_model_out(model))


@_model_router.patch("/{model_id}", response_model=APIResponse[dict])
async def update_model(
    model_id: str,
    body: AIModelUpdate,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AIModelService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "api_key" in updates and updates["api_key"]:
        from app.utils.crypto import encrypt_value
        updates["api_key"] = encrypt_value(updates["api_key"])
    model = await svc.update(model_id, **updates)
    return APIResponse.ok(_model_out(model))


@_model_router.delete("/{model_id}", response_model=APIResponse[None])
async def delete_model(model_id: str, session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = AIModelService(session)
    await svc.delete(model_id)
    return APIResponse.ok(None)


# ---- PromptTemplate routes ----

@_template_router.get("", response_model=APIResponse[list[dict]])
async def list_templates(session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = PromptTemplateService(session)
    return APIResponse.ok([_template_out(t) for t in await svc.list_all()])


@_template_router.get("/{template_id}", response_model=APIResponse[dict])
async def get_template(template_id: str, session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = PromptTemplateService(session)
    tmpl = await svc.get_or_404(template_id)
    return APIResponse.ok(_template_out(tmpl))


@_template_router.post("", response_model=APIResponse[dict])
async def create_template(
    body: PromptTemplateCreate,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    tmpl = await svc.create(
        name=body.name,
        system_prompt=body.system_prompt,
        user_template=body.user_template,
        description=body.description,
        variables=body.variables,
    )
    return APIResponse.ok(_template_out(tmpl))


@_template_router.patch("/{template_id}", response_model=APIResponse[dict])
async def update_template(
    template_id: str,
    body: PromptTemplateUpdate,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    tmpl = await svc.update(template_id, **updates)
    return APIResponse.ok(_template_out(tmpl))


@_template_router.delete("/{template_id}", response_model=APIResponse[None])
async def delete_template(
    template_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    await svc.delete(template_id)
    return APIResponse.ok(None)


router.include_router(_model_router)
router.include_router(_template_router)


# ---- LLM 设置 ----

class LLMProviderBody(BaseModel):
    name: str = ""
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    temperature: float = 0.7
    max_tokens: int = 1000


class LLMBindingsBody(BaseModel):
    channel_bot: str | None = None
    system_llm: str | None = None
    log_analyze: str | None = None
    qa_summarize: str | None = None
    orchestrator: str | None = None


class LLMBindBody(BaseModel):
    scope: str
    provider_id: str = ""


@router.get("/settings/llm", response_model=APIResponse[dict])
async def get_llm_settings() -> APIResponse:
    return APIResponse.ok(SettingsService.get_llm_settings())


@router.post("/settings/llm/providers", response_model=APIResponse[dict])
async def post_llm_provider(body: LLMProviderBody) -> APIResponse:
    pid = SettingsService.create_llm_provider(
        name=body.name, base_url=body.base_url, model=body.model,
        api_key=body.api_key, temperature=body.temperature, max_tokens=body.max_tokens,
    )
    return APIResponse.ok({"id": pid, "providers": SettingsService.get_llm_settings()["providers"]})


@router.put("/settings/llm/providers/{provider_id}", response_model=APIResponse[dict])
async def put_llm_provider(provider_id: str, body: LLMProviderBody) -> APIResponse:
    ok = SettingsService.update_llm_provider(
        provider_id, name=body.name, base_url=body.base_url, model=body.model,
        api_key=body.api_key, temperature=body.temperature, max_tokens=body.max_tokens,
    )
    if not ok:
        raise NotFoundError("LLM 不存在")
    return APIResponse.ok({"providers": SettingsService.get_llm_settings()["providers"]})


@router.delete("/settings/llm/providers/{provider_id}", response_model=APIResponse[dict])
async def delete_llm_provider_route(provider_id: str) -> APIResponse:
    ok = SettingsService.delete_llm_provider(provider_id)
    if not ok:
        raise NotFoundError("LLM 不存在")
    settings = SettingsService.get_llm_settings()
    return APIResponse.ok({"providers": settings["providers"], "bindings": settings["bindings"]})


@router.put("/settings/llm/bindings", response_model=APIResponse[dict])
async def put_llm_bindings(body: LLMBindingsBody) -> APIResponse:
    SettingsService.set_llm_bindings(
        channel_bot=body.channel_bot, system_llm=body.system_llm,
        log_analyze=body.log_analyze, qa_summarize=body.qa_summarize,
        orchestrator=body.orchestrator,
    )
    return APIResponse.ok({"bindings": SettingsService.get_llm_settings()["bindings"]})


@router.post("/settings/llm/bind", response_model=APIResponse[dict])
async def post_llm_bind(body: LLMBindBody) -> APIResponse:
    scope = (body.scope or "").strip()
    from app.services.admin.settings_store import SCOPES
    if scope not in SCOPES:
        raise BadRequestError("未知的 LLM 绑定范围")
    payload = {s: None for s in ("channel_bot", "system_llm", "log_analyze", "qa_summarize", "orchestrator")}
    payload[scope] = (body.provider_id or "").strip() or None
    SettingsService.set_llm_bindings(**payload)
    return APIResponse.ok({"bindings": SettingsService.get_llm_settings()["bindings"]})


# ---- 澄清/辅助设置 ----

class ClarifySettingsBody(BaseModel):
    clarify_strict_mode: bool | None = None
    clarify_force_rule: bool | None = None
    clarify_threshold: float | None = None


class AssistSettingsBody(BaseModel):
    llm_provider_id: str | None = None
    auto_takeover: bool | None = None


@router.get("/settings/clarify", response_model=APIResponse[dict])
async def get_clarify() -> APIResponse:
    return APIResponse.ok(SettingsService.get_clarify_settings())


@router.put("/settings/clarify", response_model=APIResponse[dict])
async def put_clarify(body: ClarifySettingsBody) -> APIResponse:
    updated = SettingsService.set_clarify_settings(
        clarify_strict_mode=body.clarify_strict_mode,
        clarify_force_rule=body.clarify_force_rule,
        clarify_threshold=body.clarify_threshold,
    )
    return APIResponse.ok(updated)


@router.post("/settings/clarify", response_model=APIResponse[dict])
async def post_clarify(body: ClarifySettingsBody) -> APIResponse:
    return await put_clarify(body)


@router.get("/settings/assist", response_model=APIResponse[dict])
async def get_assist() -> APIResponse:
    return APIResponse.ok(SettingsService.get_assist_settings())


@router.put("/settings/assist", response_model=APIResponse[dict])
async def put_assist(body: AssistSettingsBody) -> APIResponse:
    updated = SettingsService.set_assist_settings(
        llm_provider_id=body.llm_provider_id,
        auto_takeover=body.auto_takeover,
    )
    return APIResponse.ok(updated)


# ---- 日志 ----

class LogAnalyzeBody(BaseModel):
    log_excerpt: str = ""
    question: str = ""


class QaPairItem(BaseModel):
    question: str = ""
    answer: str = ""
    question_time: str = ""
    answer_time: str = ""


class QaSummarizeBody(BaseModel):
    channel_name: str = ""
    pairs: list[QaPairItem] = []


@router.get("/logs", response_model=APIResponse[dict])
async def admin_logs(level: str | None = None, limit: int = 200) -> APIResponse:
    entries = get_recent_logs(level=level, limit=limit)
    return APIResponse.ok({
        "entries": entries,
        "formatted_excerpt": get_formatted_log_excerpt(level=level, limit=limit),
    })


@router.post("/logs/analyze", response_model=APIResponse[dict])
async def analyze_logs(body: LogAnalyzeBody) -> APIResponse:
    content = await LogAnalysisService.analyze_logs(
        log_excerpt=body.log_excerpt,
        question=body.question,
    )
    return APIResponse.ok({"analysis": content})


@router.post("/qa/summarize", response_model=APIResponse[dict])
async def summarize_qa(body: QaSummarizeBody) -> APIResponse:
    content = await LogAnalysisService.summarize_qa(
        channel_name=body.channel_name,
        pairs=[p.model_dump() for p in body.pairs],
    )
    return APIResponse.ok({"summary_markdown": content})


# ---- 用户列表 ----

@router.get("/users", response_model=APIResponse[list[dict]])
async def admin_list_users(session: AsyncSession = Depends(get_session)) -> APIResponse:
    from app.services.auth_service import AuthService

    def _user_info(u: User) -> dict:
        return {
            "user_id": u.user_id,
            "username": u.username,
            "email": u.email,
            "display_name": u.display_name,
            "role": u.role,
            "avatar_url": u.avatar_url,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "bio": getattr(u, "bio", None),
        }

    svc = AuthService(session)
    users = await svc.list_users()
    return APIResponse.ok([_user_info(u) for u in users])


# ---- 健康检查 ----

async def _health_database_async() -> str:
    try:
        from sqlalchemy import text
        from app.db.session import async_engine
        async with async_engine.connect() as conn:
            await asyncio.wait_for(conn.execute(text("SELECT 1")), timeout=5.0)
        return "ok"
    except asyncio.TimeoutError:
        return "error: timeout"
    except Exception as e:
        return f"error: {e!s}"


def _health_redis_sync() -> str:
    try:
        import redis
        from app.config import settings
        r = redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2)
        r.ping()
        return "ok"
    except Exception:
        return "optional_unavailable"


async def _health_guide_llm_async() -> str:
    try:
        from app.services.guide.llm_client import CONNECTION_503_BUSY, check_connection as guide_llm_check
        ok, msg = await guide_llm_check()
        if ok:
            return "degraded (503)" if msg == CONNECTION_503_BUSY else "ok"
        if msg == "not_configured":
            return "not_configured"
        return f"unavailable ({msg})" if msg else "error: unknown"
    except Exception as e:
        return f"error: {e!s}"


@router.get("/health", response_model=APIResponse[dict])
async def admin_health() -> APIResponse:
    status = {"database": "unknown", "redis": "unknown", "guide_llm": "unknown"}

    async def redis_check() -> str:
        try:
            return await asyncio.wait_for(asyncio.to_thread(_health_redis_sync), timeout=3.0)
        except asyncio.TimeoutError:
            return "timeout"
        except Exception:
            return "optional_unavailable"

    status["database"], status["redis"], status["guide_llm"] = await asyncio.gather(
        _health_database_async(), redis_check(), _health_guide_llm_async()
    )
    return APIResponse.ok(status)
