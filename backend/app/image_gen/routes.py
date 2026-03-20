"""图片生成 / 编辑 REST API。"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin.settings_store import get_image_gen_settings, set_image_gen_settings
from app.db.session import get_session
from app.image_gen.service import (
    IMAGE_EDIT_MODELS,
    IMAGE_GEN_MODELS,
    SUPPORTED_SIZES,
    ImageGenError,
    ImageGenService,
)
from app.storage.bootstrap import get_storage_service, is_storage_enabled

logger = logging.getLogger("app.image_gen.routes")

router = APIRouter(prefix="/api/images", tags=["image-gen"])


# ── 请求模型 ────────────────────────────────────────────────────────────

class ImageGenRequest(BaseModel):
    channel_id: str = Field(..., min_length=1)
    sender_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1, max_length=2000)
    model: str = ""
    size: str = "1024*1024"


class ImageEditRequest(BaseModel):
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


# ── 文生图 ──────────────────────────────────────────────────────────────

@router.post("/generate")
async def generate_image(
    body: ImageGenRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """调用文生图 API，生成图片并存入对象存储。"""
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
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:
        logger.exception("image generation failed")
        raise HTTPException(status_code=500, detail=f"图片生成失败: {exc}") from exc

    # 必须在返回响应前 commit，否则前端立即请求预览时 FileRecord 尚未可见
    await session.commit()

    return {
        "status": "success",
        "data": {
            "file_id": result.file_id,
            "preview_url": result.preview_url,
            "content_type": result.content_type,
        },
    }


# ── 图生图 ──────────────────────────────────────────────────────────────

@router.post("/edit")
async def edit_image(
    body: ImageEditRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """调用图生图 API，编辑图片并存入对象存储。"""
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
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:
        logger.exception("image edit failed")
        raise HTTPException(status_code=500, detail=f"图片编辑失败: {exc}") from exc

    # 必须在返回响应前 commit，否则前端立即请求预览时 FileRecord 尚未可见
    await session.commit()

    return {
        "status": "success",
        "data": {
            "file_id": result.file_id,
            "preview_url": result.preview_url,
            "content_type": result.content_type,
        },
    }


# ── 模型与尺寸 ────────────────────────────────────────────────────────

@router.get("/models")
async def list_image_models() -> dict:
    """返回可用的文生图 / 图生图模型列表。"""
    return {
        "status": "success",
        "data": {
            "gen_models": IMAGE_GEN_MODELS,
            "edit_models": IMAGE_EDIT_MODELS,
            "sizes": SUPPORTED_SIZES,
        },
    }


# ── 图片 API 设置 ────────────────────────────────────────────────────

@router.get("/settings")
async def get_settings() -> dict:
    """获取图片 API 设置（api_key 脱敏）。"""
    return {"status": "success", "data": get_image_gen_settings()}


@router.put("/settings")
async def update_settings(body: ImageSettingsBody) -> dict:
    """更新图片 API 设置。"""
    updated = set_image_gen_settings(
        base_url=body.base_url,
        api_key=body.api_key,
        default_model=body.default_model,
    )
    return {"status": "success", "data": updated}
