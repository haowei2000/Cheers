"""文生图 / 图生图服务：调用 DashScope 原生多模态图片生成 API。"""
from __future__ import annotations

import base64
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import FileRecord
from app.storage.base import StorageProvider

logger = logging.getLogger("app.image_gen.service")

# DashScope 原生图片生成端点（相对于 base_url）
DASHSCOPE_IMAGE_PATH = "/api/v1/services/aigc/multimodal-generation/generation"

# DashScope 支持的图片尺寸
SUPPORTED_SIZES = [
    "1024*1024",
    "720*1280",
    "1280*720",
    "768*1024",
    "1024*768",
]

IMAGE_GEN_MODELS = [
    "qwen-image-2.0-pro",
    "qwen-image-2.0-pro-2026-03-03",
    "qwen-image-2.0",
    "qwen-image-2.0-2026-03-03",
    "qwen-image-max",
    "qwen-image-max-2025-12-30",
    "qwen-image-plus-2026-01-09",
    "z-image-turbo",
]

IMAGE_EDIT_MODELS = [
    "qwen-image-edit-max",
    "qwen-image-edit-plus",
]


def _effective_config() -> tuple[str, str, str]:
    """返回生效的 (base_url, api_key, default_model)，admin 设置优先于 env。"""
    try:
        from app.admin.settings_store import get_image_gen_effective_config
        return get_image_gen_effective_config()
    except Exception:
        return (
            settings.image_gen_base_url,
            settings.image_gen_api_key,
            settings.image_gen_default_model,
        )


@dataclass(frozen=True)
class ImageGenResult:
    file_id: str
    preview_url: str
    content_type: str


