# 部署指南

> **语言**：中文 | [English](deployment.md)

Cheers 有三种运行方式，按目标选择：

| 方式 | 适合 | 网关与前端如何运行 |
|---|---|---|
| **1. 源码运行** | 开发调试 | 本机 `cargo run` + `npm run dev`；依赖服务用 Docker |
| **2. Docker Compose** | 单机自托管、演示 | 所有服务作为容器运行在一台主机上 |
| **3. Helm / Kubernetes** | 集群、生产、横向扩展 | 所有服务作为 Kubernetes 工作负载 |

## 最低硬件要求

| 配置 | CPU | 内存 | 磁盘 |
|---|---|---|---|
| 核心栈（不含智能体 bot） | 2 核 | 4 GB | ~10 GB |
| 含智能体 bot + 余量 | 4 核 | 8 GB | ~20 GB |

这些数值与 `docker-compose.yml.template` 和 Helm 开发 values（`values-dev.yaml`）
中设置的资源上限一致：网关、PostgreSQL、RustFS、Gotenberg 各约上限 1 GB，前端与
Redis 很小，智能体 bot 最多约 2 GB。上限只是天花板 —— 实际空闲用量远低于此。
Docker Desktop 用户请把虚拟机内存至少设为 4 GB（含 bot 时 6–8 GB）。

## 三种方式的共同点

- **后端是单一的 Rust 网关。** 启动时自动执行 `sqlx` 数据库迁移 —— 没有单独的迁移步骤。
- **必需 RS256 JWT 密钥对** —— 缺失则网关无法启动。生成：
  ```bash
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem
  openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem
  ```
- **必需配置：** `DATABASE_URL`、`JWT_PRIVATE_KEY`、`JWT_PUBLIC_KEY`、S3 端点 +
  access/secret key，以及 `ADMIN_PASSWORD`（首次启动时用于创建管理员）。
- **依赖服务：** PostgreSQL（必需）、S3 兼容对象存储 RustFS（必需）、Gotenberg
  （可选 —— office→PDF 文档预览）、Redis（可选 —— 仅用于多实例广播；单实例使用进程内状态）。
- **Apple 登录由每个 gateway 显式启用。** 官方托管 gateway 配置
  `APPLE_TEAM_ID`、`APPLE_KEY_ID`、`APPLE_CLIENT_ID=app.cheers.ios` 和
  `APPLE_PRIVATE_KEY_P8`。浏览器与 macOS OAuth 还需要
  `APPLE_WEB_CLIENT_ID`、`APPLE_WEB_REDIRECT_URI` 和
  `OAUTH_WEB_RETURN_URL`。普通自托管实例应保持这些变量未设置，能力接口会将
  provider 标记为不可用；不得向自托管用户分发官方 `.p8` 私钥。

### 官方生产环境 Apple 凭据

官方 GitHub `production` Environment 将 `APPLE_PRIVATE_KEY_P8` 保存为 Secret；
Team/Key/Client ID 和两个 HTTPS 回调地址属于公开元数据，保存为 Environment
Variables。CD workflow 生成带版本号、Base64 编码且字段固定在 allowlist 中的载荷，
只通过 forced-command SSH 连接的标准输入传输。

服务器脚本版本化保存在 `deploy/production/deploy.sh`，生产安装路径为
`/opt/cheers/deploy.sh`。脚本验证每个字段和 EC 私钥、验证候选 Compose 配置，并在
重建 gateway 前原子替换 `/opt/cheers/.env` 中权限为 `0600` 的受管区块。镜像拉取、
容器重建或健康检查失败时会恢复旧环境。部署日志不得打印载荷、私钥或完整环境文件。

不要手工修改以下标记之间的内容：

```text
# BEGIN CHEERS GITHUB-MANAGED AUTH
# END CHEERS GITHUB-MANAGED AUTH
```

---

## 方式 1 —— 源码运行（原始代码）

适合开发：迭代最快、前端热重载、可原生调试。

