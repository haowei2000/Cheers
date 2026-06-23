# kkFileView 文件预览配置说明

> **语言**：中文 | [English](kkFileView配置说明.md)

本文说明如何在 Cheers 中配置 kkFileView，用于增强 Office、WPS、OFD、压缩包、CAD、EPUB 等复杂文档的在线预览能力。

## 适用范围

Cheers 采用“内置预览 + kkFileView 增强复杂文档”的混合方案：

| 文件类型 | 预览方式 | 说明 |
| --- | --- | --- |
| 图片、PDF、HTML、Markdown、纯文本 | Cheers 内置预览 | 由前端直接展示，HTML 以受限 iframe 预览 |
| DOC、DOCX、XLS、XLSX、PPT、PPTX | kkFileView | DOCX、XLSX 也默认走 kkFileView，保证复杂排版预览 |
| WPS、ET、DPS、OFD、RTF、CSV | kkFileView | 通过 kkFileView 转换或渲染 |
| ZIP、RAR、7Z、TAR、GZ、BZ2、XZ | kkFileView | 用于压缩包内容预览 |
| DWG、DXF、EPUB | kkFileView | 用于 CAD/电子书等扩展预览 |

## 默认访问地址

当前项目默认使用同域名子路径部署：

```text
Cheers 站点: https://cheers.example.com
kkFileView 地址: https://cheers.example.com/preview
kkFileView 入口: https://cheers.example.com/preview/onlinePreview
```

不要把 `KKFILEVIEW_BASE_URL` 配成裸域名 `https://cheers.example.com`，否则后端会生成 `/onlinePreview`，与当前 Nginx 的 `/preview/` 代理路径不一致。

## 预览调用链

复杂文档预览的完整链路如下：

1. 用户点击文件预览。
2. 前端判断文件属于复杂文档，调用：

   ```text
   GET /api/v1/files/{file_id}/kkfileview
   ```

3. 后端校验当前用户是否有频道文件访问权限。
4. 后端生成一个短期签名下载地址：

   ```text
   https://cheers.example.com/api/v1/files/{file_id}/public-preview?token=...&fullfilename=...
   ```

5. 后端把该地址 Base64 编码后拼到 kkFileView viewer URL：

   ```text
   https://cheers.example.com/preview/onlinePreview?url=...
   ```

6. 前端用 iframe 加载 viewer URL。
7. kkFileView 解码 `url` 参数，再请求 `public-preview` 拉取源文件。
8. 后端验证 `token` 后返回文件流，kkFileView 完成转换和预览。

## Docker Compose 部署

项目的 `docker-compose.yml.template` 已包含 `kkfileview` 服务。部署时先复制模板：

```bash
cp docker-compose.yml.template docker-compose.yml
```

模板中的 kkFileView 服务配置如下：

```yaml
kkfileview:
  image: ${KKFILEVIEW_IMAGE:-keking/kkfileview:latest}
  restart: unless-stopped
  ports:
    - "${KKFILEVIEW_HOST_BIND:-127.0.0.1}:${KKFILEVIEW_HOST_PORT:-8012}:8012"
  environment:
    - KK_CONTEXT_PATH=/preview
    - KK_BASE_URL=${KKFILEVIEW_BASE_URL:-https://cheers.example.com/preview}
    - KK_TRUST_HOST=${KKFILEVIEW_TRUST_HOST:-cheers.example.com}
    - KK_FILE_DIR=${KKFILEVIEW_FILE_DIR:-/opt/kkfileview/file/}
    - KK_OFFICE_PREVIEW_TYPE=${KKFILEVIEW_OFFICE_PREVIEW_TYPE:-pdf}
    - KK_PDF_DOWNLOAD_DISABLE=${KKFILEVIEW_PDF_DOWNLOAD_DISABLE:-true}
    - KK_PDF_PRINT_DISABLE=${KKFILEVIEW_PDF_PRINT_DISABLE:-true}
    - KK_MEDIA_CONVERT_DISABLE=${KKFILEVIEW_MEDIA_CONVERT_DISABLE:-true}
  volumes:
    - ./data/kkfileview:/opt/kkfileview/file
```

