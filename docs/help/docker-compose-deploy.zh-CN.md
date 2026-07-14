# Docker Compose 部署指南

> **语言**：中文 | [English](docker-compose-deploy.md)

本指南用 Docker Compose 部署完整的 Cheers 栈：Rust **gateway**、**前端**、
**PostgreSQL**、**RustFS**（S3 兼容对象存储）、**Redis**、**Gotenberg**（office→PDF 文档预览），
以及可选的 **OpenCode** 智能体 Bot（OpenAI 兼容，可直接用 DeepSeek key）。

gateway 启动时自动执行 SQL 迁移，无需单独的迁移步骤。

> Docker Compose 是单机轻量路径。集群部署请用 Helm chart：
> [deploy/helm/cheers/README.md](../../deploy/helm/cheers/README.md)。

## 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | macOS 或 Linux（Windows 用 WSL2） |
| Docker | Docker 20.10+，Compose v2（`docker compose`，非 `docker-compose`） |
| 工具 | `openssl`（生成 JWT 密钥对）、`curl` |
| 资源 | 空闲内存约 4 GB；Bot 镜像额外约 900 MB 并需 Rust 构建 |

## 1. 准备文件

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
```

## 2. 生成 JWT 密钥对（必填）

gateway 使用 **RS256 密钥对** 签发会话，缺失则拒绝启动。生成后把两个 PEM 填入 `.env`：

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem
openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem
```

在 `.env` 中填入**完整多行 PEM 内容**（加引号）：

```dotenv
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkq...
-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhki...
-----END PUBLIC KEY-----"
```

> 不要提交 `jwt_priv.pem`（仓库已忽略 `*.pem`）；生产环境不要复用开发密钥。

## 3. 设置核心密钥（`.env`）

首次启动前请修改以下示例值：

| 变量 | 用途 |
|---|---|
| `ADMIN_PASSWORD` | 内置 `admin` 用户密码 |
| `POSTGRES_PASSWORD` | PostgreSQL 密码 |
| `STORAGE_S3_ACCESS_KEY` / `STORAGE_S3_SECRET_KEY` | gateway 与 RustFS 共用的一组密钥 |
| `CORS_ALLOWED_ORIGINS` | 允许调用 API 的浏览器来源（见下） |

**本地访问的 CORS：** 示例默认 `https://cheers.example.com`，会拦截
`http://localhost` 的浏览器。本地部署请改成实际来源，或留空表示允许全部（仅限开发）：

```dotenv
CORS_ALLOWED_ORIGINS=http://localhost
```

## 4. 启动核心栈

```bash
docker compose up -d          # 首次会构建 gateway 与 frontend
docker compose ps
```

除 Bot 外的所有服务都会启动（Bot 放在 Compose profile 中，因为它需要由运行中的
gateway 才能签发的 token —— 见第 6 步）。

默认访问地址：

- 前端 UI：`http://localhost`（或 `FRONTEND_HOST_PORT`）
- 网关 API：`http://localhost:8000`
- 健康检查：`http://localhost:8000/health`

用 `admin` / 你设置的 `ADMIN_PASSWORD` 登录。验证网关健康：

```bash
curl -fsS http://localhost:8000/health && echo OK
```

## 5.（可选）配置 OpenCode Bot 的模型供应商

Bot 默认用 **DeepSeek**。在 `.env` 中：

```dotenv
OPENCODE_PROVIDER=deepseek
OPENCODE_OPENAI_BASE_URL=https://api.deepseek.com
OPENCODE_OPENAI_API_KEY=sk-你的-deepseek-key
OPENCODE_MODEL=                     # 留空 → deepseek/deepseek-chat
```

改用 OpenAI（或其他 OpenAI 兼容端点）时，同时修改供应商、base URL、模型，并使用匹配的 key：

```dotenv
OPENCODE_PROVIDER=openai
OPENCODE_OPENAI_BASE_URL=https://api.openai.com
OPENCODE_OPENAI_API_KEY=sk-你的-openai-key
OPENCODE_MODEL=gpt-4o
```

key 必须与端点匹配 —— 用 DeepSeek key 打 OpenAI base URL 会返回 401。

## 6.（可选）创建 Bot 账号并签发 token

Bot 通过绑定到某个 Bot 账号的 Agent Bridge token 向 gateway 认证。通过管理 API 创建账号并签发 token：

```bash
# a) 以 admin 登录，取得访问令牌
TOKEN=$(curl -fsS -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"'"$ADMIN_PASSWORD"'"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# b) 创建 Bot 账号（scope "everyone" 表示任意频道可用）
BOT_ID=$(curl -fsS -X POST http://localhost:8000/api/v1/bots \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"username":"opencode","display_name":"OpenCode","scope":"everyone"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["bot_id"])')

# c) 签发 Bot token（仅显示一次）
curl -fsS -X POST "http://localhost:8000/api/v1/bots/$BOT_ID/token" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
```

