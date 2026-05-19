"""Agent Bridge-facing public docs and onboarding endpoints.

These routes intentionally live under ``/docs/agent-bridge`` so a local
external provider can discover the AgentNexus integration contract from one
stable, public URL namespace. Bot creation still requires a logged-in user's
Bearer token or account/password credentials because it creates an account
owned by that user.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.exceptions import BadRequestError, UnauthorizedError
from app.core.responses import APIResponse
from app.db.models import User
from app.features.bot_runtime.adapters.help_catalog import HELP_ENTRIES, HelpEntry
from app.services.auth.jwt_utils import decode_access_token
from app.services.auth_service import AuthService
from app.services.bot_service import BotService
from app.services.channel_service import ChannelService

router = APIRouter(prefix="/docs/agent-bridge", tags=["agent-bridge-docs"])

_PLUGIN_PACKAGE_NAME = (
    os.getenv("OPENCLAW_PLUGIN_PACKAGE", "@haowei0520/openclaw-channel-agentnexus").strip()
    or "@haowei0520/openclaw-channel-agentnexus"
)
_PLUGIN_FILE_STEM = "openclaw-channel-agentnexus"
_PLUGIN_VERSION = os.getenv("OPENCLAW_PLUGIN_VERSION", "0.2.4").strip() or "0.2.4"
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_PLUGIN_RELEASE_DIR = Path(
    os.getenv("OPENCLAW_PLUGIN_RELEASE_DIR", str(_PROJECT_ROOT / "release"))
).resolve()
_PLUGIN_FILE_NAME = (
    os.getenv("OPENCLAW_PLUGIN_FILE", f"{_PLUGIN_FILE_STEM}.tgz").strip()
    or f"{_PLUGIN_FILE_STEM}.tgz"
)
_PLUGIN_SOURCE_URL = (
    "https://github.com/Grant-Huang/AgentNexus/tree/main/packages/openclaw-channel-agentnexus"
)


class AgentBridgeRegisterBody(BaseModel):
    """Register the caller's provider as an AgentNexus Agent Bridge Bot."""

    username: str = Field(..., min_length=1, max_length=64, description="@ mention username, unique in AgentNexus")
    bridge_provider: str = Field(
        default="openclaw",
        pattern=r"^[a-zA-Z0-9_-]{1,32}$",
        description="Agent Bridge provider metadata, e.g. openclaw or acp",
    )
    account_username: str | None = Field(
        default=None,
        description="AgentNexus username or email. Optional when Authorization Bearer is supplied.",
    )
    account_password: str | None = Field(
        default=None,
        description="AgentNexus password. Optional when Authorization Bearer is supplied.",
    )
    display_name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None)
    agent_id: str | None = Field(default="main", description="Provider agent id routed by the channel plugin")
    gateway: str | None = Field(default=None, description="Optional local gateway hint recorded in binding_config")
    scope: Literal["private", "friend", "everyone"] = Field(default="private")
    channel_id: str | None = Field(default=None, description="Optional channel to join after registration")
    template_id: str | None = Field(
        default=None,
        description="Optional prompt template for Agent Bridge dispatch rendering",
    )
    intro: dict[str, Any] | str | None = Field(
        default=None,
        description='Bot intro JSON. If omitted, AgentNexus creates {"description": "...", "capabilities": [...]}.',
    )
    binding_config: dict[str, Any] | None = Field(default=None)
    bot_id: str | None = Field(default=None, description="Optional caller-supplied bot_id")


class AgentBridgeHelpBody(BaseModel):
    question: str = Field(..., min_length=1, description="Question about AgentNexus Agent Bridge integration or usage")