class ImageGenError(Exception):
    def __init__(self, detail: str, *, status_code: int = 500) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class ImageGenService:
    """调用 DashScope 原生 API 进行文生图与图生图。"""

    def __init__(self, storage: StorageProvider | None = None) -> None:
        self.storage = storage

    # ── 内部：从 DashScope 原生响应中提取图片 URL 并下载 ──────────────────

    @staticmethod
    async def _extract_image_bytes(data: dict) -> tuple[bytes, str]:
        """从 DashScope 原生响应中提取图片。

        响应格式：
        {
          "output": {
            "choices": [{
              "message": {
                "content": [{"image": "https://...oss-url..."}]
              }
            }]
          }
        }
        """
        output = data.get("output", {})
        choices = output.get("choices", [])
        if not choices:
            raise ImageGenError("图片 API 返回空结果 (no choices)")

        content_list = (choices[0].get("message") or {}).get("content", [])
        image_url = None
        for item in content_list:
            if isinstance(item, dict) and item.get("image"):
                image_url = item["image"]
                break

        if not image_url:
            raise ImageGenError("图片 API 返回格式异常（未找到 image URL）")

        # DashScope 返回的图片链接 24 小时过期，必须立即下载
        content_type = "image/png"
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                dl_resp = await client.get(image_url)
                dl_resp.raise_for_status()
                image_bytes = dl_resp.content
                ct = dl_resp.headers.get("content-type", "")
                if ct.startswith("image/"):
                    content_type = ct.split(";")[0].strip()
        except Exception as exc:
            logger.error("image: failed to download result image: %s", exc)
            raise ImageGenError("下载生成图片失败") from exc

        if not image_bytes:
            raise ImageGenError("图片内容为空")
        return image_bytes, content_type

    # ── 内部：保存图片到存储 ─────────────────────────────────────────────

    async def _save_image(
        self,
        session: AsyncSession,
        image_bytes: bytes,
        content_type: str,
        *,
        channel_id: str,
        sender_id: str,
    ) -> ImageGenResult:
        if self.storage is None:
            raise ImageGenError("对象存储未启用，无法保存生成图片", status_code=503)

        file_id = str(uuid.uuid4())
        ref = await self.storage.put_object(
            file_id, image_bytes, content_type, scope="generated",
        )
        preview_url = ""
        try:
            preview_url = self.storage.create_presigned_get_url(
                file_id, expires_in=3600, scope="generated",
            )
        except Exception:
            logger.warning("image: failed to create presigned get url for %s", file_id)

        record = FileRecord(
            file_id=file_id,
            channel_id=channel_id,
            uploader_id=sender_id,
            original_path=ref.object_key,
            object_key=ref.object_key,
            storage_bucket=ref.bucket,
            original_filename=f"{file_id}.png",
            content_type=content_type,
            size_bytes=len(image_bytes),
            status="ready",
            uploaded_at=datetime.utcnow(),
            converted_at=datetime.utcnow(),
        )
        session.add(record)
        await session.flush()

        return ImageGenResult(
            file_id=file_id,
            preview_url=preview_url,
            content_type=content_type,
        )

    # ── 内部：调用 API 并处理错误 ────────────────────────────────────────

    @staticmethod
    def _handle_api_error(exc: httpx.HTTPStatusError, label: str) -> ImageGenError:
        error_body = ""
        try:
            error_body = exc.response.text[:500]
        except Exception:
            pass
        logger.error("%s: HTTP %s body=%s", label, exc.response.status_code, error_body)
        return ImageGenError(
            f"图片 API 错误 (HTTP {exc.response.status_code}): {error_body}",
            status_code=502,
        )

    # ── 文生图 ────────────────────────────────────────────────────────────

    async def generate(
        self,
        *,
        session: AsyncSession,
        channel_id: str,
        sender_id: str,
        prompt: str,
        model: str | None = None,
        size: str = "1024*1024",
    ) -> ImageGenResult:
        base_url, api_key, default_model = _effective_config()
        base_url = base_url.rstrip("/")
        model_name = model or default_model

        if not api_key:
            raise ImageGenError("未配置图片 API Key，请在管理页「图片 API」中设置", status_code=503)

        if size not in SUPPORTED_SIZES:
            size = "1024*1024"

        # DashScope 原生 API 端点
        url = f"{base_url}{DASHSCOPE_IMAGE_PATH}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        # DashScope 原生请求格式
        body = {
            "model": model_name,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [{"text": prompt}],
                    }
                ]
            },
            "parameters": {
                "size": size,
                "n": 1,
            },
        }

        logger.info("image_gen: model=%s size=%s prompt=%.80s url=%s", model_name, size, prompt, url)

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as exc:
            raise self._handle_api_error(exc, "image_gen") from exc
        except httpx.ConnectError as exc:
            raise ImageGenError(f"无法连接图片 API: {base_url}", status_code=502) from exc
        except Exception as exc:
            logger.exception("image_gen: unexpected error")
            raise ImageGenError(f"图片生成失败: {exc}") from exc

        image_bytes, content_type = await self._extract_image_bytes(data)
        return await self._save_image(
            session, image_bytes, content_type,
            channel_id=channel_id, sender_id=sender_id,
        )

    # ── 图生图 ────────────────────────────────────────────────────────────

    async def edit(
        self,
        *,
        session: AsyncSession,
        channel_id: str,
        sender_id: str,
        source_file_id: str,
        prompt: str,
        model: str | None = None,
        size: str = "1024*1024",
    ) -> ImageGenResult:
        base_url, api_key, _ = _effective_config()
        base_url = base_url.rstrip("/")
        model_name = model or "qwen-image-edit-max"

        if not api_key:
            raise ImageGenError("未配置图片 API Key，请在管理页「图片 API」中设置", status_code=503)

        if self.storage is None:
            raise ImageGenError("对象存储未启用", status_code=503)

        if size not in SUPPORTED_SIZES:
            size = "1024*1024"

        # 1) 从存储读取源图片
        result = await session.execute(
            select(FileRecord).where(FileRecord.file_id == source_file_id)
        )
        source_rec = result.scalar_one_or_none()
        if not source_rec:
            raise ImageGenError("源图片不存在", status_code=404)

        scope = "generated" if (source_rec.object_key or "").startswith("generated/") else "uploads"
        try:
            obj = await self.storage.get_object(source_file_id, scope=scope)
        except Exception as exc:
            raise ImageGenError(f"无法读取源图片: {exc}") from exc

        source_bytes = obj.body
        source_ct = source_rec.content_type or "image/png"

        # 将源图片编码为 base64 data URI
        source_b64 = base64.b64encode(source_bytes).decode("ascii")
        image_data_uri = f"data:{source_ct};base64,{source_b64}"

        # 2) 调用 DashScope 原生 API（JSON，非 multipart）
        url = f"{base_url}{DASHSCOPE_IMAGE_PATH}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        # 图生图：content 数组中包含 image 和 text
        body = {
            "model": model_name,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"image": image_data_uri},
                            {"text": prompt},
                        ],
                    }
                ]
            },
            "parameters": {
                "size": size,
                "n": 1,
            },
        }

        logger.info(
            "image_edit: model=%s size=%s source=%s prompt=%.80s url=%s",
            model_name, size, source_file_id, prompt, url,
        )

        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as exc:
            raise self._handle_api_error(exc, "image_edit") from exc
        except httpx.ConnectError as exc:
            raise ImageGenError(f"无法连接图片 API: {base_url}", status_code=502) from exc
        except Exception as exc:
            logger.exception("image_edit: unexpected error")
            raise ImageGenError(f"图片编辑失败: {exc}") from exc

        image_bytes, content_type = await self._extract_image_bytes(data)
        return await self._save_image(
            session, image_bytes, content_type,
            channel_id=channel_id, sender_id=sender_id,
        )
