"""Templates API routes."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.builtin_defaults import builtin_prompt_template
from app.core.dependencies import get_current_user, get_session
from app.core.localization import locale_from_headers
from app.core.responses import APIResponse
from app.core.schemas import (
    PromptTemplateCreate,
    PromptTemplateInResponse,
    PromptTemplateOwnerInResponse,
    PromptTemplateUpdate,
)
from app.db.models import PromptTemplate, User
from app.services.admin_service import (
    PromptTemplateService,
    can_manage_template,
    template_scope,
)

router = APIRouter(prefix="/templates", tags=["templates"])


def _owner_payload(owner: User | None) -> PromptTemplateOwnerInResponse | None:
    if not owner:
        return None
    return PromptTemplateOwnerInResponse(
        user_id=owner.user_id,
        username=owner.username,
        display_name=owner.display_name,
    )


async def _load_owners(session: AsyncSession, templates: list[PromptTemplate]) -> dict[str, User]:
    owner_ids = {t.created_by for t in templates if t.created_by}
    if not owner_ids:
        return {}
    result = await session.execute(select(User).where(User.user_id.in_(owner_ids)))
    return {u.user_id: u for u in result.scalars().all()}


def _template_out(
    t: PromptTemplate,
    locale: str = "en",
    *,
    current_user: User,
    owner: User | None = None,
) -> dict:
    d = PromptTemplateInResponse.model_validate(t).model_dump()
    d["scope"] = template_scope(t)
    d["owner"] = _owner_payload(owner).model_dump() if owner else None
    d["can_manage"] = can_manage_template(t, current_user)
    if t.is_builtin:
        localized_template = builtin_prompt_template(t.template_id, locale)
        if localized_template is not None:
            d.update(
                {
                    "name": localized_template.name,
                    "description": localized_template.description,
                    "system_prompt": localized_template.system_prompt,
                    "user_template": localized_template.user_template,
                    "variables": localized_template.variables,
                }
            )
    if t.created_at:
        d["created_at"] = t.created_at.isoformat()
    return d


@router.get("", response_model=APIResponse[list[dict]])
async def list_templates(
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    """List templates."""
    svc = PromptTemplateService(session)
    templates = await svc.list_visible(current_user)
    owners = await _load_owners(session, templates)
    locale = locale_from_headers(request.headers)
    return APIResponse.ok([
        _template_out(t, locale, current_user=current_user, owner=owners.get(t.created_by or ""))
        for t in templates
    ])


@router.get("/{template_id}", response_model=APIResponse[dict])
async def get_template(
    template_id: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    tmpl = await svc.get_visible_or_404(template_id, current_user)
    owner = await session.get(User, tmpl.created_by) if tmpl.created_by else None
    return APIResponse.ok(
        _template_out(
            tmpl,
            locale_from_headers(request.headers),
            current_user=current_user,
            owner=owner,
        )
    )


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
        scope=body.scope,
        created_by=current_user.user_id,
    )
    return APIResponse.ok(_template_out(tmpl, current_user=current_user, owner=current_user))


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
    owner = await session.get(User, tmpl.created_by) if tmpl.created_by else None
    return APIResponse.ok(_template_out(tmpl, current_user=current_user, owner=owner))


@router.delete("/{template_id}", response_model=APIResponse[None])
async def delete_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    await svc.delete(template_id, user=current_user)
    return APIResponse.ok(None)
