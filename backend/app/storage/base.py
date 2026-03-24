"""S3-compatible object storage abstractions used by RustFS integration."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass(frozen=True)
class StorageObjectRef:
    """A stable reference derived from a file_id."""

    file_id: str
    bucket: str
    object_key: str
    filename: str | None = None


@dataclass(frozen=True)
class PresignedUpload:
    """Data required by the frontend to upload directly to object storage."""

    file_id: str
    bucket: str
    object_key: str
    upload_url: str
    headers: dict[str, str]
    expires_in: int


@dataclass(frozen=True)
class StorageObjectHead:
    """Normalized object metadata for head_object results."""

    file_id: str
    bucket: str
    object_key: str
    content_length: int
    content_type: str | None = None
    etag: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class StorageObject:
    """A fully loaded object."""

    head: StorageObjectHead
    body: bytes


class StorageError(Exception):
    """Base storage exception."""


class StorageConfigError(StorageError):
    """Storage configuration is missing or invalid."""


class StorageClientInitError(StorageError):
    """The storage client could not be initialized."""


class StorageBucketError(StorageError):
    """The configured bucket could not be created or accessed."""


class StorageObjectNotFoundError(StorageError):
    """The requested object was not found."""


class StorageProvider(ABC):
    """Abstract storage interface used by the rest of the application."""

    @abstractmethod
    def build_object_key(self, file_id: str, *, scope: str = "uploads") -> str:
        raise NotImplementedError

    @abstractmethod
    def resolve_file_id(self, file_id: str, *, scope: str = "uploads") -> StorageObjectRef:
        raise NotImplementedError

    @abstractmethod
    async def ensure_bucket_exists(self) -> None:
        raise NotImplementedError

    @abstractmethod
    def create_presigned_put_url(
        self,
        file_id: str,
        *,
        content_type: str,
        filename: str | None = None,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> PresignedUpload:
        raise NotImplementedError

    @abstractmethod
    async def head_object(self, file_id: str, *, scope: str = "uploads") -> StorageObjectHead:
        raise NotImplementedError

    @abstractmethod
    async def get_object(self, file_id: str, *, scope: str = "uploads") -> StorageObject:
        raise NotImplementedError

    @abstractmethod
    async def put_metadata_if_needed(
        self,
        file_id: str,
        metadata: dict[str, str],
        *,
        scope: str = "uploads",
    ) -> None:
        raise NotImplementedError

    @abstractmethod
    async def put_object(
        self,
        file_id: str,
        data: bytes,
        content_type: str,
        *,
        scope: str = "uploads",
    ) -> StorageObjectRef:
        raise NotImplementedError

    @abstractmethod
    def create_presigned_get_url(
        self,
        file_id: str,
        *,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> str:
        raise NotImplementedError
