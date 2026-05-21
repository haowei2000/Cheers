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
    PromptTemplateDefaultBotInResponse,
    PromptTemplateInResponse,
    PromptTemplateOwnerInResponse,
    PromptTemplateUpdate,
)
from app.db.models import BotAccount, PromptTemplate, User
from app.services.admin_service import (
    PromptTemplateService,
    can_manage_template,
    normalize_template_tags,
    template_scope,
)
from app.services.bot_service import BotService

router = APIRouter(prefix="/templates", tags=["templates"])


def _owner_payload(owner: User | None) -> PromptTemplateOwnerInResponse | None:
    if not owner:
        return None
    return PromptTemplateOwnerInResponse(
        user_id=owner.user_id,
        username=owner.username,
        display_name=owner.display_name,
    )


def _default_bot_payload(bot: BotAccount | None) -> PromptTemplateDefaultBotInResponse | None:
    if not bot:
        return None
    return PromptTemplateDefaultBotInResponse(
        bot_id=bot.bot_id,
        username=bot.username,
        display_name=bot.display_name,
        avatar_url=bot.avatar_url,
    )


async def _load_owners(session: AsyncSession, templates: list[PromptTemplate]) -> dict[str, User]:
    owner_ids = {t.created_by for t in templates if t.created_by}
    if not owner_ids:
        return {}
    result = await session.execute(select(User).where(User.user_id.in_(owner_ids)))
    return {u.user_id: u for u in result.scalars().all()}


async def _load_visible_default_bots(
    session: AsyncSession,
    templates: list[PromptTemplate],
    current_user: User,
) -> dict[str, BotAccount]:
    bot_ids = {t.default_bot_id for t in templates if getattr(t, "default_bot_id", None)}
    if not bot_ids:
        return {}
    result = await session.execute(select(BotAccount).where(BotAccount.bot_id.in_(bot_ids)))
    bot_svc = BotService(session)
    visible: dict[str, BotAccount] = {}
    for bot in result.scalars().all():
        if await bot_svc.can_use(bot, current_user):
            visible[bot.bot_id] = bot
    return visible


def _template_out(
    t: PromptTemplate,
    locale: str = "en",
    *,
    current_user: User,
    owner: User | None = None,
    default_bot: BotAccount | None = None,
) -> dict:
    d = PromptTemplateInResponse.model_validate(t).model_dump()
    d["scope"] = template_scope(t)
    d["tags"] = normalize_template_tags(getattr(t, "tags", None))
    visible_default_bot = default_bot if default_bot and default_bot.bot_id == t.default_bot_id else None
    d["default_bot_id"] = visible_default_bot.bot_id if visible_default_bot else None
    payload = _default_bot_payload(visible_default_bot)
    d["default_bot"] = payload.model_dump() if payload else None
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
    default_bots = await _load_visible_default_bots(session, templates, current_user)
    locale = locale_from_headers(request.headers)
    return APIResponse.ok([
        _template_out(
            t,
            locale,
            current_user=current_user,
            owner=owners.get(t.created_by or ""),
            default_bot=default_bots.get(t.default_bot_id or ""),
        )
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
    default_bots = await _load_visible_default_bots(session, [tmpl], current_user)
    return APIResponse.ok(
        _template_out(
            tmpl,
            locale_from_headers(request.headers),
            current_user=current_user,
            owner=owner,
            default_bot=default_bots.get(tmpl.default_bot_id or ""),
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
        tags=body.tags,
        default_bot_id=body.default_bot_id,
        scope=body.scope,
        created_by=current_user.user_id,
        user=current_user,
    )
    default_bots = await _load_visible_default_bots(session, [tmpl], current_user)
    return APIResponse.ok(
        _template_out(
            tmpl,
            current_user=current_user,
            owner=current_user,
            default_bot=default_bots.get(tmpl.default_bot_id or ""),
        )
    )


@router.patch("/{template_id}", response_model=APIResponse[dict])
async def update_template(
    template_id: str,
    body: PromptTemplateUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "default_bot_id" in body.model_fields_set:
        updates["default_bot_id"] = body.default_bot_id
    tmpl = await svc.update(template_id, user=current_user, **updates)
    owner = await session.get(User, tmpl.created_by) if tmpl.created_by else None
    default_bots = await _load_visible_default_bots(session, [tmpl], current_user)
    return APIResponse.ok(
        _template_out(
            tmpl,
            current_user=current_user,
            owner=owner,
            default_bot=default_bots.get(tmpl.default_bot_id or ""),
        )
    )


@router.delete("/{template_id}", response_model=APIResponse[None])
async def delete_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = PromptTemplateService(session)
    await svc.delete(template_id, user=current_user)
    return APIResponse.ok(None)
