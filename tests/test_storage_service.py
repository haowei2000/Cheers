"""S3-compatible storage service tests."""
from __future__ import annotations

import io

import pytest

from app.storage.base import StorageObjectNotFoundError
from app.storage.s3_compatible import S3CompatibleStorageService, S3CompatibleStorageSettings


class FakeClientError(Exception):
    """Minimal botocore-like error for tests."""

    def __init__(self, code: str, status_code: int = 404) -> None:
        super().__init__(code)
        self.response = {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status_code},
        }


class FakePresignClient:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def generate_presigned_url(self, operation_name: str, Params: dict, ExpiresIn: int, HttpMethod: str) -> str:
        self.calls.append(
            {
                "operation_name": operation_name,
                "params": Params,
                "expires_in": ExpiresIn,
                "http_method": HttpMethod,
            }
        )
        return "http://storage.example/upload"


class FakeBucketClient:
    def __init__(self, exists: bool) -> None:
        self.exists = exists
        self.created_with: dict | None = None

    def head_bucket(self, Bucket: str) -> None:
        if not self.exists:
            raise FakeClientError("404")

    def create_bucket(self, **kwargs) -> None:
        self.exists = True
        self.created_with = kwargs


class FakeObjectClient:
    def __init__(self) -> None:
        self.objects: dict[str, dict] = {}

    def head_object(self, Bucket: str, Key: str) -> dict:
        item = self.objects.get(Key)
        if item is None:
            raise FakeClientError("NoSuchKey")
        return {
            "ContentLength": len(item["body"]),
            "ContentType": item["content_type"],
            "ETag": '"etag-1"',
            "Metadata": item.get("metadata", {}),
        }

    def get_object(self, Bucket: str, Key: str) -> dict:
        item = self.objects.get(Key)
        if item is None:
            raise FakeClientError("NoSuchKey")
        return {
            "Body": io.BytesIO(item["body"]),
            "ContentLength": len(item["body"]),
            "ContentType": item["content_type"],
            "ETag": '"etag-1"',
            "Metadata": item.get("metadata", {}),
        }

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:
        self.objects[Key] = {
            "body": Body,
            "content_type": ContentType,
            "metadata": {},
        }


def _make_service() -> S3CompatibleStorageService:
    return S3CompatibleStorageService(
        S3CompatibleStorageSettings(
            endpoint="http://rustfs:9000",
            bucket="agentnexus-files",
            region="us-east-1",
            access_key="key",
            secret_key="secret",
            public_endpoint="http://localhost:9000",
            force_path_style=True,
            presign_expires_seconds=900,
            auto_create_bucket=True,
        )
    )


@pytest.fixture(autouse=True)
def _patch_boto_import(monkeypatch: pytest.MonkeyPatch) -> None:
    class DummyBoto3:
        @staticmethod
        def client(*args, **kwargs):
            raise AssertionError("client factory should not be used in these unit tests")

    class DummyConfig:
        def __init__(self, *args, **kwargs) -> None:
            self.args = args
            self.kwargs = kwargs

    monkeypatch.setattr(
        "app.storage.s3_compatible._import_boto3",
        lambda: (DummyBoto3, DummyConfig, (FakeClientError,)),
    )


def test_build_object_key_is_deterministic() -> None:
    service = _make_service()
    file_id = "12345678-1234-1234-1234-1234567890ab"
    assert service.build_object_key(file_id) == (
        "uploads/12/34/12345678-1234-1234-1234-1234567890ab/source"
    )
    assert service.resolve_file_id(file_id).object_key.endswith("/source")


def test_create_presigned_put_url_returns_required_headers() -> None:
    service = _make_service()
    presign_client = FakePresignClient()
    service._presign_client = presign_client

    result = service.create_presigned_put_url(
        "12345678-1234-1234-1234-1234567890ab",
        content_type="application/pdf",
        filename="report.pdf",
    )

    assert result.upload_url == "http://storage.example/upload"
    assert result.headers["Content-Type"] == "application/pdf"
    assert result.headers["x-amz-meta-file-id"] == "12345678-1234-1234-1234-1234567890ab"
    assert result.headers["x-amz-meta-original-filename"] == "report.pdf"
    assert presign_client.calls[0]["params"]["Key"] == result.object_key


@pytest.mark.asyncio
async def test_ensure_bucket_exists_creates_bucket_when_missing() -> None:
    service = _make_service()
    bucket_client = FakeBucketClient(exists=False)
    service._client = bucket_client

    await service.ensure_bucket_exists()

    assert bucket_client.created_with == {"Bucket": "agentnexus-files"}


@pytest.mark.asyncio
async def test_head_and_get_object_roundtrip() -> None:
    service = _make_service()
    object_client = FakeObjectClient()
    key = service.build_object_key("12345678-1234-1234-1234-1234567890ab")
    object_client.objects[key] = {
        "body": b"hello world",
        "content_type": "text/plain",
        "metadata": {"file-id": "12345678-1234-1234-1234-1234567890ab"},
    }
    service._client = object_client

    head = await service.head_object("12345678-1234-1234-1234-1234567890ab")
    obj = await service.get_object("12345678-1234-1234-1234-1234567890ab")

    assert head.content_type == "text/plain"
    assert obj.body == b"hello world"
    assert obj.head.metadata["file-id"] == "12345678-1234-1234-1234-1234567890ab"


@pytest.mark.asyncio
async def test_head_object_raises_not_found() -> None:
    service = _make_service()
    service._client = FakeObjectClient()

    with pytest.raises(StorageObjectNotFoundError):
        await service.head_object("12345678-1234-1234-1234-1234567890ab")
