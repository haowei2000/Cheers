"""Bots API routes."""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import BadRequestError, ForbiddenError
from app.core.prompt_templates import DEFAULT_TEMPLATE_VARIABLES, DEFAULT_USER_TEMPLATE
from app.core.responses import APIResponse
from app.core.schemas import (
    BotCreate,
    BotInResponse,
    BotOwnerInResponse,
    BotSimpleInResponse,
    BotUpdate,
    OpenClawQuickConnect,
)
from app.db.models import AgentNexusSession, AIModel, BotAccount, PromptTemplate, User, gen_uuid
from app.features.agent_bridge.registry import bot_session_registry
from app.features.agent_bridge.session_map import SESSION_STATUS_CLOSED
from app.features.agent_bridge.session_queries import (
    list_sessions_for_bot,
    serialize_session,
)
from app.features.bot_runtime.adapters.builtin_registry import get_builtin_adapter
from app.features.bot_runtime.adapters.http_bot import HttpBotAdapter
from app.services.bot_service import (
    BotService,
    bot_scope,
    can_manage_bot,
    is_builtin_bot,
    normalize_bot_scope,
)
from app.utils.crypto import encrypt_value

audit = logging.getLogger("app.audit")
logger = logging.getLogger("app.api.v1.bots")

router = APIRouter(prefix="/bots", tags=["bots"])

_USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_CONNECTOR_CONTROL_KEY = "connector_control"
_CONNECTOR_CONTROL_TIMEOUT_MIN_MS = 5_000
_CONNECTOR_CONTROL_TIMEOUT_MAX_MS = 3_600_000


class ConnectorControlSettingsIn(BaseModel):
    agentnexusApprovalMode: Literal["ask", "reject", "allow", "cancel"] | None = Field(default=None)
    agentNativePermissionMode: str | None = Field(default=None, min_length=1, max_length=64)
    # Legacy alias accepted from older clients; persisted as agentnexusApprovalMode.
    permissionMode: Literal["ask", "reject", "allow", "cancel"] | None = Field(default=None)
    requestTimeoutMs: int | None = Field(
        default=None,
        ge=_CONNECTOR_CONTROL_TIMEOUT_MIN_MS,
        le=_CONNECTOR_CONTROL_TIMEOUT_MAX_MS,
    )
    promptTimeoutMs: int | None = Field(
        default=None,
        ge=_CONNECTOR_CONTROL_TIMEOUT_MIN_MS,
        le=_CONNECTOR_CONTROL_TIMEOUT_MAX_MS,
    )
    cwd: str | None = Field(default=None, min_length=1, max_length=1024)
    model: str | None = Field(default=None, min_length=1, max_length=128)
    configOptions: dict[str, str] | None = Field(default=None)


class ConnectorControlUpdateIn(BaseModel):
    settings: ConnectorControlSettingsIn


class ConnectorAcpOptionSetIn(BaseModel):
    sessionId: str | None = Field(default=None, min_length=1, max_length=256)
    providerSessionKey: str | None = Field(default=None, min_length=1, max_length=1024)
    configId: str = Field(min_length=1, max_length=256)
    value: str = Field(min_length=1, max_length=512)


def _validate_username(username: str) -> None:
    if not username or not username.strip():
        raise BadRequestError("用户名不能为空")
    if not _USERNAME_RE.match(username.strip()):
        raise BadRequestError("Bot @ ID 只能使用小写英文字母、数字、下划线和连字符，且必须以小写字母开头")


def _validate_intro(intro: str | None) -> str | None:
    if not intro or not intro.strip():
        return None
    s = intro.strip()
    try:
        obj = json.loads(s)
        if not isinstance(obj, dict):
            raise ValueError("intro 须为 JSON 对象")
        if "capabilities" not in obj and "description" not in obj:
            raise ValueError("intro 须包含 capabilities 或 description")
        return json.dumps(obj, ensure_ascii=False)
    except json.JSONDecodeError as e:
        raise BadRequestError(f"intro 须为合法 JSON: {e}")
    except ValueError as e:
        raise BadRequestError(str(e))


