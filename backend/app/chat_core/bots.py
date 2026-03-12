"""Bot 账号 REST：创建、列表、更新、删除、外部注册申请与审核."""
import json
import uuid
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    BotCreate,
    BotInResponse,
    BotRegisterRequest,
    BotRegistrationRequestInResponse,
    BotUpdate,
)
from app.db.models import BotAccount, BotRegistrationRequest, gen_uuid
from app.db.session import get_session


class McpServerEntry(BaseModel):
    """单个 MCP 服务器配置条目."""

    command: str
    args: list[str] = []
    env: dict[str, str] = {}


class McpServersConfig(BaseModel):
    """MCP 服务器配置，格式与 mcp.json/claude_desktop_config.json 一致."""

    mcpServers: dict[str, McpServerEntry]


class McpBotInfo(BaseModel):
    """从 MCP 配置解析出的 Bot 信息."""

    server_name: str
    username: str
    display_name: str | None = None
    endpoint: str
    session: str | None = None  # 完整 OPENCLAW_SESSION，如 agent:xiaozhi
    token: str | None = None

router = APIRouter(prefix="/api/bots", tags=["bots"])


def _validate_intro(intro: str | None) -> str | None:
    """校验 intro 为合法 JSON，返回 None 或校验后的字符串."""
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
        raise HTTPException(status_code=400, detail=f"intro 须为合法 JSON: {e}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("")
async def list_bots(session: AsyncSession = Depends(get_session)) -> dict:
    """获取所有 Bot 账号列表（管理用）."""
    result = await session.execute(
        select(BotAccount).order_by(BotAccount.created_at.desc())
    )
    items = []
    for row in result.scalars().all():
        d = BotInResponse.model_validate(row).model_dump()
        if row.created_at:
            d["created_at"] = row.created_at.isoformat()
        items.append(d)
    return {"status": "success", "data": items}


@router.post("")
async def create_bot(
    body: BotCreate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建（注册）Bot 账号；bot_id 不填则自动生成."""
    bot_id = body.bot_id
    if not bot_id or not bot_id.strip():
        from app.db.models import gen_uuid
        bot_id = gen_uuid()
    else:
        bot_id = bot_id.strip()

    existing = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="bot_id 已存在")

    existing_user = await session.execute(
        select(BotAccount).where(BotAccount.username == body.username.strip())
    )
    if existing_user.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="username 已存在")

    intro_val = _validate_intro(body.intro) if body.intro else None
    bot = BotAccount(
        bot_id=bot_id,
        username=body.username.strip(),
        display_name=body.display_name.strip() if body.display_name else None,
        openclaw_endpoint=body.openclaw_endpoint.strip(),
        openclaw_session=body.openclaw_session.strip() if body.openclaw_session else None,
        openclaw_token=body.openclaw_token.strip() if body.openclaw_token else None,
        status=body.status.strip() or "online",
        intro=intro_val,
        avatar_url=body.avatar_url.strip() if body.avatar_url else None,
    )
    session.add(bot)
    await session.commit()
    await session.refresh(bot)

    d = BotInResponse.model_validate(bot).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {"status": "success", "data": d}


# ---------- 外部 OpenClaw 发现与注册（需在 /{bot_id} 之前定义） ----------


@router.post("/register-request")
async def submit_register_request(
    body: BotRegisterRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """外部 OpenClaw 提交注册申请；创建为待审核，管理员通过后才能真正被 @。"""
    username = body.username.strip()
    openclaw_endpoint = body.openclaw_endpoint.strip()
    existing = await session.execute(
        select(BotAccount).where(BotAccount.username == username)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="username 已被使用")
    pending = await session.execute(
        select(BotRegistrationRequest).where(
            BotRegistrationRequest.username == username,
            BotRegistrationRequest.status == "pending",
        )
    )
    if pending.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该 username 已有待审核申请")
    intro_val = _validate_intro(body.intro) if body.intro else None
    if not intro_val:
        raise HTTPException(status_code=400, detail="注册须提供结构化自我介绍 intro，格式: {\"capabilities\": [...], \"description\": \"...\"}")
    req = BotRegistrationRequest(
        request_id=gen_uuid(),
        username=username,
        display_name=body.display_name.strip() if body.display_name else None,
        openclaw_endpoint=openclaw_endpoint,
        intro=intro_val,
        status="pending",
    )
    session.add(req)
    await session.commit()
    await session.refresh(req)
    return {
        "status": "success",
        "data": {
            "request_id": req.request_id,
            "message": "注册申请已提交，等待管理员在「管理」界面审核通过后可被加入项目并 @。",
        },
    }


@router.get("/registration-requests")
async def list_registration_requests(
    status: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取 Bot 注册申请列表（管理用）；可选 status=pending 仅待审核。"""
    q = select(BotRegistrationRequest).order_by(
        BotRegistrationRequest.requested_at.desc()
    )
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
    return {"status": "success", "data": items}


@router.post("/registration-requests/{request_id}/approve")
async def approve_registration_request(
    request_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """管理员审核通过：创建 Bot 账号并标记申请为已通过。"""
    result = await session.execute(
        select(BotRegistrationRequest).where(
            BotRegistrationRequest.request_id == request_id,
            BotRegistrationRequest.status == "pending",
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="申请不存在或已处理")
    again = await session.execute(
        select(BotAccount).where(BotAccount.username == req.username)
    )
    if again.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该 username 已存在 Bot")
    bot = BotAccount(
        bot_id=gen_uuid(),
        username=req.username,
        display_name=req.display_name,
        openclaw_endpoint=req.openclaw_endpoint,
        status="online",
        intro=req.intro,
    )
    session.add(bot)
    await session.flush()
    req.status = "approved"
    req.decided_at = datetime.utcnow()
    req.created_bot_id = bot.bot_id
    await session.commit()
    await session.refresh(bot)
    d = BotInResponse.model_validate(bot).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {
        "status": "success",
        "data": d,
        "message": "已通过并创建 Bot，请将 Bot 加入项目后即可 @",
    }


@router.post("/registration-requests/{request_id}/reject")
async def reject_registration_request(
    request_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """管理员拒绝申请。"""
    result = await session.execute(
        select(BotRegistrationRequest).where(
            BotRegistrationRequest.request_id == request_id,
            BotRegistrationRequest.status == "pending",
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="申请不存在或已处理")
    req.status = "rejected"
    req.decided_at = datetime.utcnow()
    await session.commit()
    return {"status": "success", "message": "已拒绝"}


# ---------- 从 MCP 配置导入 Bot ----------


def _parse_openclaw_bots(config: McpServersConfig) -> tuple[list[McpBotInfo], list[dict]]:
    """解析 MCP 配置，提取 OpenClaw Bot 信息。返回 (bots, skipped)."""
    bots: list[McpBotInfo] = []
    skipped: list[dict] = []

    for server_name, entry in config.mcpServers.items():
        env = entry.env
        openclaw_url = env.get("OPENCLAW_URL")
        session_str = env.get("OPENCLAW_SESSION", "")
        agent_name = env.get("OPENCLAW_AGENT_NAME")
        token = env.get("OPENCLAW_TOKEN")

        if not openclaw_url:
            skipped.append({"server": server_name, "reason": "缺少 OPENCLAW_URL"})
            continue
        if not session_str:
            skipped.append({"server": server_name, "reason": "缺少 OPENCLAW_SESSION"})
            continue

        # OPENCLAW_SESSION 格式为 "agent:xiaozhi"，取冒号后的部分作为 username 和 chat session key
        username = session_str.split(":", 1)[1] if ":" in session_str else session_str
        if not username:
            skipped.append({"server": server_name, "reason": "OPENCLAW_SESSION 格式无效"})
            continue

        # chat.send 使用不带 "agent:" 前缀的 session key（如 "xiaozhi"）
        chat_session = username

        bots.append(McpBotInfo(
            server_name=server_name,
            username=username,
            display_name=agent_name,
            endpoint=openclaw_url,
            session=chat_session,
            token=token,
        ))

    return bots, skipped


@router.post("/preview-from-mcp")
async def preview_bots_from_mcp(body: McpServersConfig) -> dict:
    """解析 MCP 配置，预览可导入的 Bot 列表（不写入数据库）."""
    bots, skipped = _parse_openclaw_bots(body)
    return {
        "status": "success",
        "data": {
            "bots": [b.model_dump() for b in bots],
            "skipped": skipped,
        },
    }


@router.post("/import-from-mcp")
async def import_bots_from_mcp(
    body: McpServersConfig,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """解析 MCP 配置并将 OpenClaw Bot 导入数据库（跳过已存在的）."""
    bots, skipped = _parse_openclaw_bots(body)

    imported = []
    for bot_info in bots:
        existing = await session.execute(
            select(BotAccount).where(BotAccount.username == bot_info.username)
        )
        if existing.scalar_one_or_none():
            skipped.append({"server": bot_info.server_name, "username": bot_info.username, "reason": "username 已存在"})
            continue

        bot = BotAccount(
            bot_id=gen_uuid(),
            username=bot_info.username,
            display_name=bot_info.display_name,
            openclaw_endpoint=bot_info.endpoint,
            openclaw_session=bot_info.session,
            openclaw_token=bot_info.token,
            status="online",
            intro=None,
        )
        session.add(bot)
        await session.flush()
        await session.refresh(bot)

        d = BotInResponse.model_validate(bot).model_dump()
        if bot.created_at:
            d["created_at"] = bot.created_at.isoformat()
        imported.append(d)

    await session.commit()
    return {
        "status": "success",
        "data": {
            "imported": imported,
            "skipped": skipped,
        },
    }


# ---------- 单 Bot 操作 ----------


@router.get("/{bot_id}")
async def get_bot(
    bot_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取单个 Bot 详情."""
    result = await session.execute(select(BotAccount).where(BotAccount.bot_id == bot_id))
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    d = BotInResponse.model_validate(bot).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {"status": "success", "data": d}


@router.put("/{bot_id}")
async def update_bot(
    bot_id: str,
    body: BotUpdate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新 Bot 信息."""
    result = await session.execute(select(BotAccount).where(BotAccount.bot_id == bot_id))
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    if body.username is not None:
        uname = body.username.strip()
        if uname != bot.username:
            existing = await session.execute(
                select(BotAccount).where(BotAccount.username == uname)
            )
            if existing.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="username 已被使用")
            bot.username = uname
    if body.display_name is not None:
        bot.display_name = body.display_name.strip() if body.display_name else None
    if body.openclaw_endpoint is not None:
        bot.openclaw_endpoint = body.openclaw_endpoint.strip()
    if body.openclaw_session is not None:
        bot.openclaw_session = body.openclaw_session.strip() or None
    if body.openclaw_token is not None:
        bot.openclaw_token = body.openclaw_token.strip() or None
    if body.status is not None:
        bot.status = body.status.strip() or bot.status
    if body.intro is not None:
        bot.intro = _validate_intro(body.intro) if body.intro else None
    if body.avatar_url is not None:
        bot.avatar_url = body.avatar_url.strip() if body.avatar_url else None
    await session.commit()
    await session.refresh(bot)
    d = BotInResponse.model_validate(bot).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {"status": "success", "data": d}


@router.delete("/{bot_id}")
async def delete_bot(
    bot_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除 Bot 账号."""
    result = await session.execute(select(BotAccount).where(BotAccount.bot_id == bot_id))
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    await session.delete(bot)
    await session.commit()
    return {"status": "success", "message": "已删除"}