`${KKFILEVIEW_HOST_BIND:-127.0.0.1}:${KKFILEVIEW_HOST_PORT:-8012}:8012` 表示 kkFileView 默认只暴露给服务器本机，不直接暴露到公网。公网访问统一走 `https://cheers.example.com/preview/`。

如果服务器本机 `8012` 已被占用，只需要在 `.env` 修改宿主机端口，例如：

```bash
KKFILEVIEW_HOST_BIND=127.0.0.1
KKFILEVIEW_HOST_PORT=18012
```

项目内置 `frontend` 容器通过 Docker 内网访问 `kkfileview:8012`，所以使用内置前端代理时，修改 `KKFILEVIEW_HOST_PORT` 不影响浏览器访问的 `https://cheers.example.com/preview/`。

## 环境变量

生产环境建议在 `.env` 中显式配置以下变量：

```bash
PUBLIC_BASE_URL=https://cheers.example.com
KKFILEVIEW_ENABLED=true
KKFILEVIEW_BASE_URL=https://cheers.example.com/preview
KKFILEVIEW_TOKEN_TTL_SECONDS=600

KKFILEVIEW_HOST_BIND=127.0.0.1
KKFILEVIEW_HOST_PORT=8012
KKFILEVIEW_IMAGE=keking/kkfileview:latest
KKFILEVIEW_TRUST_HOST=cheers.example.com
KKFILEVIEW_FILE_DIR=/opt/kkfileview/file/
KKFILEVIEW_OFFICE_PREVIEW_TYPE=pdf
KKFILEVIEW_PDF_DOWNLOAD_DISABLE=true
KKFILEVIEW_PDF_PRINT_DISABLE=true
KKFILEVIEW_MEDIA_CONVERT_DISABLE=true

JWT_SECRET_KEY=replace-with-a-long-random-secret
```

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://cheers.example.com` | kkFileView 拉取源文件时使用的 Cheers 公网地址 |
| `KKFILEVIEW_ENABLED` | `true` | 是否启用 kkFileView 复杂文档预览 |
| `KKFILEVIEW_BASE_URL` | `https://cheers.example.com/preview` | 后端返回给前端 iframe 的 kkFileView 地址 |
| `KKFILEVIEW_TOKEN_TTL_SECONDS` | `600` | `public-preview` 短期 token 有效期，最低会按 60 秒处理 |
| `KKFILEVIEW_HOST_BIND` | `127.0.0.1` | kkFileView 宿主机监听地址；生产建议保持本机地址，不直接暴露公网 |
| `KKFILEVIEW_HOST_PORT` | `8012` | 宿主机本地监听端口 |
| `KKFILEVIEW_IMAGE` | `keking/kkfileview:latest` | kkFileView Docker 镜像 |
| `KKFILEVIEW_TRUST_HOST` | `cheers.example.com` | kkFileView 允许访问的主机名 |
| `KKFILEVIEW_FILE_DIR` | `/opt/kkfileview/file/` | kkFileView 容器内缓存目录 |
| `KKFILEVIEW_OFFICE_PREVIEW_TYPE` | `pdf` | Office 文件转换预览类型 |
| `KKFILEVIEW_PDF_DOWNLOAD_DISABLE` | `true` | 禁用 kkFileView 预览页内 PDF 下载按钮 |
| `KKFILEVIEW_PDF_PRINT_DISABLE` | `true` | 禁用 kkFileView 预览页内 PDF 打印按钮 |
| `KKFILEVIEW_MEDIA_CONVERT_DISABLE` | `true` | 禁用媒体转换，减少非文档场景资源消耗 |
| `JWT_SECRET_KEY` | 空 | 用于签发 `public-preview` token，生产环境必须固定设置 |

`JWT_SECRET_KEY` 不要在每次重启时变化。虽然 kkFileView token 有效期较短，但固定密钥可以避免重启期间正在打开的预览全部失效。

## Nginx 配置

### 使用项目内置前端容器