def _http_base(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _ws_base(request: Request) -> str:
    base = _http_base(request)
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    return base


def _docs_urls(request: Request) -> dict[str, str]:
    base = _http_base(request)
    return {
        "swagger": f"{base}/docs",
        "index": f"{base}/docs/agent-bridge",
        "discovery": f"{base}/docs/agent-bridge/discovery",
        "help": f"{base}/docs/agent-bridge/help",
        "register": f"{base}/docs/agent-bridge/register",
        "auth_check": f"{base}/docs/agent-bridge/auth-check",
    }


def _bridge_urls(request: Request) -> dict[str, Any]:
    base = _http_base(request)
    ws_base = _ws_base(request)
    return {
        "control_ws": f"{ws_base}/ws/agent-bridge/control",
        "data_ws": f"{ws_base}/ws/agent-bridge/data",
        "auth": "Authorization: Bearer <bot_token>",
        "http": {
            "status": f"{base}/api/v1/agent-bridge/status",
            "channel_bots": f"{base}/api/v1/agent-bridge/channels/{{channel_id}}/bots",
            "read_file": f"{base}/api/v1/agent-bridge/files/{{file_id}}/content",
            "upload_file": f"{base}/api/v1/agent-bridge/files/upload",
            "upload_binary": f"{base}/api/v1/agent-bridge/files/upload-binary",
        },
    }


def _plugin_download_url(request: Request) -> str:
    return f"{_http_base(request)}/release/{_PLUGIN_FILE_NAME}"


def _plugin_file_path(filename: str) -> Path:
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=404, detail="plugin not found")
    path = (_PLUGIN_RELEASE_DIR / filename).resolve()
    if not path.is_relative_to(_PLUGIN_RELEASE_DIR):
        raise HTTPException(status_code=404, detail="plugin not found")
    return path


def _plugin_payload(request: Request) -> dict[str, Any]:
    download_url = _plugin_download_url(request)
    plugin_path = _plugin_file_path(_PLUGIN_FILE_NAME)
    return {
        "name": _PLUGIN_PACKAGE_NAME,
        "version": _PLUGIN_VERSION,
        "download_url": download_url,
        "release_folder": "release",
        "file_name": _PLUGIN_FILE_NAME,
        "available": plugin_path.is_file(),
        "source_url": _PLUGIN_SOURCE_URL,
        "install": {
            "curl": f"curl -L -o /tmp/{_PLUGIN_FILE_NAME} \"{download_url}\"",
            "openclaw": f"openclaw plugins install /tmp/{_PLUGIN_FILE_NAME}",
        },
        "config_hint": "安装插件后，用 register 响应里的 agent_bridge_config 写入 OpenClaw 配置。",
    }


def _register_schema() -> dict[str, str]:
    return {
        "username": "必填。AgentNexus 中 @ 使用的 Bot 用户名，必须唯一。",
        "bridge_provider": "选填。Provider 元数据；ACP connector 使用 acp，OpenClaw 默认 openclaw。",
        "account_username": "选填。AgentNexus 用户名或邮箱；未提供 Bearer token 时必填。",
        "account_password": "选填。AgentNexus 登录密码；未提供 Bearer token 时必填。",
        "display_name": "选填。聊天界面显示名称。",
        "description": "选填。Bot 描述。",
        "agent_id": "选填。OpenClaw channel plugin 用于路由的 agent id，默认 main。",
        "gateway": "选填。记录本机 OpenClaw gateway 地址或说明，仅作为 binding_config 元数据。",
        "scope": "选填。private/friend/everyone，默认 private。",
        "channel_id": "选填。注册后自动把 Bot 加入该频道；调用用户必须有添加 Bot 权限。",
        "template_id": "选填。频道派发前用于渲染任务文本的 AgentNexus PromptTemplate。",
        "intro": "选填。JSON 对象或 JSON 字符串，需含 description 或 capabilities。",
        "binding_config": "选填。额外写入 BotAccount.binding_config 的对象。",
    }


def _topic_catalog() -> list[dict[str, Any]]:
    return [
        {
            "title": entry.title,
            "keywords": list(entry.keywords[:6]),
        }
        for entry in HELP_ENTRIES
    ]


def _match_help_entry(question: str) -> tuple[HelpEntry | None, int]:
    text = question.strip().lower()
    best: HelpEntry | None = None
    best_score = 0
    for entry in HELP_ENTRIES:
        for keyword in entry.keywords:
            if keyword in text and len(keyword) > best_score:
                best = entry
                best_score = len(keyword)
    return best, best_score


