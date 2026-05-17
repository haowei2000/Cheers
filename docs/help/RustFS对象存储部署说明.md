# RustFS Object Storage Guide

> **Language**: English | [中文](RustFS对象存储部署说明.zh-CN.md)

AgentNexus uses RustFS as an S3-compatible object store in the default Docker Compose stack. The storage layer only depends on S3-compatible APIs, so MinIO, AWS S3, Cloudflare R2, or similar services can replace RustFS.

## Required Variables

Application side:

```env
STORAGE_BACKEND=s3
STORAGE_S3_ENDPOINT=http://rustfs:9000
STORAGE_S3_PUBLIC_ENDPOINT=http://localhost:9000
STORAGE_S3_REGION=us-east-1
STORAGE_S3_ACCESS_KEY=<same-as-rustfs-access-key>
STORAGE_S3_SECRET_KEY=<same-as-rustfs-secret-key>
STORAGE_S3_BUCKET=agentnexus-files
STORAGE_S3_FORCE_PATH_STYLE=true
STORAGE_S3_AUTO_CREATE_BUCKET=true
STORAGE_PRESIGN_EXPIRES_SECONDS=900
FILE_UPLOAD_MAX_BYTES=26214400
```

RustFS container side:

```env
RUSTFS_ACCESS_KEY=<storage-access-key>
RUSTFS_SECRET_KEY=<storage-secret-key>
RUSTFS_CORS_ALLOWED_ORIGINS=*
RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=*
```

## Docker Compose

```bash
cp .env.example .env
# edit the RustFS and storage secrets
docker compose up -d rustfs redis backend frontend
```

RustFS API defaults to port `9000`; the console defaults to `9001`.

## Production Notes

- Set `STORAGE_S3_PUBLIC_ENDPOINT` to a public HTTPS endpoint, for example `https://storage.example.com`.
- Keep `STORAGE_S3_ENDPOINT` as an internal service URL when running inside Docker.
- Replace all example access keys and secrets.
- Persist RustFS data volumes.
- Prefer private bucket access with presigned URLs.
- Let AgentNexus auto-create the bucket in development; pre-create it in production if your operations process requires it.

## Verification

```bash
docker compose ps rustfs
```

Check backend configuration:

```bash
cd backend
python - <<'PY_INNER'
from app.config import settings
print(settings.storage_backend)
print(settings.storage_s3_endpoint)
print(settings.storage_s3_bucket)
PY_INNER
```

If uploads fail, check backend logs, RustFS logs, bucket existence, endpoint reachability, credentials, CORS, and file size/type limits.
