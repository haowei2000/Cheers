"""Bootstrap helpers for storage initialization."""
from __future__ import annotations

import logging
from typing import Any

from app.config import settings
from app.storage.base import StorageProvider
from app.storage.s3_compatible import S3CompatibleStorageService, S3CompatibleStorageSettings

logger = logging.getLogger("app.storage.bootstrap")

_storage_service: StorageProvider | None = None


def is_storage_enabled(app_settings: Any = settings) -> bool:
    backend = (getattr(app_settings, "storage_backend", "none") or "none").strip().lower()
    return backend in {"s3", "s3_compatible", "rustfs"}


def build_storage_service(app_settings: Any = settings) -> StorageProvider | None:
    if not is_storage_enabled(app_settings):
        return None
    config = S3CompatibleStorageSettings.from_app_settings(app_settings)
    return S3CompatibleStorageService(config)


async def initialize_storage(app_settings: Any = settings) -> StorageProvider | None:
    """Initialize storage on startup when configured."""
    global _storage_service
    service = build_storage_service(app_settings)
    if service is None:
        logger.info("storage disabled; skipping initialization")
        _storage_service = None
        return None
    await service.ensure_bucket_exists()
    _storage_service = service
    logger.info("storage initialized backend=%s bucket=%s", app_settings.storage_backend, app_settings.storage_s3_bucket)
    return service


def get_storage_service() -> StorageProvider:
    if _storage_service is None:
        raise RuntimeError("storage service is not initialized")
    return _storage_service
