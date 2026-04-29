"""Bot v1 路由."""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import BadRequestError, ConflictError, NotFoundError
from app.core.responses import APIResponse
from app.core.schemas import (
    BotCreate,
    BotInResponse,
    BotRegisterRequest,
    BotRegistrationRequestInResponse,
    BotSimpleInResponse,
    BotUpdate,
    OpenClawQuickConnect,
)
from app.db.models import AIModel, BotAccount, BotRegistrationRequest, PromptTemplate, User, gen_uuid
from app.services.bot_service import BotService
from app.services.openclaw_bridge.registry import bot_session_registry
from app.utils.crypto import encrypt_value

audit = logging.getLogger("app.audit")

router = APIRouter(prefix="/bots", tags=["bots"])

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\-'\u4e00-\u9fff]+$")


def _validate_username(username: str) -> None:
    if not username or not username.strip():
        raise BadRequestError("用户名不能为空")
    if not _USERNAME_RE.match(username.strip()):
        raise BadRequestError("用户名只能包含字母、数字、下划线、连字符、单引号和中文")


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
    if binding_type == "websocket":
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


def _to_simple(bot: BotAccount) -> dict:
    d = BotSimpleInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        status=bot.status,
        is_public=bot.is_public,
        binding_type=getattr(bot, "binding_type", None) or "http",
        **_connection_fields(bot),
        model_name=bot.ai_model.name if bot.ai_model else None,
        template_name=bot.prompt_template.name if bot.prompt_template else None,
        created_by=bot.created_by,
        created_at=bot.created_at,
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return d


def _to_full(
    bot: BotAccount,
    model_name: str | None = None,
    template_name: str | None = None,
    *,
    bot_token: str | None = None,
) -> dict:
    """转换 Bot 为响应体。

    bot_token 仅在 create / rotate 路径里传入，一次性返回给用户；
    其它路径永远不回显明文 token。
    """
    mn = model_name if model_name is not None else (bot.ai_model.name if bot.ai_model else None)
    tn = template_name if template_name is not None else (bot.prompt_template.name if bot.prompt_template else None)
    d = BotInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        avatar_url=bot.avatar_url,
        status=bot.status,
        is_public=bot.is_public,
        intro=bot.intro,
        custom_system_prompt=bot.custom_system_prompt,
        created_at=bot.created_at,
        model_id=bot.model_id,
        template_id=bot.template_id,
        model_name=mn,
        template_name=tn,
        created_by=bot.created_by,
        binding_type=getattr(bot, "binding_type", None) or "http",
        binding_config=getattr(bot, "binding_config", None),
        bot_token_prefix=getattr(bot, "bot_token_prefix", None),
        bot_token_rotated_at=getattr(bot, "bot_token_rotated_at", None),
        bot_token=bot_token,
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
    return APIResponse.ok([_to_simple(b) for b in bots])


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
        is_public=body.is_public,
        bot_id=body.bot_id,
        binding_type=body.binding_type,
        binding_config=body.binding_config,
        current_user=current_user,
    )
    audit.info("action=bot.create actor=%s resource_id=%s username=%s", current_user.user_id, bot.bot_id, body.username)
    if plaintext_token:
        audit.info("action=bot.token.issue actor=%s resource_id=%s", current_user.user_id, bot.bot_id)
    bot = await svc.get_or_404(bot.bot_id)
    return APIResponse.ok(_to_full(bot, bot_token=plaintext_token))


