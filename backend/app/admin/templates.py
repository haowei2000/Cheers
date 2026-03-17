"""提示词模板管理 API."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat_core.schemas import (
    PromptTemplateCreate,
    PromptTemplateInResponse,
    PromptTemplateUpdate,
)
from app.db.models import PromptTemplate
from app.db.session import get_session
from app.auth.routes import require_permission

router = APIRouter(
    prefix="/api/admin/templates",
    tags=["admin-templates"],
    dependencies=[Depends(require_permission("bot_config"))],
)


@router.get("")
async def list_templates(
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取所有提示词模板列表."""
    result = await session.execute(
        select(PromptTemplate).order_by(PromptTemplate.created_at.desc())
    )
    items = []
    for row in result.scalars().all():
        d = PromptTemplateInResponse.model_validate(row).model_dump()
        if row.created_at:
            d["created_at"] = row.created_at.isoformat()
        items.append(d)
    return {"status": "success", "data": items}


@router.post("")
async def create_template(
    body: PromptTemplateCreate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """创建提示词模板."""
    # 检查名称是否已存在
    existing = await session.execute(
        select(PromptTemplate).where(PromptTemplate.name == body.name.strip())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="模板名称已存在")
    
    # 解析模板变量
    import re
    variables = body.variables or ["message"]
    # 从 user_template 中提取 {{variable}} 格式的变量
    found_vars = re.findall(r'\{\{(\w+)\}\}', body.user_template)
    if found_vars:
        variables = list(dict.fromkeys(found_vars))  # 去重并保持顺序
    
    template = PromptTemplate(
        name=body.name.strip(),
        description=body.description.strip() if body.description else None,
        system_prompt=body.system_prompt.strip(),
        user_template=body.user_template.strip(),
        variables=variables,
    )
    session.add(template)
    await session.commit()
    await session.refresh(template)
    
    d = PromptTemplateInResponse.model_validate(template).model_dump()
    if template.created_at:
        d["created_at"] = template.created_at.isoformat()
    return {"status": "success", "data": d}


@router.get("/{template_id}")
async def get_template(
    template_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """获取单个提示词模板详情."""
    result = await session.execute(
        select(PromptTemplate).where(PromptTemplate.template_id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    
    d = PromptTemplateInResponse.model_validate(template).model_dump()
    if template.created_at:
        d["created_at"] = template.created_at.isoformat()
    return {"status": "success", "data": d}


@router.put("/{template_id}")
async def update_template(
    template_id: str,
    body: PromptTemplateUpdate,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """更新提示词模板."""
    result = await session.execute(
        select(PromptTemplate).where(PromptTemplate.template_id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    
    if template.is_builtin and body.name is not None:
        raise HTTPException(status_code=400, detail="不能修改内置模板的名称")
    
    if body.name is not None:
        name = body.name.strip()
        if name != template.name:
            existing = await session.execute(
                select(PromptTemplate).where(PromptTemplate.name == name)
            )
            if existing.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="模板名称已存在")
            template.name = name
    
    if body.description is not None:
        template.description = body.description.strip() if body.description else None
    if body.system_prompt is not None:
        template.system_prompt = body.system_prompt.strip()
    if body.user_template is not None:
        template.user_template = body.user_template.strip()
        # 重新解析变量
        import re
        found_vars = re.findall(r'\{\{(\w+)\}\}', template.user_template)
        if found_vars:
            template.variables = list(dict.fromkeys(found_vars))
    if body.variables is not None:
        template.variables = body.variables
    
    await session.commit()
    await session.refresh(template)
    
    d = PromptTemplateInResponse.model_validate(template).model_dump()
    if template.created_at:
        d["created_at"] = template.created_at.isoformat()
    return {"status": "success", "data": d}


@router.delete("/{template_id}")
async def delete_template(
    template_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """删除提示词模板（不能删除内置模板）."""
    result = await session.execute(
        select(PromptTemplate).where(PromptTemplate.template_id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    if template.is_builtin:
        raise HTTPException(status_code=400, detail="不能删除内置模板")
    
    # 检查是否有 Bot 正在使用此模板
    from app.db.models import BotAccount
    using_bots = await session.execute(
        select(BotAccount).where(BotAccount.template_id == template_id)
    )
    if using_bots.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="有 Bot 正在使用此模板，无法删除")
    
    await session.delete(template)
    await session.commit()
    return {"status": "success", "message": "已删除"}
