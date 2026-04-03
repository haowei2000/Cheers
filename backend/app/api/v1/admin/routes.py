"""Admin v1 路由（AIModel / PromptTemplate / 系统设置 / 日志 / 用户管理 / 健康检查）."""
from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.log_buffer import get_formatted_log_excerpt, get_recent_logs
from app.admin.settings_store import (
    SCOPES,
    create_llm_provider,
    delete_llm_provider,
    get_assist_settings,
    get_clarify_settings,
    get_llm_bindings,
    get_llm_providers_list,
    get_provider_for_scope,
    set_assist_settings,
    set_clarify_settings,
    set_llm_bindings,
    update_llm_provider,
)
from app.chat_core.schemas import (
    AIModelCreate, AIModelInResponse, AIModelUpdate,
    PromptTemplateCreate, PromptTemplateInResponse, PromptTemplateUpdate,
)
from app.core.dependencies import get_session, require_permission
from app.core.exceptions import BadRequestError, NotFoundError
from app.core.responses import APIResponse
from app.db.models import AIModel, PromptTemplate, User
from app.services.admin_service import AIModelService, PromptTemplateService
from app.utils.crypto import decrypt_value

logger = logging.getLogger("app.admin")

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
    return APIResponse.ok({"providers": get_llm_providers_list(), "bindings": get_llm_bindings()})


@router.post("/settings/llm/providers", response_model=APIResponse[dict])
async def post_llm_provider(body: LLMProviderBody) -> APIResponse:
    pid = create_llm_provider(
        name=body.name, base_url=body.base_url, model=body.model,
        api_key=body.api_key, temperature=body.temperature, max_tokens=body.max_tokens,
    )
    return APIResponse.ok({"id": pid, "providers": get_llm_providers_list()})


@router.put("/settings/llm/providers/{provider_id}", response_model=APIResponse[dict])
async def put_llm_provider(provider_id: str, body: LLMProviderBody) -> APIResponse:
    ok = update_llm_provider(
        provider_id, name=body.name, base_url=body.base_url, model=body.model,
        api_key=body.api_key, temperature=body.temperature, max_tokens=body.max_tokens,
    )
    if not ok:
        raise NotFoundError("LLM 不存在")
    return APIResponse.ok({"providers": get_llm_providers_list()})


@router.delete("/settings/llm/providers/{provider_id}", response_model=APIResponse[dict])
async def delete_llm_provider_route(provider_id: str) -> APIResponse:
    ok = delete_llm_provider(provider_id)
    if not ok:
        raise NotFoundError("LLM 不存在")
    return APIResponse.ok({"providers": get_llm_providers_list(), "bindings": get_llm_bindings()})


@router.put("/settings/llm/bindings", response_model=APIResponse[dict])
async def put_llm_bindings(body: LLMBindingsBody) -> APIResponse:
    set_llm_bindings(
        channel_bot=body.channel_bot, system_llm=body.system_llm,
        log_analyze=body.log_analyze, qa_summarize=body.qa_summarize,
        orchestrator=body.orchestrator,
    )
    return APIResponse.ok({"bindings": get_llm_bindings()})


@router.post("/settings/llm/bind", response_model=APIResponse[dict])
async def post_llm_bind(body: LLMBindBody) -> APIResponse:
    scope = (body.scope or "").strip()
    if scope not in SCOPES:
        raise BadRequestError("未知的 LLM 绑定范围")
    payload = {s: None for s in ("channel_bot", "system_llm", "log_analyze", "qa_summarize", "orchestrator")}
    payload[scope] = (body.provider_id or "").strip() or None
    set_llm_bindings(**payload)
    return APIResponse.ok({"bindings": get_llm_bindings()})


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
    return APIResponse.ok(get_clarify_settings())


