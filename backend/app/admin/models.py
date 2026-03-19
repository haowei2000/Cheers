"""AI 模型管理 API."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    AIModelCreate,
    AIModelInResponse,
    AIModelUpdate,
)
from app.db.models import AIModel, User
from app.db.session import get_session
from app.auth.routes import get_current_user

router = APIRouter(
    prefix="/api/admin/models",
    tags=["admin-models"],
)


def _mask_api_key(key: str | None) -> str | None:
    """隐藏 API Key，只显示前4位和后4位."""
    if not key:
        return None
    if len(key) <= 8:
        return "****"
    return key[:4] + "****" + key[-4:]


@router.get("")
async def list_models(
    include_disabled: bool = False,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取所有 AI 模型列表."""
    q = select(AIModel).order_by(AIModel.created_at.desc())
    if not include_disabled:
        q = q.where(AIModel.is_enabled == True)
    
    result = await session.execute(q)
    items = []
    for row in result.scalars().all():
        d = AIModelInResponse.model_validate(row).model_dump()
        d["api_key_masked"] = _mask_api_key(row.api_key)
        if row.created_at:
            d["created_at"] = row.created_at.isoformat()
        items.append(d)
    return {"status": "success", "data": items}


@router.post("")
async def create_model(
    body: AIModelCreate,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建 AI 模型配置."""
    # 检查名称是否已存在
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
        api_key=body.api_key.strip() if body.api_key else None,
        description=body.description.strip() if body.description else None,
        is_enabled=body.is_enabled,
        config=body.config or {},
    )
    session.add(model)
    await session.commit()
    await session.refresh(model)
    
    d = AIModelInResponse.model_validate(model).model_dump()
    d["api_key_masked"] = _mask_api_key(model.api_key)
    if model.created_at:
        d["created_at"] = model.created_at.isoformat()
    return {"status": "success", "data": d}


@router.get("/{model_id}")
async def get_model(
    model_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取单个 AI 模型详情."""
    result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")
    
    d = AIModelInResponse.model_validate(model).model_dump()
    d["api_key_masked"] = _mask_api_key(model.api_key)
    if model.created_at:
        d["created_at"] = model.created_at.isoformat()
    return {"status": "success", "data": d}


@router.put("/{model_id}")
async def update_model(
    model_id: str,
    body: AIModelUpdate,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新 AI 模型配置."""
    result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")

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
        model.api_key = body.api_key.strip() if body.api_key else None
    if body.description is not None:
        model.description = body.description.strip() if body.description else None
    if body.is_enabled is not None:
        model.is_enabled = body.is_enabled
    if body.config is not None:
        model.config = body.config
    
    await session.commit()
    await session.refresh(model)
    
    d = AIModelInResponse.model_validate(model).model_dump()
    d["api_key_masked"] = _mask_api_key(model.api_key)
    if model.created_at:
        d["created_at"] = model.created_at.isoformat()
    return {"status": "success", "data": d}


@router.delete("/{model_id}")
async def delete_model(
    model_id: str,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除 AI 模型."""
    result = await session.execute(
        select(AIModel).where(AIModel.model_id == model_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="模型不存在")

    # 检查是否有 Bot 正在使用此模型
    from app.db.models import BotAccount
    using_bots = await session.execute(
        select(BotAccount).where(BotAccount.model_id == model_id)
    )
    if using_bots.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="有 Bot 正在使用此模型，无法删除")
    
    await session.delete(model)
    await session.commit()
    return {"status": "success", "message": "已删除"}
