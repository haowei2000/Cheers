"""Image Gen v1 路由（文生图 / 图生图 / 设置）."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_session, require_permission
from app.core.responses import APIResponse
from app.db.models import User
from app.services.admin_service import SettingsService
from app.services.image_gen.service import (
    IMAGE_EDIT_MODELS,
    IMAGE_GEN_MODELS,
    SUPPORTED_SIZES,
    ImageGenError,
    ImageGenService,
)
from app.services.storage.bootstrap import get_storage_service, is_storage_enabled

logger = logging.getLogger("app.api.v1.image_gen")

router = APIRouter(prefix="/images", tags=["image-gen"])


class ImageGenBody(BaseModel):
    channel_id: str = Field(..., min_length=1)
    sender_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1, max_length=2000)
    model: str = ""
    size: str = "1024*1024"


class ImageEditBody(BaseModel):
    channel_id: str = Field(..., min_length=1)
    sender_id: str = Field(..., min_length=1)
    source_file_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1, max_length=2000)
    model: str = ""
    size: str = "1024*1024"


class ImageSettingsBody(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    default_model: str | None = None


@router.post("/generate", response_model=APIResponse[dict])
async def generate_image(
    body: ImageGenBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    storage = get_storage_service() if is_storage_enabled() else None
    service = ImageGenService(storage=storage)
    try:
        result = await service.generate(
            session=session,
            channel_id=body.channel_id,
            sender_id=body.sender_id,
            prompt=body.prompt,
            model=body.model or None,
            size=body.size,
        )
    except ImageGenError as exc:
        from app.core.exceptions import AppError
        raise AppError(exc.detail)
    except Exception as exc:
        logger.exception("image generation failed")
        from app.core.exceptions import AppError
        raise AppError(f"图片生成失败: {exc}") from exc
    await session.commit()
    return APIResponse.ok({"file_id": result.file_id, "preview_url": result.preview_url, "content_type": result.content_type})


@router.post("/edit", response_model=APIResponse[dict])
async def edit_image(
    body: ImageEditBody,
    session: AsyncSession = Depends(get_session),
) -> APIResponse:
    storage = get_storage_service() if is_storage_enabled() else None
    service = ImageGenService(storage=storage)
    try:
        result = await service.edit(
            session=session,
            channel_id=body.channel_id,
            sender_id=body.sender_id,
            source_file_id=body.source_file_id,
            prompt=body.prompt,
            model=body.model or None,
            size=body.size,
        )
    except ImageGenError as exc:
        from app.core.exceptions import AppError
        raise AppError(exc.detail)
    except Exception as exc:
        logger.exception("image edit failed")
        from app.core.exceptions import AppError
        raise AppError(f"图片编辑失败: {exc}") from exc
    await session.commit()
    return APIResponse.ok({"file_id": result.file_id, "preview_url": result.preview_url, "content_type": result.content_type})


@router.get("/models", response_model=APIResponse[dict])
async def list_image_models() -> APIResponse:
    return APIResponse.ok({"gen_models": IMAGE_GEN_MODELS, "edit_models": IMAGE_EDIT_MODELS, "sizes": SUPPORTED_SIZES})


@router.get("/settings", response_model=APIResponse[dict])
async def get_settings() -> APIResponse:
    return APIResponse.ok(SettingsService.get_image_gen_settings())


@router.put("/settings", response_model=APIResponse[dict])
async def update_settings(
    body: ImageSettingsBody,
    _: User = Depends(require_permission("system_settings")),
) -> APIResponse:
    updated = SettingsService.set_image_gen_settings(
        base_url=body.base_url,
        api_key=body.api_key,
        default_model=body.default_model
    )
    return APIResponse.ok(updated)