@router.put("/settings/clarify", response_model=APIResponse[dict])
async def put_clarify(body: ClarifySettingsBody) -> APIResponse:
    updated = set_clarify_settings(
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
    return APIResponse.ok(get_assist_settings())


@router.put("/settings/assist", response_model=APIResponse[dict])
async def put_assist(body: AssistSettingsBody) -> APIResponse:
    updated = set_assist_settings(
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
    c = get_provider_for_scope("log_analyze") or get_provider_for_scope("system_llm")
    if not c:
        raise BadRequestError("请先在管理页「LLM 参数」中添加 LLM 设定，并在「功能绑定」中为「日志分析」或「系统 LLM」选择 LLM。")
    base_url = (c.get("base_url") or "").strip()
    api_key = (c.get("api_key") or "").strip()
    model = (c.get("model") or "gpt-4o-mini").strip()
    if not base_url:
        raise BadRequestError("所选 LLM 的 Base URL 为空")
    log_text = (body.log_excerpt or "").strip() or get_formatted_log_excerpt(level="ERROR", limit=50)
    if not log_text:
        return APIResponse.ok({"analysis": "暂无错误日志可分析。"})
    user_content = f"以下是一段系统错误日志：\n\n{log_text}"
    if body.question.strip():
        user_content += f"\n\n用户问题：{body.question.strip()}"
    user_content += "\n\n请以运维助手身份分析：可能原因、建议排查步骤（简短分条）。"
    try:
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "你是运维与故障排查助手。根据错误日志给出可能原因和可操作的排查步骤，回答简洁、分条。"},
                {"role": "user", "content": user_content},
            ],
            "max_tokens": 1500,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return APIResponse.ok({"analysis": content.strip() or "无分析结果"})
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        detail = "LLM 返回 503（服务繁忙或模型加载中），请稍后重试。" if code == 503 else f"LLM 请求失败: {code}"
        from app.core.exceptions import AppError
        raise AppError(detail)
    except Exception as e:
        logger.exception("logs/analyze: %s", e)
        from app.core.exceptions import AppError
        raise AppError(f"分析失败: {e!s}")


@router.post("/qa/summarize", response_model=APIResponse[dict])
async def summarize_qa(body: QaSummarizeBody) -> APIResponse:
    if not body.pairs:
        raise BadRequestError("请至少提供一组问答")
    c = get_provider_for_scope("qa_summarize") or get_provider_for_scope("system_llm")
    if not c:
        raise BadRequestError("请先在管理页「LLM 参数」中添加 LLM 设定。")
    base_url = (c.get("base_url") or "").strip()
    api_key = (c.get("api_key") or "").strip()
    model = (c.get("model") or "gpt-4o-mini").strip()
    if not base_url:
        raise BadRequestError("所选 LLM 的 Base URL 为空")
    channel_name = (body.channel_name or "").strip() or "频道"
    lines: list[str] = []
    for idx, item in enumerate(body.pairs, start=1):
        lines.extend([
            f"## 问答 {idx}", f"问题时间: {item.question_time or '-'}", f"回答时间: {item.answer_time or '-'}",
            "", "### 问题", item.question.strip() or "-", "", "### 回答", item.answer.strip() or "-", "",
        ])
    qa_text = "\n".join(lines)
    prompt = (
        f"频道：{channel_name}\n共有 {len(body.pairs)} 组问答。\n\n"
        "请根据以下问答整理一份详细且结构化的 Markdown 文档，需包含：\n"
        "1) 背景与目标\n2) 关键问题与结论\n3) 详细步骤/方法\n4) 注意事项与风险\n5) 后续建议\n\n"
        f"问答原文：\n\n{qa_text}"
    )
    try:
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "你是资深技术文档整理助手，擅长将问答记录整理为清晰、完整、可执行的 Markdown 文档。"},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 2000,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        async with httpx.AsyncClient(timeout=90.0) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            return APIResponse.ok({"summary_markdown": content.strip() or "无总结结果"})
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        from app.core.exceptions import AppError
        raise AppError(f"LLM 请求失败: {code}")
    except Exception as e:
        logger.exception("qa/summarize: %s", e)
        from app.core.exceptions import AppError
        raise AppError(f"总结失败: {e!s}")


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
        from app.guide.llm_client import CONNECTION_503_BUSY, check_connection as guide_llm_check
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
