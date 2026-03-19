"""Storage services package."""

from app.storage.base import (
    PresignedUpload,
    StorageBucketError,
    StorageClientInitError,
    StorageConfigError,
    StorageObject,
    StorageObjectHead,
    StorageObjectNotFoundError,
    StorageObjectRef,
    StorageProvider,
)
from app.storage.bootstrap import build_storage_service, get_storage_service, initialize_storage, is_storage_enabled
from app.storage.s3_compatible import S3CompatibleStorageService, S3CompatibleStorageSettings

__all__ = [
    "PresignedUpload",
    "S3CompatibleStorageService",
    "S3CompatibleStorageSettings",
    "StorageBucketError",
    "StorageClientInitError",
    "StorageConfigError",
    "StorageObject",
    "StorageObjectHead",
    "StorageObjectNotFoundError",
    "StorageObjectRef",
    "StorageProvider",
    "build_storage_service",
    "get_storage_service",
    "initialize_storage",
    "is_storage_enabled",
]