把打印出的 token（`agb_...`）写入 `.env`：

```dotenv
OPENCODE_BOT_TOKEN=agb_...
OPENCODE_BOT_USERNAME=opencode
```

## 7.（可选）启动 Bot

```bash
docker compose --profile bot up -d opencode-bot
docker compose logs -f opencode-bot     # 关注 api_key_set=true
```

启动日志会打印解析后的配置，例如
`model=deepseek/deepseek-chat ... api_key_set=true`。

**使用：** 在 UI 中把 `opencode` Bot 加入某个频道（成员列表 → 添加 Bot），
然后 @ 它：`@opencode 你好`。

## 生产加固（Caddy HTTPS）

TLS overlay 增加一个 Caddy `tls-edge` 服务，终止 HTTPS 并反向代理到
gateway/frontend/rustfs，同时把各服务的宿主端口绑定到回环地址，
只有 Caddy 对外暴露。

Caddy 通过 ACME 自动签发并续期证书，无需手动准备证书文件。镜像由
`docker/Dockerfile.caddy` 构建，内置 Cloudflare DNS 插件以走 **DNS-01**
挑战——它在域名保持 Cloudflare 代理（橙云）时依然可用，且可无人值守续期。

```bash
docker compose -f docker-compose.yml -f docker-compose.production.tls.yml up -d --build
```

生产环境在 `.env` 中设置：

- `APP_DOMAIN` —— 公网域名，如 `cheers.example.com`
- `APP_DOMAIN_LEGACY` —— 可选的第二域名，域名迁移过渡期并行提供服务
  （只有一个域名时留空）
- `CORS_ALLOWED_ORIGINS=https://cheers.example.com`（迁移期把两个域名用逗号分隔）
- `STORAGE_S3_PUBLIC_ENDPOINT=https://cheers.example.com`
- `ACME_EMAIL` —— ACME 账户邮箱（接收到期通知）
- `CF_API_TOKEN` —— Cloudflare API Token，需对相关 Zone 具备
  **Zone:DNS:Edit** 权限，用于 DNS-01 挑战
- `HTTP_PORT=80`、`HTTPS_PORT=443`

将 Cloudflare 的 SSL/TLS 模式设为 **Full (strict)**，让边缘信任源站上 Caddy 的
ACME 证书。

> **非 Cloudflare / 灰云（关闭代理）：** 无需自定义镜像或 Token。改用官方
> `caddy:2-alpine`，并删除 `docker/Caddyfile` 中的 `tls { dns cloudflare ... }`
> 块，Caddy 会直接走 HTTP-01 / TLS-ALPN-01 签发（需 80/443 可达且域名指向本机）。

若同时运行 Bot，命令追加 `--profile bot`。

## 运维

```bash
# 日志
docker compose logs -f gateway
docker compose logs -f opencode-bot

# 代码变更后重建并重启
docker compose up -d --build gateway frontend

# 轮换 Bot 的模型 API key（改 .env 后）
docker compose --profile bot up -d --force-recreate opencode-bot

# 备份数据库
docker compose exec postgres pg_dump -U cheers cheers | gzip > cheers-$(date +%F).sql.gz

# 停止 / 停止并清空数据
docker compose down
docker compose down -v && rm -rf data/     # 会删除所有数据
```

持久化数据位于 `./data/`（PostgreSQL、RustFS 对象、Bot 状态）。

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| gateway 立即退出，日志提到 JWT | `.env` 中 `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` 缺失或格式错误。按第 2 步重新生成，保留完整多行 PEM 并加引号。 |
| 浏览器登录报 CORS 错误 | `CORS_ALLOWED_ORIGINS` 未包含当前访问 UI 的来源。按第 3 步设置为该来源。 |
| `opencode-bot` 反复重启 | 未设置 `OPENCODE_BOT_TOKEN` 就启动了。按第 6 步签发并填入 token，或不要启动 `bot` profile。 |
| Bot 在线但每次提问都报错 | `OPENCODE_OPENAI_API_KEY` 缺失或与端点不匹配。检查 Bot 日志中的 `api_key_set=true`，并确认 key 与 `OPENCODE_OPENAI_BASE_URL` 匹配。 |
| 拉取镜像很慢（中国大陆） | 用镜像源构建：`docker compose build --build-arg BASE_REGISTRY=docker.m.daocloud.io --build-arg NPM_REGISTRY=https://registry.npmmirror.com`。 |
| 端口被占用 | 修改 `.env` 中的 `*_HOST_PORT` 变量。 |