@router.post("/{bot_id}/rotate-token", response_model=APIResponse[dict])
async def rotate_bot_token(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """为 WebSocket Bot 轮换 token。旧 token 立即失效。

    响应里一次性返回明文 bot_token，请求方必须立刻保存；后续接口只回前缀。
    权限：Bot 创建者 或 system_admin。
    """
    svc = BotService(session)
    bot, plaintext_token = await svc.rotate_websocket_token(bot_id, current_user)
    audit.info("action=bot.token.rotate actor=%s resource_id=%s", current_user.user_id, bot.bot_id)
    bot = await svc.get_or_404(bot.bot_id)
    return APIResponse.ok(_to_full(bot, bot_token=plaintext_token))


@router.get("/registration-requests", response_model=APIResponse[list[dict]])
async def list_registration_requests(
    status: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    q = select(BotRegistrationRequest).order_by(BotRegistrationRequest.requested_at.desc())
    if status:
        q = q.where(BotRegistrationRequest.status == status)
    result = await session.execute(q)
    items = []
    for row in result.scalars().all():
        d = BotRegistrationRequestInResponse.model_validate(row).model_dump()
        if row.requested_at:
            d["requested_at"] = row.requested_at.isoformat()
        if row.decided_at:
            d["decided_at"] = row.decided_at.isoformat()
        items.append(d)
    return APIResponse.ok(items)


@router.post("/register-request", response_model=APIResponse[dict])
async def submit_register_request(
    body: BotRegisterRequest,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    username = body.username.strip()
    existing = await session.execute(select(BotAccount).where(BotAccount.username == username))
    if existing.scalar_one_or_none():
        raise ConflictError("username 已被使用")
    pending = await session.execute(
        select(BotRegistrationRequest).where(
            BotRegistrationRequest.username == username,
            BotRegistrationRequest.status == "pending",
        )
    )
    if pending.scalar_one_or_none():
        raise ConflictError("该 username 已有待审核申请")
    intro_val = _validate_intro(body.intro) if body.intro else None
    if not intro_val:
        raise BadRequestError("注册须提供结构化自我介绍 intro")
    req = BotRegistrationRequest(
        request_id=gen_uuid(),
        username=username,
        display_name=body.display_name.strip() if body.display_name else None,
        openclaw_endpoint=body.openclaw_endpoint.strip(),
        intro=intro_val,
        status="pending",
    )
    session.add(req)
    await session.flush()
    return APIResponse.ok({"request_id": req.request_id, "message": "注册申请已提交，等待管理员审核。"})


@router.get("/{bot_id}/online-status", response_model=APIResponse[dict])
async def get_bot_online_status(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    return APIResponse.ok({
        "bot_id": bot.bot_id,
        "status": bot.status,
        "binding_type": getattr(bot, "binding_type", None) or "http",
        **_connection_fields(bot),
    })


@router.post("/registration-requests/{request_id}/reject", response_model=APIResponse[None])
async def reject_registration_request(
    request_id: str,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    result = await session.execute(
        select(BotRegistrationRequest).where(
            BotRegistrationRequest.request_id == request_id,
            BotRegistrationRequest.status == "pending",
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise NotFoundError("申请不存在或已处理")
    req.status = "rejected"
    req.decided_at = datetime.utcnow()
    await session.flush()
    return APIResponse.ok(None, message="已拒绝")


@router.post("/quick-connect", response_model=APIResponse[dict])
async def quick_connect_openclaw(
    body: OpenClawQuickConnect,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """快速连接 OpenClaw：自动创建模型+Bot，并探测其能力。"""
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
            user_template="{{message}}",
            variables=["message"],
            is_builtin=True,
        )
        session.add(template)
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

    bot = BotAccount(
        bot_id=gen_uuid(),
        username=bot_username,
        display_name=display_name,
        description=f"OpenClaw Agent: {agent_id} @ {base_url}",
        model_id=ai_model.model_id,
        template_id=template.template_id,
        status="online",
        is_public=False,
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
        "bot": _to_full(bot, ai_model.name, template.name),
        "probe": {"who_am_i": who_am_i, "skills": skills, "connected": probe_ok},
    })


@router.get("/{bot_id}", response_model=APIResponse[dict])
async def get_bot(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    bot = await svc.get_or_404(bot_id)
    return APIResponse.ok(_to_full(bot))


@router.put("/{bot_id}", response_model=APIResponse[dict])
async def update_bot(
    bot_id: str,
    body: BotUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = BotService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    bot = await svc.update(bot_id, current_user, **updates)
    audit.info("action=bot.update actor=%s resource_id=%s fields=%s", current_user.user_id, bot_id, list(updates.keys()))
    return APIResponse.ok(_to_full(bot))


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
