"""Templates API routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.responses import APIResponse
from app.core.schemas import PromptTemplateCreate, PromptTemplateInResponse, PromptTemplateUpdate
from app.db.models import PromptTemplate, User
from app.services.admin_service import PromptTemplateService

router = APIRouter(prefix="/templates", tags=["templates"])


def _template_out(t: PromptTemplate) -> dict:
    d = PromptTemplateInResponse.model_validate(t).model_dump()
    if t.created_at:
        d["created_at"] = t.created_at.isoformat()
    return d


@router.get("", response_model=APIResponse[list[dict]])
async def list_templates(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """List templates."""
    svc = PromptTemplateService(session)
    templates = await svc.list_visible(current_user)
    return APIResponse.ok([_template_out(t) for t in templates])


@router.get("/{template_id}", response_model=APIResponse[dict])
async def get_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    tmpl = await svc.get_or_404(template_id)
    return APIResponse.ok(_template_out(tmpl))


@router.post("", response_model=APIResponse[dict])
async def create_template(
    body: PromptTemplateCreate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    tmpl = await svc.create(
        name=body.name,
        system_prompt=body.system_prompt,
        user_template=body.user_template,
        description=body.description,
        variables=body.variables,
        created_by=current_user.user_id,
    )
    return APIResponse.ok(_template_out(tmpl))


@router.patch("/{template_id}", response_model=APIResponse[dict])
async def update_template(
    template_id: str,
    body: PromptTemplateUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    tmpl = await svc.update(template_id, user=current_user, **updates)
    return APIResponse.ok(_template_out(tmpl))


@router.delete("/{template_id}", response_model=APIResponse[None])
async def delete_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    await svc.delete(template_id, user=current_user)
    return APIResponse.ok(None)