def _connection_fields(bot: BotAccount) -> dict:
    binding_type = getattr(bot, "binding_type", None) or "http"
    configured_online = bot.status != "offline"
    if binding_type == "agent_bridge":
        state = bot_session_registry.connection_state(bot.bot_id)
        return {
            **state,
            "is_online": bool(configured_online and state["is_online"]),
        }
    return {
        "connection_status": "not_required",
        "is_online": configured_online,
        "control_connected": None,
        "data_connected": None,
    }


def _connector_control_from_binding_config(binding_config: dict | None) -> dict:
    if not isinstance(binding_config, dict):
        return {}
    control = binding_config.get(_CONNECTOR_CONTROL_KEY)
    return control if isinstance(control, dict) else {}


def _connector_control_settings_from_binding_config(binding_config: dict | None) -> dict:
    control = _connector_control_from_binding_config(binding_config)
    settings = control.get("settings")
    return _normalize_connector_control_settings(dict(settings)) if isinstance(settings, dict) else {}


def _normalize_connector_control_settings(settings: dict) -> dict:
    normalized = dict(settings)
    legacy_permission_mode = normalized.pop("permissionMode", None)
    if "agentnexusApprovalMode" not in normalized and legacy_permission_mode in {"ask", "reject", "allow", "cancel"}:
        normalized["agentnexusApprovalMode"] = legacy_permission_mode
    return normalized