如果公网 Nginx 只把请求转发到 Cheers `frontend` 容器，则项目内置的 `frontend/nginx.conf` 已经包含：

```nginx
location = /preview {
    return 301 /preview/;
}

location ^~ /preview/ {
    proxy_pass http://kkfileview:8012/preview/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

这种方式下，外层 Nginx 只需要把 `https://cheers.example.com` 转发给前端容器即可。

### 外层 Nginx 直接分流

如果服务器外层 Nginx 直接接管路径分流，可以使用如下配置：

```nginx
server {
    listen 443 ssl http2;
    server_name cheers.example.com;

    # ssl_certificate     /path/to/fullchain.pem;
    # ssl_certificate_key /path/to/privkey.pem;

    location /preview/ {
        proxy_pass http://127.0.0.1:8012/preview/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_buffering off;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8000/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

注意：`location /preview/` 和 `proxy_pass http://127.0.0.1:8012/preview/;` 的尾部斜杠要保持一致，避免路径被改写成错误的 `/onlinePreview` 或 `/preview/preview/onlinePreview`。

## 启动和更新

首次部署：

```bash
cp .env.example .env
vim .env
cp docker-compose.yml.template docker-compose.yml
docker compose up -d
```

更新已有部署：

```bash
git pull
cp docker-compose.yml.template docker-compose.yml
docker compose pull kkfileview
docker compose up -d backend frontend kkfileview
```

查看服务状态：

```bash
docker compose ps
docker compose logs -f kkfileview
docker compose logs -f backend
```

## 验证步骤

1. 检查 Compose 模板能正常解析：

   ```bash
   docker compose -f docker-compose.yml.template config --services
   ```

   输出中应包含：

   ```text
   backend
   frontend
   kkfileview
   ```

2. 检查 kkFileView 本地端口：

   ```bash
   curl -I "http://${KKFILEVIEW_HOST_BIND:-127.0.0.1}:${KKFILEVIEW_HOST_PORT:-8012}/preview/"
   ```

3. 检查公网路径：

   ```bash
   curl -I https://cheers.example.com/preview/
   ```

4. 登录 Cheers，上传 `docx`、`xlsx` 或 `pptx` 文件，点击预览。

5. 浏览器开发者工具中应看到：

   ```text
   GET /api/v1/files/{file_id}/kkfileview 200
   GET /preview/onlinePreview?url=... 200
   GET /api/v1/files/{file_id}/public-preview?token=... 200
   ```

## 容器访问公网域名

kkFileView 拉取源文件时访问的是 `PUBLIC_BASE_URL` 生成的公网 URL。也就是说，`kkfileview` 容器必须能访问：

```text
https://cheers.example.com/api/v1/files/{file_id}/public-preview?token=...
```

如果服务器不支持容器通过公网域名回到本机，可能会出现 kkFileView 页面打开但文档加载失败。可以在 `kkfileview` 服务下增加：

```yaml
extra_hosts:
  - "cheers.example.com:host-gateway"
```

然后确认宿主机上的 Nginx 正在监听 HTTPS，并且证书配置正常。

## 安全说明

1. `public-preview` 接口不使用用户登录态，而是使用短期签名 token。
2. token 中包含 `scope=file_preview` 和 `file_id`，后端会校验 scope 与文件 ID。
3. token 有效期由 `KKFILEVIEW_TOKEN_TTL_SECONDS` 控制，默认 600 秒。
4. `kkfileview` 端口默认只绑定 `127.0.0.1`，不要直接暴露到公网。
5. 生产环境必须设置固定且足够随机的 `JWT_SECRET_KEY`。
6. 建议只通过 HTTPS 暴露 `PUBLIC_BASE_URL` 和 `KKFILEVIEW_BASE_URL`。
7. 不要把 `KKFILEVIEW_TRUST_HOST` 配成 `*`，优先固定为 `cheers.example.com`。

## 常见问题

### 1. 前端提示“文件不存在、已过期或已被清理”

说明 `/api/v1/files/{file_id}/preview` 或 `public-preview` 返回 404。常见原因：