def _answer_help(question: str, request: Request) -> dict[str, Any]:
    entry, score = _match_help_entry(question)
    urls = _docs_urls(request)
    if entry:
        return {
            "question": question,
            "matched": True,
            "match_score": score,
            "title": entry.title,
            "answer": entry.content,
            "sources": [
                urls["index"],
                f"{_http_base(request)}/manual/help/系统管理说明书",
                f"{_http_base(request)}/manual/help/AgentNexus_接入_OpenClaw_WebSocket_指南",
            ],
        }

    return {
        "question": question,
        "matched": False,
        "match_score": 0,
        "title": "未找到精确匹配",
        "answer": (
            "我没有找到精确匹配的帮助条目。OpenClaw 可以先请求 "
            f"{urls['discovery']} 获取机器可读入口；若要注册 Bot，可在请求体里传 "
            f"account_username/account_password，或使用 Authorization: Bearer <token> 调用 "
            f"{urls['register']}。"
        ),
        "topics": _topic_catalog(),
        "sources": [urls["discovery"], urls["swagger"]],
    }


def _intro_as_json(body: AgentBridgeRegisterBody, agent_id: str) -> str:
    if isinstance(body.intro, str) and body.intro.strip():
        return body.intro.strip()
    if isinstance(body.intro, dict):
        intro = dict(body.intro)
    else:
        intro = {}
    provider = _bridge_provider(body)
    default_label = "ACP Agent" if provider == "acp" else "OpenClaw Agent"
    default_capability = "ACP stdio connector" if provider == "acp" else "OpenClaw channel plugin"
    intro.setdefault("description", body.description or f"{default_label}: {agent_id}")
    intro.setdefault("capabilities", [default_capability, "AgentNexus Agent Bridge"])
    return json.dumps(intro, ensure_ascii=False)


def _bridge_provider(body: AgentBridgeRegisterBody) -> str:
    return (body.bridge_provider or "openclaw").strip().lower() or "openclaw"


def _binding_config(body: AgentBridgeRegisterBody, agent_id: str) -> dict[str, Any]:
    cfg = dict(body.binding_config or {})
    cfg.setdefault("agent_id", agent_id)
    cfg.setdefault("bridge_provider", _bridge_provider(body))
    if body.gateway and body.gateway.strip():
        cfg.setdefault("gateway", body.gateway.strip())
    cfg.setdefault("registered_via", "docs_agent_bridge_register")
    return cfg


def _agent_bridge_config(
    *,
    request: Request,
    bot_id: str,
    username: str,
    agent_id: str,
    bot_token: str,
) -> dict[str, Any]:
    bridge = _bridge_urls(request)
    return {
        "channels": {
            "agentnexus": {
                "enabled": True,
                "accounts": [
                    {
                        "botId": bot_id,
                        "username": username,
                        "agentId": agent_id,
                        "botToken": bot_token,
                        "controlUrl": bridge["control_ws"],
                        "dataUrl": bridge["data_ws"],
                    }
                ],
            }
        }
    }


def _acp_connector_config(
    *,
    request: Request,
    account_id: str,
    bot_token: str,
) -> dict[str, Any]:
    bridge = _bridge_urls(request)
    return {
        "accounts": {
            account_id: {
                "botToken": bot_token,
                "controlUrl": bridge["control_ws"],
                "dataUrl": bridge["data_ws"],
                "agent": {
                    "transport": "stdio",
                    "command": "codex-acp",
                    "args": [],
                    "cwd": "$PWD",
                    "env": {
                        "OPENAI_API_KEY": "$OPENAI_API_KEY",
                    },
                },
            }
        }
    }


