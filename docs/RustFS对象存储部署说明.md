# RustFS 对象存储部署说明

本文档说明 AgentNexus 第一阶段的对象存储接入方式。当前项目把 RustFS 当作标准 S3-compatible object storage 使用，业务代码不直接依赖 RustFS 私有接口，后续也可以平滑切换到 MinIO、AWS S3 或 R2。

## 一、架构定位

- 后端内部访问对象存储使用 `STORAGE_S3_ENDPOINT`
- 浏览器直传场景使用 `STORAGE_S3_PUBLIC_ENDPOINT`
- 两者可以相同，也可以不同
- `file_id` 与 `object_key` 使用确定性映射，不依赖本地磁盘路径
- bucket 初始化由应用启动时的存储层检查负责

## 二、必须配置的环境变量

应用侧：

- `STORAGE_BACKEND=s3`
- `STORAGE_S3_ENDPOINT=http://rustfs:9000`
- `STORAGE_S3_PUBLIC_ENDPOINT=http://localhost:9000`
- `STORAGE_S3_REGION=us-east-1`
- `STORAGE_S3_ACCESS_KEY=<same-as-rustfs-access-key>`
- `STORAGE_S3_SECRET_KEY=<same-as-rustfs-secret-key>`
- `STORAGE_S3_BUCKET=agentnexus-files`
- `STORAGE_S3_FORCE_PATH_STYLE=true`
- `STORAGE_S3_AUTO_CREATE_BUCKET=true`
- `STORAGE_PRESIGN_EXPIRES_SECONDS=900`
- `FILE_UPLOAD_MAX_BYTES=26214400`
- `FILE_UPLOAD_ALLOWED_TYPES=application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain`

RustFS 容器侧：

- `RUSTFS_ACCESS_KEY=<storage-access-key>`
- `RUSTFS_SECRET_KEY=<storage-secret-key>`
- `RUSTFS_CORS_ALLOWED_ORIGINS=*`
- `RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS=*`
- `RUSTFS_OBJECT_CACHE_ENABLE=true`
- `RUSTFS_OBJECT_CACHE_TTL_SECS=300`

## 三、Docker Compose 启动方式

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑 `.env`，至少填好以下字段：

```env
RUSTFS_ACCESS_KEY=change-me-access-key
RUSTFS_SECRET_KEY=change-me-secret-key
STORAGE_BACKEND=s3
STORAGE_S3_ENDPOINT=http://rustfs:9000
STORAGE_S3_PUBLIC_ENDPOINT=http://localhost:9000
STORAGE_S3_ACCESS_KEY=change-me-access-key
STORAGE_S3_SECRET_KEY=change-me-secret-key
STORAGE_S3_BUCKET=agentnexus-files
```

3. 启动服务：

```bash
docker compose up -d rustfs redis backend frontend
```

## 四、生产部署建议

- 浏览器访问 RustFS 时，`STORAGE_S3_PUBLIC_ENDPOINT` 应配置成对外可访问的域名，例如 `https://storage.example.com`
- 后端容器访问 RustFS 时，`STORAGE_S3_ENDPOINT` 可以配置成内网 service name，例如 `http://rustfs:9000`
- 生产环境必须替换 `RUSTFS_ACCESS_KEY` 与 `RUSTFS_SECRET_KEY`
- RustFS 数据卷必须持久化，当前 compose 已拆成 1 个数据卷和 1 个日志卷
- RustFS 已配置健康检查和 `restart: unless-stopped`
- bucket 默认在应用启动时自动检查与创建，也可以改为 `STORAGE_S3_AUTO_CREATE_BUCKET=false` 由运维预创建

## 五、第一阶段验证方法

### 1. 验证 RustFS 容器

```bash
docker compose ps rustfs
```

RustFS 健康检查通过后，S3 API 默认在 `9000`，控制台默认在 `9001`。

### 2. 验证应用能读取存储配置

```bash
cd backend
python - <<'PY'
from app.config import settings
print(settings.storage_backend)
print(settings.storage_s3_endpoint)
print(settings.storage_s3_bucket)
PY
```

### 3. 验证 presigned URL 生成

```bash
cd backend
python - <<'PY'
import uuid
from app.config import settings
from app.storage.s3_compatible import S3CompatibleStorageService, S3CompatibleStorageSettings

svc = S3CompatibleStorageService(S3CompatibleStorageSettings.from_app_settings(settings))
file_id = str(uuid.uuid4())
upload = svc.create_presigned_put_url(file_id, content_type="application/pdf", filename="sample.pdf")
print(upload.file_id)
print(upload.object_key)
print(upload.upload_url[:120])
PY
```

### 4. 验证 bucket 初始化

启动后端时，日志中应看到以下两类之一：

- `storage bucket ready`
- `storage bucket created`

## 六、本地开发与生产的区别

- 本地开发通常让 `STORAGE_S3_PUBLIC_ENDPOINT=http://localhost:9000`
- 生产部署必须改成实际域名或反向代理地址
- 本地可以保留宽松的 CORS；生产环境应收敛 `RUSTFS_CORS_ALLOWED_ORIGINS`
- 本地默认允许后端自动创建 bucket；生产环境可关闭自动创建并交给部署流程
