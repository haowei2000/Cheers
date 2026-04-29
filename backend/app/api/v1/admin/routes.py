"""Admin v1 routes still used by modal settings and QA export."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_session, require_permission
from app.core.responses import APIResponse
from app.core.schemas import AIModelCreate, AIModelInResponse, AIModelUpdate
from app.db.models import AIModel, User
from app.services.admin_service import AIModelService, QaSummaryService, SettingsService
from app.utils.crypto import decrypt_value

audit = logging.getLogger("app.audit")

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_permission("system_settings"))],
)

_model_router = APIRouter(prefix="/models")


def _model_out(m: AIModel) -> dict:
    d = AIModelInResponse.model_validate(m).model_dump()
    if m.created_at:
        d["created_at"] = m.created_at.isoformat()
    raw_key = m.api_key or ""
    if raw_key:
        try:
            raw_key = decrypt_value(raw_key)
        except Exception:
            pass
    d["api_key_masked"] = ("****" + raw_key[-4:]) if len(raw_key) > 4 else ("****" if raw_key else None)
    return d


@_model_router.get("", response_model=APIResponse[list[dict]])
async def list_models(session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = AIModelService(session)
    return APIResponse.ok([_model_out(m) for m in await svc.list_all()])


@_model_router.get("/{model_id}", response_model=APIResponse[dict])
async def get_model(model_id: str, session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = AIModelService(session)
    model = await svc.get_or_404(model_id)
    return APIResponse.ok(_model_out(model))


@_model_router.post("", response_model=APIResponse[dict])
async def create_model(
    body: AIModelCreate,
    current_user: User = Depends(require_permission("system_settings")),
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    from app.utils.crypto import encrypt_value

    svc = AIModelService(session)
    api_key = encrypt_value(body.api_key) if body.api_key else None
    model = await svc.create(
        name=body.name,
        provider=body.provider,
        model_name=body.model_name,
        base_url=body.base_url,
        api_key=api_key,
        description=body.description,
        is_public=body.is_public,
        config=body.config,
        created_by=current_user.user_id,
    )
    audit.info("action=model.create actor=%s resource_id=%s name=%s", current_user.user_id, model.model_id, body.name)
    return APIResponse.ok(_model_out(model))


@_model_router.patch("/{model_id}", response_model=APIResponse[dict])
async def update_model(
    model_id: str,
    body: AIModelUpdate,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    svc = AIModelService(session)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if "api_key" in updates and updates["api_key"]:
        from app.utils.crypto import encrypt_value

        updates["api_key"] = encrypt_value(updates["api_key"])
    model = await svc.update(model_id, **updates)
    audit.info("action=model.update resource_id=%s fields=%s", model_id, list(updates.keys()))
    return APIResponse.ok(_model_out(model))


@_model_router.delete("/{model_id}", response_model=APIResponse[None])
async def delete_model(model_id: str, session: AsyncSession = Depends(get_session)) -> APIResponse:
    svc = AIModelService(session)
    await svc.delete(model_id)
    audit.info("action=model.delete resource_id=%s", model_id)
    return APIResponse.ok(None)


router.include_router(_model_router)


@router.get("/settings/llm", response_model=APIResponse[dict])
async def get_llm_settings() -> APIResponse:
    return APIResponse.ok(SettingsService.get_llm_settings())


class QaPairItem(BaseModel):
    question: str = ""
    answer: str = ""
    question_time: str = ""
    answer_time: str = ""


class QaSummarizeBody(BaseModel):
    channel_name: str = ""
    pairs: list[QaPairItem] = []


@router.post("/qa/summarize", response_model=APIResponse[dict])
async def summarize_qa(body: QaSummarizeBody) -> APIResponse:
    content = await QaSummaryService.summarize_qa(
        channel_name=body.channel_name,
        pairs=[p.model_dump() for p in body.pairs],
    )
    return APIResponse.ok({"summary_markdown": content})
