"""Bot 账号 REST：创建、列表、更新、删除.

新架构：Bot = 模型 + 提示词模板
"""
import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    BotCreate,
    BotInResponse,
    BotRegisterRequest,
    BotRegistrationRequestInResponse,
    BotSimpleInResponse,
    BotUpdate,
)
from app.db.models import BotAccount, BotRegistrationRequest, gen_uuid, AIModel, PromptTemplate, User
from app.db.session import get_session
from app.auth.routes import require_permission

router = APIRouter(prefix="/api/bots", tags=["bots"])


def _validate_intro(intro: str | None) -> str | None:
    """校验 intro 为合法 JSON."""
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


async def _validate_model_and_template(
    session: AsyncSession, model_id: str, template_id: str
) -> tuple[AIModel, PromptTemplate]:
    """验证模型和模板是否存在且可用."""
    # 检查模型
    model_result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id, AIModel.is_enabled == True)
    )
    model = model_result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=400, detail="指定的模型不存在或已禁用")
    
    # 检查模板
    template_result = await session.execute(
        select(PromptTemplate).where(PromptTemplate.template_id == template_id)
    )
    template = template_result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=400, detail="指定的提示词模板不存在")
    
    return model, template


@router.get("")
async def list_bots(
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取所有 Bot 账号列表."""
    result = await session.execute(
        select(BotAccount).order_by(BotAccount.created_at.desc())
    )
    items = []
    for row in result.scalars().all():
        d = BotSimpleInResponse(
            bot_id=row.bot_id,
            username=row.username,
            display_name=row.display_name,
            description=row.description,
            status=row.status,
            model_name=row.ai_model.name if row.ai_model else None,
            template_name=row.prompt_template.name if row.prompt_template else None,
            created_at=row.created_at,
        ).model_dump()
        if row.created_at:
            d["created_at"] = row.created_at.isoformat()
        items.append(d)
    return {"status": "success", "data": items}


@router.post("")
async def create_bot(
    body: BotCreate,
    _: User = Depends(require_permission("bot_config")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建 Bot：选择模型 + 选择提示词模板."""
    bot_id = body.bot_id
    if not bot_id or not bot_id.strip():
        bot_id = gen_uuid()
    else:
        bot_id = bot_id.strip()

    # 检查 bot_id 是否已存在
    existing = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="bot_id 已存在")

    # 检查 username 是否已存在
    existing_user = await session.execute(
        select(BotAccount).where(BotAccount.username == body.username.strip())
    )
    if existing_user.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="username 已存在")

    # 验证模型和模板
    model, template = await _validate_model_and_template(
        session, body.model_id, body.template_id
    )

    intro_val = _validate_intro(body.intro) if body.intro else None

    bot = BotAccount(
        bot_id=bot_id,
        username=body.username.strip(),
        display_name=body.display_name.strip() if body.display_name else None,
        description=body.description.strip() if body.description else None,
        model_id=body.model_id,
        template_id=body.template_id,
        custom_system_prompt=body.custom_system_prompt.strip() if body.custom_system_prompt else None,
        status=body.status.strip() or "online",
        intro=intro_val,
        avatar_url=body.avatar_url.strip() if body.avatar_url else None,
    )
    session.add(bot)
    await session.commit()
    await session.refresh(bot)

    d = BotInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        avatar_url=bot.avatar_url,
        status=bot.status,
        intro=bot.intro,
        custom_system_prompt=bot.custom_system_prompt,
        created_at=bot.created_at,
        model_id=bot.model_id,
        template_id=bot.template_id,
        model_name=model.name,
        template_name=template.name,
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {"status": "success", "data": d}


@router.get("/{bot_id}")
async def get_bot(
    bot_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取单个 Bot 详情."""
    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    
    d = BotInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        avatar_url=bot.avatar_url,
        status=bot.status,
        intro=bot.intro,
        custom_system_prompt=bot.custom_system_prompt,
        created_at=bot.created_at,
        model_id=bot.model_id,
        template_id=bot.template_id,
        model_name=bot.ai_model.name if bot.ai_model else None,
        template_name=bot.prompt_template.name if bot.prompt_template else None,
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {"status": "success", "data": d}


@router.put("/{bot_id}")
async def update_bot(
    bot_id: str,
    body: BotUpdate,
    _: User = Depends(require_permission("bot_config")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新 Bot 信息."""
    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
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

    if body.description is not None:
        bot.description = body.description.strip() if body.description else None

    if body.avatar_url is not None:
        bot.avatar_url = body.avatar_url.strip() if body.avatar_url else None

    if body.status is not None:
        bot.status = body.status.strip() or bot.status

    if body.intro is not None:
        bot.intro = _validate_intro(body.intro) if body.intro else None

    if body.custom_system_prompt is not None:
        bot.custom_system_prompt = body.custom_system_prompt.strip() if body.custom_system_prompt else None

    # 更新模型或模板
    new_model_id = body.model_id
    new_template_id = body.template_id
    
    if new_model_id is not None or new_template_id is not None:
        model_id = new_model_id or bot.model_id
        template_id = new_template_id or bot.template_id
        model, template = await _validate_model_and_template(session, model_id, template_id)
        bot.model_id = model_id
        bot.template_id = template_id

    await session.commit()
    await session.refresh(bot)

    d = BotInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        description=bot.description,
        avatar_url=bot.avatar_url,
        status=bot.status,
        intro=bot.intro,
        custom_system_prompt=bot.custom_system_prompt,
        created_at=bot.created_at,
        model_id=bot.model_id,
        template_id=bot.template_id,
        model_name=bot.ai_model.name if bot.ai_model else None,
        template_name=bot.prompt_template.name if bot.prompt_template else None,
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return {"status": "success", "data": d}


@router.delete("/{bot_id}")
async def delete_bot(
    bot_id: str,
    _: User = Depends(require_permission("bot_config")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除 Bot 账号."""
    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    await session.delete(bot)
    await session.commit()
    return {"status": "success", "message": "已删除"}


# ========== 遗留：外部 OpenClaw 注册申请 ==========

@router.post("/register-request")
async def submit_register_request(
    body: BotRegisterRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """外部 OpenClaw 提交注册申请（遗留兼容）."""
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
        raise HTTPException(
            status_code=400,
            detail='注册须提供结构化自我介绍 intro'
        )
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
            "message": "注册申请已提交，等待管理员审核。",
        },
    }


@router.get("/registration-requests")
async def list_registration_requests(
    status: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取 Bot 注册申请列表（遗留兼容）."""
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
    """管理员审核通过（遗留兼容）."""
    raise HTTPException(
        status_code=400,
        detail="新架构不再支持外部 OpenClaw 注册，请直接创建 Bot"
    )


@router.post("/registration-requests/{request_id}/reject")
async def reject_registration_request(
    request_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """管理员拒绝申请（遗留兼容）."""
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