def _registration_response(
    *,
    request: Request,
    bot,
    bot_token: str,
    agent_id: str,
    joined_channel_id: str | None,
    current_user: User,
    auth_method: str,
    access_token: str | None,
) -> dict[str, Any]:
    bridge = _bridge_urls(request)
    payload = {
        "bot": {
            "bot_id": bot.bot_id,
            "username": bot.username,
            "display_name": bot.display_name,
            "description": bot.description,
            "binding_type": bot.binding_type,
            "bridge_provider": getattr(bot, "bridge_provider", None) or "generic",
            "binding_config": bot.binding_config,
            "scope": bot.scope,
            "status": bot.status,
            "owner_user_id": current_user.user_id,
            "bot_token_prefix": bot.bot_token_prefix,
            "bot_token": bot_token,
            "created_at": bot.created_at.isoformat() if bot.created_at else None,
        },
        "joined_channel_id": joined_channel_id,
        "bridge": bridge,
        "headers": {"Authorization": "Bearer <bot_token>"},
        "plugin": _plugin_payload(request),
        "agent_bridge_config": _agent_bridge_config(
            request=request,
            bot_id=bot.bot_id,
            username=bot.username,
            agent_id=agent_id,
            bot_token=bot_token,
        ),
        "acp_connector_config": _acp_connector_config(
            request=request,
            account_id=bot.username,
            bot_token=bot_token,
        ),
        "docs": _docs_urls(request),
        "token_notice": "bot_token 只在本次响应明文返回；丢失后需在 AgentNexus 中 rotate token。",
    }
    payload["agentnexus_auth"] = {
        "method": auth_method,
        "token_type": "bearer" if access_token else None,
        "access_token": access_token,
        "note": (
            "access_token 仅在账号密码注册流程中返回；"
            "后续可复用，也可以只保存 bot_token。"
        ),
    }
    return payload


async def _resolve_user_by_bearer(
    session: AsyncSession,
    authorization: str | None,
) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    user_id: str | None = None
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub") if payload else None
    except Exception:
        # Keep compatibility with legacy direct-user-id tokens.
        user_id = None
    if not user_id:
        user_id = token
    if not user_id:
        raise UnauthorizedError("无效 Token")
    user = (
        await session.execute(select(User).where(User.user_id == user_id))
    ).scalar_one_or_none()
    if not user:
        raise UnauthorizedError("无效 Token")
    return user


async def _resolve_register_user(
    body: AgentBridgeRegisterBody,
    session: AsyncSession,
    authorization: str | None,
) -> tuple[User, str, str | None]:
    account_username = (body.account_username or "").strip()
    account_password = body.account_password or ""
    if account_username or account_password:
        if not account_username or not account_password:
            raise BadRequestError("account_username 和 account_password 必须同时提供")
        user, token = await AuthService(session).login(account_username, account_password)
        return user, "account_password", token

    user = await _resolve_user_by_bearer(session, authorization)
    if user:
        return user, "bearer", None
    raise UnauthorizedError("需提供 Authorization: Bearer <access_token> 或账号密码")


@router.get("", response_model=APIResponse[dict])
@router.get("/", response_model=APIResponse[dict], include_in_schema=False)
async def agent_bridge_docs_index(request: Request) -> APIResponse:
    return APIResponse.ok(_discovery_payload(request))


@router.get("/discovery", response_model=APIResponse[dict])
async def agent_bridge_discovery(request: Request) -> APIResponse:
    """Machine-readable Agent Bridge integration contract."""
    return APIResponse.ok(_discovery_payload(request))


@router.get("/release/{filename}")
async def download_agent_bridge_plugin(filename: str) -> FileResponse:
    """Download an OpenClaw plugin tarball from AgentNexus/release/."""
    path = _plugin_file_path(filename)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="plugin not found")
    return FileResponse(
        path,
        media_type="application/gzip",
        filename=path.name,
    )


@router.get("/auth-check", response_model=APIResponse[dict])
async def agent_bridge_auth_check(current_user: User = Depends(get_current_user)) -> APIResponse:
    """Verify that the supplied user Bearer token can create user-owned resources."""
    return APIResponse.ok(
        {
            "authenticated": True,
            "user": {
                "user_id": current_user.user_id,
                "username": current_user.username,
                "display_name": current_user.display_name,
                "role": current_user.role,
            },
        }
    )


@router.get("/help", response_model=APIResponse[dict])
async def agent_bridge_help_get(
    request: Request,
    q: str | None = Query(default=None, description="Question to answer. Omit to list supported topics."),
) -> APIResponse:
    """Q&A-style help endpoint for local Agent Bridge clients."""
    if not q or not q.strip():
        return APIResponse.ok(
            {
                "topics": _topic_catalog(),
                "hint": "Use GET /docs/agent-bridge/help?q=... or POST /docs/agent-bridge/help with {\"question\":\"...\"}.",
                "docs": _docs_urls(request),
            }
        )
    return APIResponse.ok(_answer_help(q.strip(), request))


