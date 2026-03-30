"""AI 模型管理 API."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    AIModelCreate,
    AIModelInResponse,
    AIModelUpdate,
)
from app.db.models import AIModel, User
from app.db.session import get_session
from app.auth.routes import get_current_user
from app.utils.crypto import decrypt_value, encrypt_value
from app.utils.permissions import can_access, get_friend_ids, is_admin

router = APIRouter(
    prefix="/api/admin/models",
    tags=["admin-models"],
)


def _mask_api_key(key: str | None) -> str | None:
    """隐藏 API Key，只显示前4位和后4位（解密后再脱敏）."""
    if not key:
        return None
    plain = decrypt_value(key)
    if not plain:
        return None
    if len(plain) <= 8:
        return "****"
    return plain[:4] + "****" + plain[-4:]


def _to_response(model: AIModel) -> dict:
    d = AIModelInResponse.model_validate(model).model_dump()
    d["api_key_masked"] = _mask_api_key(model.api_key)
    d["created_by"] = model.created_by
    if model.created_at:
        d["created_at"] = model.created_at.isoformat()
    return d


@router.get("")
async def list_models(
    include_disabled: bool = False,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取 AI 模型列表。

    可见规则：
    - 管理员：全部
    - 普通用户：自己创建的 + 好友公开的
    """
    q = select(AIModel).order_by(AIModel.created_at.desc())
    if not include_disabled:
        q = q.where(AIModel.is_enabled == True)

    result = await session.execute(q)
    all_models = result.scalars().all()

    if is_admin(current_user):
        visible = all_models
    else:
        friend_ids = await get_friend_ids(session, current_user.user_id)
        visible = [
            m for m in all_models
            if m.created_by == current_user.user_id
            or (m.is_public and m.created_by in friend_ids)
        ]

    return {"status": "success", "data": [_to_response(m) for m in visible]}


@router.post("")
async def create_model(
    body: AIModelCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建 AI 模型配置."""
    existing = await session.execute(
        select(AIModel).where(AIModel.name == body.name.strip())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="模型名称已存在")

    model = AIModel(
        name=body.name.strip(),
        provider=body.provider.strip().lower(),
        model_name=body.model_name.strip(),
        base_url=body.base_url.strip(),
        api_key=encrypt_value(body.api_key.strip()) if body.api_key else None,
        description=body.description.strip() if body.description else None,
        is_enabled=body.is_enabled,
        is_public=body.is_public,
        created_by=current_user.user_id,
        config=body.config or {},
    )
    session.add(model)
    await session.commit()
    await session.refresh(model)
    return {"status": "success", "data": _to_response(model)}


@router.get("/{model_id}")
async def get_model(
    model_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取单个 AI 模型详情（须有访问权限）."""
    result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    if not await can_access(session, current_user, model.created_by, model.is_public):
        raise HTTPException(status_code=403, detail="无权访问该模型")
    return {"status": "success", "data": _to_response(model)}


@router.put("/{model_id}")
async def update_model(
    model_id: str,
    body: AIModelUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新 AI 模型配置（仅创建者或管理员）."""
    result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    if model.created_by != current_user.user_id and not is_admin(current_user):
        raise HTTPException(status_code=403, detail="权限不足，仅创建者或管理员可编辑")

    if body.name is not None:
        name = body.name.strip()
        if name != model.name:
            existing = await session.execute(
                select(AIModel).where(AIModel.name == name)
            )
            if existing.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="模型名称已存在")
            model.name = name

    if body.provider is not None:
        model.provider = body.provider.strip().lower()
    if body.model_name is not None:
        model.model_name = body.model_name.strip()
    if body.base_url is not None:
        model.base_url = body.base_url.strip()
    if body.api_key is not None:
        model.api_key = encrypt_value(body.api_key.strip()) if body.api_key else None
    if body.description is not None:
        model.description = body.description.strip() if body.description else None
    if body.is_enabled is not None:
        model.is_enabled = body.is_enabled
    if body.is_public is not None:
        model.is_public = body.is_public
    if body.config is not None:
        model.config = body.config

    await session.commit()
    await session.refresh(model)
    return {"status": "success", "data": _to_response(model)}


@router.delete("/{model_id}")
async def delete_model(
    model_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除 AI 模型（仅创建者或管理员）."""
    result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    if model.created_by != current_user.user_id and not is_admin(current_user):
        raise HTTPException(status_code=403, detail="权限不足，仅创建者或管理员可删除")

    from app.db.models import BotAccount
    using_bots = await session.execute(
        select(BotAccount).where(BotAccount.model_id == model_id)
    )
    if using_bots.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="有 Bot 正在使用此模型，无法删除")

    await session.delete(model)
    await session.commit()
    return {"status": "success", "message": "已删除"}
