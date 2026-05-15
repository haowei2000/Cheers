"""S3-compatible storage service used for RustFS and future providers."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote as _url_quote
from urllib.parse import urlparse

from app.services.storage.base import (
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

logger = logging.getLogger("app.services.storage.s3")

_VALID_FILE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$")


def _import_boto3() -> tuple[Any, Any, Any]:
    try:
        import boto3
        from botocore.client import Config
        from botocore.exceptions import BotoCoreError, ClientError
        return boto3, Config, (BotoCoreError, ClientError)
    except ImportError as exc:
        raise StorageClientInitError(
            "boto3/botocore is required for S3-compatible storage support"
        ) from exc


@dataclass(frozen=True)
class S3CompatibleStorageSettings:
    """Resolved object storage configuration."""

    endpoint: str
    bucket: str
    region: str
    access_key: str
    secret_key: str
    public_endpoint: str | None
    force_path_style: bool
    presign_expires_seconds: int
    auto_create_bucket: bool
    verify_ssl: bool

    @classmethod
    def from_app_settings(cls, app_settings: Any) -> "S3CompatibleStorageSettings":
        endpoint = (getattr(app_settings, "storage_s3_endpoint", "") or "").strip()
        bucket = (getattr(app_settings, "storage_s3_bucket", "") or "").strip()
        access_key = (getattr(app_settings, "storage_s3_access_key", "") or "").strip()
        secret_key = (getattr(app_settings, "storage_s3_secret_key", "") or "").strip()
        public_endpoint = (getattr(app_settings, "storage_s3_public_endpoint", "") or "").strip() or None
        region = (getattr(app_settings, "storage_s3_region", "") or "us-east-1").strip()
        force_path_style = bool(getattr(app_settings, "storage_s3_force_path_style", True))
        presign_expires = int(getattr(app_settings, "storage_presign_expires_seconds", 900) or 900)
        auto_create_bucket = bool(getattr(app_settings, "storage_s3_auto_create_bucket", True))
        verify_ssl = bool(getattr(app_settings, "storage_s3_verify_ssl", True))

        missing = []
        if not endpoint:
            missing.append("STORAGE_S3_ENDPOINT")
        if not bucket:
            missing.append("STORAGE_S3_BUCKET")
        if not access_key:
            missing.append("STORAGE_S3_ACCESS_KEY")
        if not secret_key:
            missing.append("STORAGE_S3_SECRET_KEY")
        if missing:
            raise StorageConfigError("missing storage configuration: " + ", ".join(missing))
        if presign_expires <= 0:
            raise StorageConfigError("STORAGE_PRESIGN_EXPIRES_SECONDS must be greater than 0")
        return cls(
            endpoint=endpoint,
            bucket=bucket,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            public_endpoint=public_endpoint,
            force_path_style=force_path_style,
            presign_expires_seconds=presign_expires,
            auto_create_bucket=auto_create_bucket,
            verify_ssl=verify_ssl,
        )


class S3CompatibleStorageService(StorageProvider):
    """RustFS-friendly S3-compatible storage wrapper."""

    def __init__(self, config: S3CompatibleStorageSettings) -> None:
        self.config = config
        self._client: Any | None = None
        self._presign_client: Any | None = None

    def build_object_key(self, file_id: str, *, scope: str = "uploads") -> str:
        clean_file_id = self._validate_file_id(file_id)
        safe_scope = (scope or "uploads").strip("/").replace("\\", "/")
        prefix_a = clean_file_id[:2]
        prefix_b = clean_file_id[2:4]
        return f"{safe_scope}/{prefix_a}/{prefix_b}/{clean_file_id}/source"

    def resolve_file_id(self, file_id: str, *, scope: str = "uploads") -> StorageObjectRef:
        return StorageObjectRef(
            file_id=self._validate_file_id(file_id),
            bucket=self.config.bucket,
            object_key=self.build_object_key(file_id, scope=scope),
        )

    async def ensure_bucket_exists(self) -> None:
        await asyncio.to_thread(self._ensure_bucket_exists_sync)

    def create_presigned_put_url(
        self,
        file_id: str,
        *,
        content_type: str,
        filename: str | None = None,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> PresignedUpload:
        if not content_type or not content_type.strip():
            raise StorageConfigError("content_type is required for presigned uploads")

        ref = self.resolve_file_id(file_id, scope=scope)
        effective_expires = expires_in or self.config.presign_expires_seconds
        metadata = {"file-id": ref.file_id}
        headers = {"Content-Type": content_type}
        if filename:
            ascii_safe_name = _url_quote(filename)
            metadata["original-filename"] = ascii_safe_name
            headers["x-amz-meta-original-filename"] = ascii_safe_name
        headers["x-amz-meta-file-id"] = ref.file_id

        params = {
            "Bucket": ref.bucket,
            "Key": ref.object_key,
            "ContentType": content_type,
            "Metadata": metadata,
        }
        try:
            upload_url = self._get_presign_client().generate_presigned_url(
                "put_object",
                Params=params,
                ExpiresIn=effective_expires,
                HttpMethod="PUT",
            )
        except self._client_errors() as exc:
            raise StorageClientInitError(f"failed to generate presigned upload URL: {exc}") from exc

        return PresignedUpload(
            file_id=ref.file_id,
            bucket=ref.bucket,
            object_key=ref.object_key,
            upload_url=upload_url,
            headers=headers,
            expires_in=effective_expires,
        )

    async def head_object(self, file_id: str, *, scope: str = "uploads") -> StorageObjectHead:
        ref = self.resolve_file_id(file_id, scope=scope)
        return await asyncio.to_thread(self._head_object_sync, ref)

    async def get_object(self, file_id: str, *, scope: str = "uploads") -> StorageObject:
        ref = self.resolve_file_id(file_id, scope=scope)
        return await asyncio.to_thread(self._get_object_sync, ref)

    async def put_metadata_if_needed(
        self,
        file_id: str,
        metadata: dict[str, str],
        *,
        scope: str = "uploads",
    ) -> None:
        if not metadata:
            return
        ref = self.resolve_file_id(file_id, scope=scope)
        await asyncio.to_thread(self._put_metadata_sidecar_sync, ref, metadata)

    async def put_object(
        self,
        file_id: str,
        data: bytes,
        content_type: str,
        *,
        scope: str = "uploads",
    ) -> StorageObjectRef:
        ref = self.resolve_file_id(file_id, scope=scope)
        await asyncio.to_thread(self._put_object_sync, ref, data, content_type)
        return ref

    async def delete_object(self, file_id: str, *, scope: str = "uploads") -> None:
        ref = self.resolve_file_id(file_id, scope=scope)
        await asyncio.to_thread(self._delete_object_sync, ref)

    def create_presigned_get_url(
        self,
        file_id: str,
        *,
        expires_in: int | None = None,
        scope: str = "uploads",
    ) -> str:
        ref = self.resolve_file_id(file_id, scope=scope)
        effective_expires = expires_in or self.config.presign_expires_seconds
        try:
            return self._get_presign_client().generate_presigned_url(
                "get_object",
                Params={"Bucket": ref.bucket, "Key": ref.object_key},
                ExpiresIn=effective_expires,
                HttpMethod="GET",
            )
        except self._client_errors() as exc:
            raise StorageClientInitError(
                f"failed to generate presigned GET URL: {exc}"
            ) from exc

    def _validate_file_id(self, file_id: str) -> str:
        value = (file_id or "").strip()
        if not _VALID_FILE_ID.fullmatch(value):
            raise StorageConfigError(f"invalid file_id: {file_id!r}")
        return value

    def _client_errors(self) -> tuple[type[BaseException], ...]:
        _boto3, _config, errors = _import_boto3()
        return errors

    def _create_client(self, endpoint_url: str | None = None) -> Any:
        boto3, Config, errors = _import_boto3()
        client_config = Config(
            signature_version="s3v4",
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            s3={"addressing_style": "path" if self.config.force_path_style else "auto"},
        )
        try:
            return boto3.client(
                "s3",
                endpoint_url=endpoint_url or self.config.endpoint,
                region_name=self.config.region,
                aws_access_key_id=self.config.access_key,
                aws_secret_access_key=self.config.secret_key,
                config=client_config,
                verify=self.config.verify_ssl,
            )
        except errors as exc:
            raise StorageClientInitError(f"failed to initialize S3-compatible client: {exc}") from exc

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = self._create_client(self.config.endpoint)
        return self._client

    def _get_presign_client(self) -> Any:
        endpoint = self.config.public_endpoint or self.config.endpoint
        if self._presign_client is None:
            self._presign_client = self._create_client(endpoint)
        return self._presign_client

    def _ensure_bucket_exists_sync(self) -> None:
        client = self._get_client()
        try:
            client.head_bucket(Bucket=self.config.bucket)
            logger.info("storage bucket ready bucket=%s endpoint=%s", self.config.bucket, self._safe_endpoint())
            return
        except self._client_errors() as exc:
            if not self._is_not_found_error(exc):
                raise StorageBucketError(
                    f"failed to access bucket {self.config.bucket}: {exc}"
                ) from exc

        if not self.config.auto_create_bucket:
            raise StorageBucketError(
                f"bucket {self.config.bucket} does not exist and auto creation is disabled"
            )

        params: dict[str, Any] = {"Bucket": self.config.bucket}
        if self.config.region and self.config.region != "us-east-1":
            params["CreateBucketConfiguration"] = {"LocationConstraint": self.config.region}
        try:
            client.create_bucket(**params)
            logger.info("storage bucket created bucket=%s endpoint=%s", self.config.bucket, self._safe_endpoint())
        except self._client_errors() as exc:
            raise StorageBucketError(f"failed to create bucket {self.config.bucket}: {exc}") from exc

    def _head_object_sync(self, ref: StorageObjectRef) -> StorageObjectHead:
        client = self._get_client()
        try:
            response = client.head_object(Bucket=ref.bucket, Key=ref.object_key)
        except self._client_errors() as exc:
            if self._is_not_found_error(exc):
                raise StorageObjectNotFoundError(
                    f"object not found for file_id={ref.file_id}"
                ) from exc
            raise StorageClientInitError(f"failed to head object for file_id={ref.file_id}: {exc}") from exc
        return StorageObjectHead(
            file_id=ref.file_id,
            bucket=ref.bucket,
            object_key=ref.object_key,
            content_length=int(response.get("ContentLength") or 0),
            content_type=response.get("ContentType"),
            etag=(response.get("ETag") or "").strip('"') or None,
            metadata={str(k): str(v) for k, v in (response.get("Metadata") or {}).items()},
        )

    def _get_object_sync(self, ref: StorageObjectRef) -> StorageObject:
        client = self._get_client()
        try:
            response = client.get_object(Bucket=ref.bucket, Key=ref.object_key)
        except self._client_errors() as exc:
            if self._is_not_found_error(exc):
                raise StorageObjectNotFoundError(
                    f"object not found for file_id={ref.file_id}"
                ) from exc
            raise StorageClientInitError(f"failed to get object for file_id={ref.file_id}: {exc}") from exc

        body_stream = response.get("Body")
        body = body_stream.read() if body_stream is not None else b""
        head = StorageObjectHead(
            file_id=ref.file_id,
            bucket=ref.bucket,
            object_key=ref.object_key,
            content_length=int(response.get("ContentLength") or len(body)),
            content_type=response.get("ContentType"),
            etag=(response.get("ETag") or "").strip('"') or None,
            metadata={str(k): str(v) for k, v in (response.get("Metadata") or {}).items()},
        )
        return StorageObject(head=head, body=body)

    def _put_object_sync(self, ref: StorageObjectRef, data: bytes, content_type: str) -> None:
        client = self._get_client()
        try:
            client.put_object(
                Bucket=ref.bucket,
                Key=ref.object_key,
                Body=data,
                ContentType=content_type,
            )
        except self._client_errors() as exc:
            raise StorageClientInitError(
                f"failed to put object for file_id={ref.file_id}: {exc}"
            ) from exc

    def _put_metadata_sidecar_sync(self, ref: StorageObjectRef, metadata: dict[str, str]) -> None:
        client = self._get_client()
        sidecar_key = ref.object_key + ".meta.json"
        payload = json.dumps(metadata, ensure_ascii=False, sort_keys=True).encode("utf-8")
        try:
            client.put_object(
                Bucket=ref.bucket,
                Key=sidecar_key,
                Body=payload,
                ContentType="application/json",
            )
        except self._client_errors() as exc:
            raise StorageClientInitError(
                f"failed to write metadata sidecar for file_id={ref.file_id}: {exc}"
            ) from exc

    def _delete_object_sync(self, ref: StorageObjectRef) -> None:
        client = self._get_client()
        try:
            client.delete_object(Bucket=ref.bucket, Key=ref.object_key)
            client.delete_object(Bucket=ref.bucket, Key=ref.object_key + ".meta.json")
        except self._client_errors() as exc:
            raise StorageClientInitError(
                f"failed to delete object for file_id={ref.file_id}: {exc}"
            ) from exc

    def _is_not_found_error(self, exc: BaseException) -> bool:
        response = getattr(exc, "response", None) or {}
        error = response.get("Error", {}) if isinstance(response, dict) else {}
        code = str(error.get("Code") or "")
        status = str(response.get("ResponseMetadata", {}).get("HTTPStatusCode") or "")
        return code in {"404", "NoSuchBucket", "NoSuchKey", "NotFound"} or status == "404"

    def _safe_endpoint(self) -> str:
        parsed = urlparse(self.config.endpoint)
        host = parsed.hostname or parsed.netloc or self.config.endpoint
        scheme = parsed.scheme or "http"
        return f"{scheme}://{host}"