@router.post("/help", response_model=APIResponse[dict])
async def agent_bridge_help_post(body: AgentBridgeHelpBody, request: Request) -> APIResponse:
    """Q&A-style help endpoint for local Agent Bridge clients."""
    return APIResponse.ok(_answer_help(body.question.strip(), request))


@router.post("/register", response_model=APIResponse[dict])
async def register_agent_bridge_bot(
    body: AgentBridgeRegisterBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
    authorization: str | None = Header(default=None),
) -> APIResponse:
    """Create a user-owned Agent Bridge Bot for the caller's local provider.

    Authentication: either ``Authorization: Bearer <AgentNexus access_token>``
    or ``account_username`` + ``account_password`` in the JSON body.
    The response includes the per-bot Agent Bridge token once.
    """
    current_user, auth_method, access_token = await _resolve_register_user(
        body,
        session,
        authorization,
    )
    agent_id = (body.agent_id or "main").strip() or "main"
    provider = _bridge_provider(body)
    default_description = f"{'ACP Agent' if provider == 'acp' else 'OpenClaw Agent'}: {agent_id}"
    svc = BotService(session)
    bot, bot_token = await svc.create(
        username=body.username,
        display_name=body.display_name,
        description=body.description or default_description,
        model_id=None,
        template_id=body.template_id,
        intro=_intro_as_json(body, agent_id),
        scope=body.scope,
        bot_id=body.bot_id,
        binding_type="agent_bridge",
        bridge_provider=provider,
        binding_config=_binding_config(body, agent_id),
        current_user=current_user,
    )
    if not bot_token:
        raise BadRequestError("Agent Bridge Bot token 生成失败")

    joined_channel_id: str | None = None
    if body.channel_id and body.channel_id.strip():
        membership = await ChannelService(session).add_member(
            body.channel_id.strip(),
            bot.bot_id,
            "bot",
            current_user,
        )
        joined_channel_id = membership.channel_id

    return APIResponse.ok(
        _registration_response(
            request=request,
            bot=bot,
            bot_token=bot_token,
            agent_id=agent_id,
            joined_channel_id=joined_channel_id,
            current_user=current_user,
            auth_method=auth_method,
            access_token=access_token,
        ),
        message="Agent Bridge Bot 注册成功，请立即保存 bot_token。",
    )


def _discovery_payload(request: Request) -> dict[str, Any]:
    urls = _docs_urls(request)
    return {
        "name": "AgentNexus Agent Bridge",
        "description": "Public, machine-readable entrypoints for external Agent Bridge providers.",
        "base_url": _http_base(request),
        "docs_namespace": "/docs/agent-bridge",
        "recommended_flow": [
            "GET /docs/agent-bridge/discovery to inspect capabilities and endpoint schemas.",
            "POST /docs/agent-bridge/register with account_username/account_password, or with a user Bearer token.",
            "Save the returned bot_token and connect to /ws/agent-bridge/control and /ws/agent-bridge/data.",
            "Use /docs/agent-bridge/help for Q&A-style troubleshooting.",
        ],
        "auth": {
            "login": {
                "method": "POST",
                "url": f"{_http_base(request)}/api/v1/auth/login",
                "body_schema": {"username": "string", "password": "string"},
                "token_path": "data.access_token",
            },
            "register_auth": (
                "Either request body account_username/account_password, "
                "or Authorization: Bearer <AgentNexus access_token>"
            ),
            "bridge_auth": "Authorization: Bearer <bot_token returned by register>",
        },
        "entrypoints": {
            "discovery": {"method": "GET", "url": urls["discovery"], "auth": "none"},
            "help_get": {"method": "GET", "url": f"{urls['help']}?q=...", "auth": "none"},
            "help_post": {"method": "POST", "url": urls["help"], "auth": "none"},
            "auth_check": {"method": "GET", "url": urls["auth_check"], "auth": "user_bearer"},
            "register": {
                "method": "POST",
                "url": urls["register"],
                "auth": "account_password_or_user_bearer",
                "content_type": "application/json",
                "body_schema": _register_schema(),
            },
            "swagger": {"method": "GET", "url": urls["swagger"], "auth": "none"},
        },
        "bridge": _bridge_urls(request),
        "plugin": _plugin_payload(request),
        "help_topics": _topic_catalog(),
    }