**前置：** 稳定版 Rust 工具链（`cargo`）、Node.js 20+、Docker（用于依赖服务）。

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# 1) 启动依赖服务（发布到 localhost）。若需要 office 预览 / 多实例广播，
#    也可加上 `gotenberg redis`。
docker compose up -d postgres rustfs

# 2) 为“主机访问”修改 .env。默认值使用容器主机名（postgres、rustfs）；
#    源码运行时网关跑在你的主机上，所以要用 localhost：
#      DATABASE_URL=postgresql://cheers:<密码>@localhost:5432/cheers   （.env.example 中已是 localhost）
#      STORAGE_S3_ENDPOINT=http://localhost:9000
#    另外把 RS256 密钥对填入 JWT_PRIVATE_KEY / JWT_PUBLIC_KEY，并设置
#    ADMIN_PASSWORD。网关会自动加载 .env（dotenvy）。

# 3) 运行网关（自动执行 sqlx 迁移）
cd server && cargo run

# 4) 另开一个终端运行前端开发服务器（热重载）
cd frontend && npm install && npm run dev     # → http://localhost:5173
```

Vite 开发服务器会把 `/api` 和 `/ws` 代理到 `http://localhost:8000` 的网关。Redis 与
Gotenberg 均为可选 —— 最简运行可保持 `REDIS_URL` 默认、不设 `GOTENBERG_URL`
（未设置时 office→PDF 预览自动关闭）。

---

## 方式 2 —— Docker Compose（单机）

适合单机自托管或演示：全部容器化，一条命令启动。

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
# 在 .env 中生成 JWT 密钥对，并设置 ADMIN_PASSWORD、POSTGRES_PASSWORD、
# STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY 与 CORS。
docker compose up -d
```

- UI：`http://localhost` · API：`http://localhost:8000` · 健康检查：`/health`
- 可选的智能体 bot 放在 Compose profile 中：
  `docker compose --profile bot up -d opencode-bot`。
- 生产 HTTPS（Caddy）：追加 `-f docker-compose.production.tls.yml`。

**完整流程**（JWT、供应商/API key、bot token、TLS、运维、排查）：
[docker-compose-deploy.zh-CN.md](docker-compose-deploy.zh-CN.md) /
[English](docker-compose-deploy.md)。

---

## 方式 3 —— Helm / Kubernetes

适合集群、生产与横向扩展（多副本网关 + Redis 广播）。

```bash
# 本地 kind 集群：先创建集群（配置文件把 NodePort 30080 映射到 localhost:30080），
# 再构建镜像、加载、安装 release。
kind create cluster --name cheers --config deploy/kind-config.yaml

docker build -t cheers/gateway:dev server
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend
kind load docker-image cheers/gateway:dev cheers/frontend:dev --name cheers

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem
openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem

helm upgrade --install cheers deploy/helm/cheers -n cheers --create-namespace \
  -f deploy/helm/cheers/values-dev.yaml \
  --set-file secrets.jwtPrivateKey=jwt_priv.pem \
  --set-file secrets.jwtPublicKey=jwt_pub.pem
```

- UI：前端 NodePort → `http://localhost:30080`（登录 `admin` / `admin12345`，
  开发默认值，正式环境务必修改）。
- 不想本地构建？GHCR 上有预构建的公开镜像
  （`ghcr.io/eleperson/cheers-gateway`、`ghcr.io/eleperson/cheers-frontend`；
  tag 用 `main` 或某个发布版本）—— `--set *.image.repository/tag` 覆盖方式见
  chart README。
- 启用 OpenCode 智能体 bot：`--set bot.enabled=true`，并提供其 token / API-key secret。

**chart values、secrets、ingress、生产 overlay 与 bot：**
[../../deploy/helm/cheers/README.md](../../deploy/helm/cheers/README.md)。

---

## 该用哪种？

- **要改代码？** → 方式 1（源码运行）。
- **在一台机器上跑？** → 方式 2（Docker Compose）。
- **集群或生产？** → 方式 3（Helm / Kubernetes）。