- 文件记录不存在。
- 文件超过 `FILE_RETENTION_DAYS` 被清理。
- 数据库记录存在，但对象存储或本地文件丢失。
- 当前环境连接的是旧数据库或错误数据库。

处理方式：

```bash
docker compose logs -f backend
```

重点搜索 `file_id`，确认文件记录、对象存储 key 和存储桶是否一致。

### 2. `/preview/onlinePreview` 返回 404

通常是 `KKFILEVIEW_BASE_URL` 或 Nginx 路径不一致。

应确认：

```bash
KKFILEVIEW_BASE_URL=https://cheers.example.com/preview
```

并确认 Nginx 中存在：

```nginx
location ^~ /preview/ {
    proxy_pass http://kkfileview:8012/preview/;
}
```

### 3. kkFileView 页面打开但文档一直加载

常见原因是 kkFileView 容器无法访问 `PUBLIC_BASE_URL`。

排查方式：

```bash
docker compose exec kkfileview sh
wget -S -O /dev/null https://cheers.example.com/preview/
```

如果无法访问，检查 DNS、HTTPS 证书、宿主机防火墙和 `extra_hosts`。

### 4. `invalid preview token`

常见原因：

- token 超过有效期。
- 后端重启后 `JWT_SECRET_KEY` 发生变化。
- URL 被复制后参数丢失或被错误转义。

刷新 Cheers 页面后重新点击预览即可重新生成 token。生产环境应固定 `JWT_SECRET_KEY`。

### 5. Office 文件转换失败

先看 kkFileView 日志：

```bash
docker compose logs -f kkfileview
```

重点检查：

- kkFileView 镜像是否启动成功。
- 容器内 Office/LibreOffice 转换组件是否报错。
- `./data/kkfileview` 是否有写入权限。
- 文件名是否包含特殊字符；后端会附带 `fullfilename`，但外部代理不要破坏 query string。

### 6. 本地开发不想启用 kkFileView

可以在 `.env` 中关闭：

```bash
KKFILEVIEW_ENABLED=false
```

关闭后复杂文档会回退到当前内置文本/Markdown 能力，无法保证 Office 原始排版。

### 7. kkFileView 启动时报 `address already in use`

说明宿主机监听端口被占用。先确认占用来源：

```bash
sudo ss -lntp | grep 8012
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep 8012
```

如果不想停止占用该端口的服务，可以直接在 `.env` 改端口：

```bash
KKFILEVIEW_HOST_BIND=127.0.0.1
KKFILEVIEW_HOST_PORT=18012
```

然后重建 kkFileView 和前端代理：

```bash
docker compose up -d --force-recreate kkfileview frontend
```

使用项目内置前端代理时，外部访问地址仍然是 `https://cheers.example.com/preview/`，不要把 `KKFILEVIEW_BASE_URL` 改成带 `:18012` 的地址。

## 推荐生产配置清单

上线前逐项确认：

- `PUBLIC_BASE_URL=https://cheers.example.com`
- `KKFILEVIEW_BASE_URL=https://cheers.example.com/preview`
- `KKFILEVIEW_ENABLED=true`
- `JWT_SECRET_KEY` 已设置为固定随机值
- `kkfileview` 容器运行正常
- `https://cheers.example.com/preview/` 可访问
- `kkfileview` 容器能访问 `https://cheers.example.com/api/v1/...`
- 外层 Nginx 没有吞掉 query string
- 服务器磁盘有足够空间保存 `./data/kkfileview` 缓存
- 上传文件类型包含 Office、WPS、OFD、压缩包等需要预览的 MIME 类型

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `.env.example` | kkFileView 相关环境变量示例 |
| `docker-compose.yml.template` | kkFileView 服务定义 |
| `frontend/nginx.conf` | `/preview/` 反向代理配置 |
| `backend/app/config.py` | 后端默认配置 |
| `backend/app/api/v1/files/routes.py` | kkFileView URL 生成、签名源文件接口 |
| `frontend/src/components/FilePreviewSidebar.tsx` | 前端复杂文档 iframe 预览入口 |
| `tests/test_messages_api.py` | kkFileView URL 和签名源文件测试 |