def _next_connector_control_config(
    binding_config: dict | None,
    settings_update: dict,
) -> dict:
    cfg = dict(binding_config or {})
    existing = _connector_control_from_binding_config(cfg)
    settings = _connector_control_settings_from_binding_config(cfg)
    settings.update(_normalize_connector_control_settings(settings_update))
    revision = existing.get("revision")
    try:
        next_revision: int | str = int(revision or 0) + 1
    except (TypeError, ValueError):
        next_revision = f"{datetime.now(timezone.utc).timestamp():.6f}"
    control: dict = {
        "revision": next_revision,
        "settings": settings,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if isinstance(existing.get("last_status"), dict):
        control["last_status"] = existing["last_status"]
    if isinstance(existing.get("last_option_status"), dict):
        control["last_option_status"] = existing["last_option_status"]
    if isinstance(existing.get("options"), dict):
        control["options"] = existing["options"]
    cfg[_CONNECTOR_CONTROL_KEY] = control
    return cfg


def _next_connector_option_request_config(
    binding_config: dict | None,
    *,
    request_id: str,
    session_id: str | None,
    provider_session_key: str | None,
    config_id: str,
    value: str,
) -> dict:
    cfg = dict(binding_config or {})
    existing = _connector_control_from_binding_config(cfg)
    control = dict(existing)
    control["last_option_status"] = {
        "request_id": request_id,
        "session_id": session_id,
        "provider_session_key": provider_session_key,
        "config_id": config_id,
        "value": value,
        "ok": None,
        "status": "pending",
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }
    cfg[_CONNECTOR_CONTROL_KEY] = control
    return cfg


def _assert_can_test_bot(bot: BotAccount, current_user: User) -> None:
    if can_manage_bot(bot, current_user):
        return
    raise ForbiddenError("无权测试该 Bot")


async def _test_bot_connection(
    bot: BotAccount,
    *,
    model_override: AIModel | None = None,
    template_override: PromptTemplate | None = None,
) -> dict:
    binding_type = (getattr(bot, "binding_type", None) or "http").lower()
    model = model_override or bot.ai_model
    template = template_override or bot.prompt_template
    checked_at = datetime.now(timezone.utc).isoformat()
    started = time.perf_counter()
    base = {
        "bot_id": bot.bot_id,
        "status": bot.status,
        "binding_type": binding_type,
        "checked_at": checked_at,
        **_connection_fields(bot),
    }

    if bot.status == "offline":
        return {
            **base,
            "reachable": False,
            "duration_ms": 0,
            "message": "Bot 已停用，不会接收消息",
        }

    builtin_adapter = get_builtin_adapter(bot.bot_id)
    if builtin_adapter is not None:
        dependency_ready = await builtin_adapter.health_check()
        reachable = True
        return {
            **base,
            "adapter": type(builtin_adapter).__name__,
            "connection_status": "online",
            "is_online": True,
            "reachable": reachable,
            "dependency_ready": dependency_ready,
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "message": (
                "内置 Bot 可接收消息，依赖配置正常"
                if dependency_ready
                else "内置 Bot 可接收消息；LLM 依赖未配置或不可用，回答能力可能受限"
            ),
        }

    if binding_type == "agent_bridge":
        state = bot_session_registry.connection_state(bot.bot_id)
        reachable = bool(state["is_online"])
        return {
            **base,
            **state,
            "is_online": bool(bot.status != "offline" and state["is_online"]),
            "reachable": reachable,
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "message": "Agent Bridge control/data 均已连接" if reachable else "Agent Bridge Bot 未完整连接",
        }

    if not model:
        return {
            **base,
            "reachable": False,
            "duration_ms": 0,
            "message": "HTTP Bot 未配置模型",
        }
    if model.is_enabled is False:
        return {
            **base,
            "reachable": False,
            "duration_ms": 0,
            "message": "HTTP Bot 模型已禁用",
        }
    if not template:
        return {
            **base,
            "reachable": False,
            "duration_ms": 0,
            "message": "HTTP Bot 未配置提示词模板",
        }

    reachable = await HttpBotAdapter(
        bot,
        model_override=model_override,
        template_override=template_override,
    ).health_check()
    duration_ms = int((time.perf_counter() - started) * 1000)
    live_connection_status = "online" if reachable else "offline"
    logger.info(
        "bot.connection_test bot_id=%s binding=%s reachable=%s duration_ms=%s",
        bot.bot_id,
        binding_type,
        reachable,
        duration_ms,
    )
    return {
        **base,
        "connection_status": live_connection_status,
        "is_online": reachable,
        "reachable": reachable,
        "duration_ms": duration_ms,
        "message": "HTTP 模型 API 连通测试成功" if reachable else "HTTP 模型 API 连通测试失败",
    }


def _owner_payload(owner: User | None) -> BotOwnerInResponse | None:
    if not owner:
        return None
    return BotOwnerInResponse(
        user_id=owner.user_id,
        username=owner.username,
        display_name=owner.display_name,
    )


async def _load_owners(session: AsyncSession, bots: list[BotAccount]) -> dict[str, User]:
    owner_ids = {b.created_by for b in bots if b.created_by}
    if not owner_ids:
        return {}
    result = await session.execute(select(User).where(User.user_id.in_(owner_ids)))
    return {u.user_id: u for u in result.scalars().all()}


def _to_simple(
    bot: BotAccount,
    current_user: User,
    *,
    owner: User | None = None,
) -> dict:
    d = BotSimpleInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        avatar_url=bot.avatar_url,
        status=bot.status,
        scope=bot_scope(bot),
        binding_type=getattr(bot, "binding_type", None) or "http",
        is_builtin=is_builtin_bot(bot),
        **_connection_fields(bot),
        model_id=bot.model_id,
        template_id=bot.template_id,
        model_name=bot.ai_model.name if bot.ai_model else None,
        template_name=bot.prompt_template.name if bot.prompt_template else None,
        created_by=bot.created_by,
        owner=_owner_payload(owner),
        can_manage=can_manage_bot(bot, current_user),
        created_at=bot.created_at,
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    if can_manage_bot(bot, current_user):
        d["binding_config"] = getattr(bot, "binding_config", None)
    return d


def _to_full(
    bot: BotAccount,
    current_user: User,
    model_name: str | None = None,
    template_name: str | None = None,
    *,
    bot_token: str | None = None,
    owner: User | None = None,
) -> dict:
    """To full."""
    mn = model_name if model_name is not None else (bot.ai_model.name if bot.ai_model else None)
    tn = template_name if template_name is not None else (bot.prompt_template.name if bot.prompt_template else None)
    d = BotInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        avatar_url=bot.avatar_url,
        status=bot.status,
        scope=bot_scope(bot),
        intro=bot.intro,
        custom_system_prompt=bot.custom_system_prompt,
        created_at=bot.created_at,
        is_builtin=is_builtin_bot(bot),
        model_id=bot.model_id,
        template_id=bot.template_id,
        model_name=mn,
        template_name=tn,
        created_by=bot.created_by,
        binding_type=getattr(bot, "binding_type", None) or "http",
        bridge_provider=getattr(bot, "bridge_provider", None) or "generic",
        binding_config=getattr(bot, "binding_config", None),
        bot_token_prefix=getattr(bot, "bot_token_prefix", None),
        bot_token_rotated_at=getattr(bot, "bot_token_rotated_at", None),
        bot_token=bot_token,
        owner=_owner_payload(owner),
        can_manage=can_manage_bot(bot, current_user),
        **_connection_fields(bot),
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    rotated = getattr(bot, "bot_token_rotated_at", None)
    if rotated:
        d["bot_token_rotated_at"] = rotated.isoformat()
    return d


@router.get("", response_model=APIResponse[list[dict]])
async def list_bots(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bots = await svc.list_visible(current_user)
    owners = await _load_owners(session, bots)
    return APIResponse.ok([
        _to_simple(b, current_user, owner=owners.get(b.created_by or ""))
        for b in bots
    ])


@router.post("", response_model=APIResponse[dict])
async def create_bot(
    body: BotCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot, plaintext_token = await svc.create(
        username=body.username,
        display_name=body.display_name,
        description=body.description,
        model_id=body.model_id,
        template_id=body.template_id,
        custom_system_prompt=body.custom_system_prompt,
        intro=body.intro,
        avatar_url=body.avatar_url,
        scope=body.scope,
        bot_id=body.bot_id,
        binding_type=body.binding_type,
        bridge_provider=body.bridge_provider,
        binding_config=body.binding_config,
        current_user=current_user,
    )
    audit.info("action=bot.create actor=%s resource_id=%s username=%s", current_user.user_id, bot.bot_id, body.username)
    if plaintext_token:
        audit.info("action=bot.token.issue actor=%s resource_id=%s", current_user.user_id, bot.bot_id)
    bot = await svc.get_or_404(bot.bot_id)
    owner = await session.get(User, bot.created_by) if bot.created_by else None
    return APIResponse.ok(_to_full(bot, current_user, bot_token=plaintext_token, owner=owner))


@router.post("/{bot_id}/rotate-token", response_model=APIResponse[dict])
async def rotate_bot_token(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Rotate bot token."""
    svc = BotService(session)
    bot, plaintext_token = await svc.rotate_agent_bridge_token(bot_id, current_user)
    audit.info("action=bot.token.rotate actor=%s resource_id=%s", current_user.user_id, bot.bot_id)
    bot = await svc.get_or_404(bot.bot_id)
    owner = await session.get(User, bot.created_by) if bot.created_by else None
    return APIResponse.ok(_to_full(bot, current_user, bot_token=plaintext_token, owner=owner))


@router.get("/{bot_id}/online-status", response_model=APIResponse[dict])
async def get_bot_online_status(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    await svc.assert_can_use(bot, current_user)
    binding_type = (getattr(bot, "binding_type", None) or "http").lower()
    base = {
        "bot_id": bot.bot_id,
        "status": bot.status,
        "scope": bot_scope(bot),
        "binding_type": binding_type,
    }
    if bot.status == "offline":
        return APIResponse.ok({
            **base,
            "connection_status": "offline",
            "is_online": False,
            "reachable": False,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "control_connected": None if binding_type == "http" else False,
            "data_connected": None if binding_type == "http" else False,
        })
    if binding_type == "http":
        builtin_adapter = get_builtin_adapter(bot.bot_id)
        if builtin_adapter is not None:
            dependency_ready = await builtin_adapter.health_check()
            return APIResponse.ok({
                **base,
                "adapter": type(builtin_adapter).__name__,
                "connection_status": "online",
                "is_online": True,
                "reachable": True,
                "dependency_ready": dependency_ready,
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "control_connected": None,
                "data_connected": None,
            })
        model = bot.ai_model or (await session.get(AIModel, bot.model_id) if bot.model_id else None)
        template = bot.prompt_template or (
            await session.get(PromptTemplate, bot.template_id) if bot.template_id else None
        )
        configured = bool(model and model.is_enabled is not False and template)
        reachable = bool(
            configured
            and await HttpBotAdapter(
                bot,
                model_override=model,
                template_override=template,
            ).health_check()
        )
        return APIResponse.ok({
            **base,
            "connection_status": "online" if reachable else "offline",
            "is_online": reachable,
            "reachable": reachable,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "control_connected": None,
            "data_connected": None,
        })
    return APIResponse.ok({
        **base,
        **_connection_fields(bot),
    })


@router.post("/{bot_id}/connection-test", response_model=APIResponse[dict])
async def test_bot_connection(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    _assert_can_test_bot(bot, current_user)
    model = bot.ai_model or (await session.get(AIModel, bot.model_id) if bot.model_id else None)
    template = bot.prompt_template or (
        await session.get(PromptTemplate, bot.template_id) if bot.template_id else None
    )
    return APIResponse.ok(
        await _test_bot_connection(
            bot,
            model_override=model,
            template_override=template,
        )
    )


@router.get("/{bot_id}/sessions", response_model=APIResponse[list[dict]])
async def list_bot_sessions(
    bot_id: str,
    include_closed: bool = Query(default=True),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    if not can_manage_bot(bot, current_user):
        raise ForbiddenError("无权查看该 Bot 的 session")
    sessions = await list_sessions_for_bot(session, bot_id=bot_id, include_closed=include_closed)
    return APIResponse.ok([serialize_session(row) for row in sessions])


@router.delete("/{bot_id}/sessions/{session_id}", response_model=APIResponse[dict])
async def close_bot_session(
    bot_id: str,
    session_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    if not can_manage_bot(bot, current_user):
        raise ForbiddenError("无权关闭该 Bot 的 session")
    row = (
        await session.execute(
            select(AgentNexusSession)
            .where(
                AgentNexusSession.bot_id == bot_id,
                AgentNexusSession.session_id == session_id,
            )
            .options(
                selectinload(AgentNexusSession.bindings),
                selectinload(AgentNexusSession.bot),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not row:
        from app.core.exceptions import NotFoundError

        raise NotFoundError("session not found")

    now = datetime.now(timezone.utc)
    metadata = dict(row.session_metadata or {})
    metadata.update({
        "closed_reason": "manual_close",
        "closed_by": current_user.user_id,
        "closed_at": now.isoformat(),
    })
    row.session_metadata = metadata
    row.status = SESSION_STATUS_CLOSED
    row.updated_at = now
    for binding in row.bindings or []:
        if binding.detached_at is None:
            binding.detached_at = now
            session.add(binding)
    session.add(row)
    await session.commit()
    await session.refresh(row, attribute_names=["bindings", "bot"])
    return APIResponse.ok(serialize_session(row))


@router.post("/quick-connect", response_model=APIResponse[dict])
async def quick_connect_openclaw(
    body: OpenClawQuickConnect,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Quick connect openclaw."""
    import httpx as _httpx

    base_url = body.url.strip().rstrip("/")
    if not base_url.endswith("/v1"):
        base_url = base_url + "/v1"
    agent_id = (body.agent_id or "main").strip()

    raw_username = body.bot_username.strip() if body.bot_username else None
    if not raw_username:
        raw_username = "openclaw_" + re.sub(r"[^a-zA-Z0-9_\-]", "_", agent_id)

    bot_username = raw_username
    for suffix in range(1, 100):
        dup = await session.execute(select(BotAccount).where(BotAccount.username == bot_username))
        if not dup.scalar_one_or_none():
            break
        bot_username = f"{raw_username}_{suffix}"

    _validate_username(bot_username)
    display_name = (body.display_name or "").strip() or f"OpenClaw {agent_id}"

    probe_headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {body.token.strip()}",
        "x-openclaw-agent-id": agent_id,
    }

    async def _probe(message: str) -> str:
        try:
            async with _httpx.AsyncClient(timeout=30.0) as client:
                r = await client.post(
                    f"{base_url}/chat/completions",
                    json={"model": "openclaw", "messages": [{"role": "user", "content": message}], "max_tokens": 800, "temperature": 0.3},
                    headers=probe_headers,
                )
                r.raise_for_status()
                data = r.json()
                return data["choices"][0]["message"]["content"]
        except Exception as exc:
            return f"[探测失败: {exc}]"

    who_am_i = await _probe("你是谁")
    skills = await _probe("/skill")

    _PASSTHROUGH_TEMPLATE_NAME = "__openclaw_passthrough__"
    tmpl_q = await session.execute(select(PromptTemplate).where(PromptTemplate.name == _PASSTHROUGH_TEMPLATE_NAME))
    template = tmpl_q.scalar_one_or_none()
    if not template:
        template = PromptTemplate(
            template_id=gen_uuid(),
            name=_PASSTHROUGH_TEMPLATE_NAME,
            description="OpenClaw 直通模板（自动创建，勿删）",
            system_prompt="你是一个通过 OpenClaw 接入的 AI 助手，请直接响应用户请求。",
            user_template=DEFAULT_USER_TEMPLATE,
            variables=DEFAULT_TEMPLATE_VARIABLES,
            is_builtin=True,
            scope="everyone",
        )
        session.add(template)
        await session.flush()
    else:
        template_changed = False
        if template.user_template == "{{message}}":
            template.user_template = DEFAULT_USER_TEMPLATE
            template.variables = DEFAULT_TEMPLATE_VARIABLES
            template_changed = True
        if getattr(template, "scope", None) != "everyone":
            template.scope = "everyone"
            template_changed = True
        if template_changed:
            await session.flush()

    ai_model = AIModel(
        name=f"openclaw-{agent_id}",
        provider="openai",
        model_name="openclaw",
        base_url=base_url,
        api_key=encrypt_value(body.token.strip()),
        description=f"OpenClaw 快速接入 {base_url} (agent: {agent_id})",
        is_enabled=True,
        is_public=False,
        created_by=current_user.user_id,
        config={"extra_headers": {"x-openclaw-agent-id": agent_id}},
    )
    session.add(ai_model)
    await session.flush()

    probe_ok = not who_am_i.startswith("[探测失败")
    intro_dict: dict = {"description": who_am_i if probe_ok else f"OpenClaw Agent: {agent_id}"}
    if skills and not skills.startswith("[探测失败"):
        intro_dict["capabilities"] = skills
    intro_str = json.dumps(intro_dict, ensure_ascii=False)

    scope = normalize_bot_scope(body.scope or "private")
    bot = BotAccount(
        bot_id=gen_uuid(),
        username=bot_username,
        display_name=display_name,
        description=f"OpenClaw Agent: {agent_id} @ {base_url}",
        model_id=ai_model.model_id,
        template_id=template.template_id,
        status="online",
        scope=scope,
        intro=intro_str,
        created_by=current_user.user_id,
    )
    session.add(bot)
    await session.flush()

    if body.channel_id:
        from app.db.models import Channel, ChannelMembership
        ch_q = await session.execute(select(Channel).where(Channel.channel_id == body.channel_id))
        if ch_q.scalar_one_or_none():
            membership = ChannelMembership(
                channel_id=body.channel_id,
                member_id=bot.bot_id,
                member_type="bot",
                added_by=current_user.user_id,
            )
            session.add(membership)

    await session.flush()
    return APIResponse.ok({
        "bot": _to_full(bot, current_user, ai_model.name, template.name, owner=current_user),
        "probe": {"who_am_i": who_am_i, "skills": skills, "connected": probe_ok},
    })


@router.put("/{bot_id}/connector-control", response_model=APIResponse[dict])
async def update_bot_connector_control(
    bot_id: str,
    body: ConnectorControlUpdateIn,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Update the AgentNexus-managed live connector settings for an Agent Bridge Bot."""
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    if not can_manage_bot(bot, current_user):
        raise ForbiddenError("无权修改该 Bot")
    if (bot.binding_type or "http") != "agent_bridge":
        raise BadRequestError("只有 Agent Bridge Bot 支持 connector control")

    settings_update = body.settings.model_dump(exclude_none=True)
    if not settings_update:
        raise BadRequestError("connector control settings 不能为空")

    bot.binding_config = _next_connector_control_config(bot.binding_config, settings_update)
    session.add(bot)
    await session.flush()
    control = _connector_control_from_binding_config(bot.binding_config)
    frame = {
        "type": "config_update",
        "revision": control.get("revision"),
        "settings": control.get("settings") or {},
        "updated_at": control.get("updated_at"),
    }
    # Commit before notifying the live connector so a fast config_status ack
    # cannot race and overwrite uncommitted JSON state from another DB session.
    await session.commit()
    dispatched = await bot_session_registry.dispatch_control(bot.bot_id, frame)
    audit.info(
        "action=bot.connector_control.update actor=%s resource_id=%s fields=%s dispatched=%s",
        current_user.user_id,
        bot_id,
        list(settings_update.keys()),
        dispatched,
    )
    await session.refresh(bot)
    owner = await session.get(User, bot.created_by) if bot.created_by else None
    return APIResponse.ok({
        "bot": _to_full(bot, current_user, owner=owner),
        "connector_control": control,
        "dispatched": dispatched,
    })


@router.put("/{bot_id}/connector-control/acp-option", response_model=APIResponse[dict])
async def set_bot_connector_acp_option(
    bot_id: str,
    body: ConnectorAcpOptionSetIn,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """Set an ACP session configuration option through the live connector."""
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    if not can_manage_bot(bot, current_user):
        raise ForbiddenError("无权修改该 Bot")
    if (bot.binding_type or "http") != "agent_bridge":
        raise BadRequestError("只有 Agent Bridge Bot 支持 connector control")

    session_id = body.sessionId.strip() if body.sessionId else None
    provider_session_key = body.providerSessionKey.strip() if body.providerSessionKey else None
    if not session_id and not provider_session_key:
        raise BadRequestError("sessionId 或 providerSessionKey 至少需要一个")

    request_id = gen_uuid()
    config_id = body.configId.strip()
    value = body.value.strip()
    bot.binding_config = _next_connector_option_request_config(
        bot.binding_config,
        request_id=request_id,
        session_id=session_id,
        provider_session_key=provider_session_key,
        config_id=config_id,
        value=value,
    )
    session.add(bot)
    await session.flush()
    control = _connector_control_from_binding_config(bot.binding_config)
    frame = {
        "type": "config_option_set",
        "request_id": request_id,
        "session_id": session_id,
        "provider_session_key": provider_session_key,
        "config_id": config_id,
        "value": value,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await session.commit()
    dispatched = await bot_session_registry.dispatch_control(bot.bot_id, frame)
    audit.info(
        "action=bot.connector_control.acp_option_set actor=%s resource_id=%s config_id=%s dispatched=%s",
        current_user.user_id,
        bot_id,
        config_id,
        dispatched,
    )
    await session.refresh(bot)
    owner = await session.get(User, bot.created_by) if bot.created_by else None
    return APIResponse.ok({
        "bot": _to_full(bot, current_user, owner=owner),
        "connector_control": control,
        "dispatched": dispatched,
        "request_id": request_id,
    })


@router.get("/{bot_id}", response_model=APIResponse[dict])
async def get_bot(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    await svc.assert_can_use(bot, current_user)
    owner = await session.get(User, bot.created_by) if bot.created_by else None
    return APIResponse.ok(_to_full(bot, current_user, owner=owner))


@router.put("/{bot_id}", response_model=APIResponse[dict])
async def update_bot(
    bot_id: str,
    body: BotUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "avatar_url" in body.model_fields_set:
        updates["avatar_url"] = body.avatar_url
    bot = await svc.update(bot_id, current_user, **updates)
    audit.info("action=bot.update actor=%s resource_id=%s fields=%s", current_user.user_id, bot_id, list(updates.keys()))
    model = await session.get(AIModel, bot.model_id) if bot.model_id else None
    template = await session.get(PromptTemplate, bot.template_id) if bot.template_id else None
    return APIResponse.ok(
        _to_full(
            bot,
            current_user,
            model_name=model.name if model else None,
            template_name=template.name if template else None,
            owner=await session.get(User, bot.created_by) if bot.created_by else None,
        )
    )


@router.delete("/{bot_id}", response_model=APIResponse[None])
async def delete_bot(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    await svc.delete(bot_id, current_user)
    audit.info("action=bot.delete actor=%s resource_id=%s", current_user.user_id, bot_id)
    return APIResponse.ok(None)
