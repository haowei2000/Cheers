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
from app.auth.routes import get_current_user
from app.utils.permissions import can_access, get_friend_ids, is_admin

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
    session: AsyncSession, model_id: str, template_id: str, current_user: "User"
) -> tuple[AIModel, PromptTemplate]:
    """验证模型和模板是否存在、可用，且当前用户有权访问。"""
    from app.utils.permissions import can_access as _can_access

    model_result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id, AIModel.is_enabled == True)
    )
    model = model_result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=400, detail="指定的模型不存在或已禁用")
    if not await _can_access(session, current_user, model.created_by, model.is_public):
        raise HTTPException(status_code=403, detail="无权使用该模型")

    template_result = await session.execute(
        select(PromptTemplate).where(PromptTemplate.template_id == template_id)
    )
    template = template_result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=400, detail="指定的提示词模板不存在")

    return model, template


def _bot_to_simple(row: BotAccount) -> dict:
    d = BotSimpleInResponse(
        bot_id=row.bot_id,
        username=row.username,
        display_name=row.display_name,
        description=row.description,
        status=row.status,
        is_public=row.is_public,
        model_name=row.ai_model.name if row.ai_model else None,
        template_name=row.prompt_template.name if row.prompt_template else None,
        created_by=row.created_by,
        created_at=row.created_at,
    ).model_dump()
    if row.created_at:
        d["created_at"] = row.created_at.isoformat()
    return d


def _bot_to_full(bot: BotAccount, model_name: str | None = None, template_name: str | None = None) -> dict:
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
    ).model_dump()
    if bot.created_at:
        d["created_at"] = bot.created_at.isoformat()
    return d


@router.get("")
async def list_bots(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取 Bot 列表。

    可见规则：
    - 管理员：全部
    - 普通用户：自己创建的 + 好友公开的
    """
    result = await session.execute(
        select(BotAccount).order_by(BotAccount.created_at.desc())
    )
    all_bots = result.scalars().all()

    if is_admin(current_user):
        visible = all_bots
    else:
        friend_ids = await get_friend_ids(session, current_user.user_id)
        visible = [
            b for b in all_bots
            if b.created_by == current_user.user_id
            or (b.is_public and b.created_by in friend_ids)
        ]

    return {"status": "success", "data": [_bot_to_simple(b) for b in visible]}


@router.post("")
async def create_bot(
    body: BotCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建 Bot：任意登录用户均可创建，Bot 归属于创建者。"""
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
        session, body.model_id, body.template_id, current_user
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
        is_public=body.is_public,
        intro=intro_val,
        avatar_url=body.avatar_url.strip() if body.avatar_url else None,
        created_by=current_user.user_id,
    )
    session.add(bot)
    await session.commit()
    await session.refresh(bot)

    return {"status": "success", "data": _bot_to_full(bot, model.name, template.name)}


@router.get("/{bot_id}")
async def get_bot(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取单个 Bot 详情（需要登录）."""
    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    if not await can_access(session, current_user, bot.created_by, bot.is_public):
        raise HTTPException(status_code=403, detail="无权访问该 Bot")
    return {"status": "success", "data": _bot_to_full(bot)}


@router.put("/{bot_id}")
async def update_bot(
    bot_id: str,
    body: BotUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新 Bot 信息：仅创建者或管理员可操作。"""
    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    if bot.created_by != current_user.user_id and not is_admin(current_user):
        raise HTTPException(status_code=403, detail="权限不足，仅 Bot 创建者或管理员可编辑")

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

    if body.is_public is not None:
        bot.is_public = body.is_public

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
        model, template = await _validate_model_and_template(session, model_id, template_id, current_user)
        bot.model_id = model_id
        bot.template_id = template_id

    await session.commit()
    await session.refresh(bot)

    return {"status": "success", "data": _bot_to_full(bot)}


@router.delete("/{bot_id}")
async def delete_bot(
    bot_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除 Bot 账号：仅创建者或管理员可操作。"""
    result = await session.execute(
        select(BotAccount).where(BotAccount.bot_id == bot_id)
    )
    bot = result.scalar_one_or_none()
    if not bot:
        raise HTTPException(status_code=404, detail="Bot 不存在")
    if bot.created_by != current_user.user_id and not is_admin(current_user):
        raise HTTPException(status_code=403, detail="权限不足，仅 Bot 创建者或管理员可删除")
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
