# Cheers 技术排查 Q&A

> **语言**：中文 | [English](技术排查Q&A.md)

本文面向部署者、管理员和开发者，用于快速定位常见问题。排查前请先确认你正在查看的是当前部署使用的 `.env`，不要直接套用文档示例里的端口、库名、账号或密码。

## 一、基础检查

```bash
docker compose ps
curl http://localhost:8000/health
```

正常情况下：

- `backend`、`frontend`、`postgres`、`redis`、`rustfs` 应处于运行状态。
- `/health` 返回 `ok`。

Rust 网关没有 Swagger UI —— 不存在 `/docs` 路由。REST 路由定义见 `server/src/router.rs`。

## 二、日志位置

Docker 部署：

```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

后端文件日志默认写入 `data/logs`，常见文件：

- `cheers.log`：通用日志
- `error.log`：错误日志

## 三、常见问题

### 3.1 前端打不开

检查：

```bash
docker compose ps frontend
curl -I http://localhost
```

常见原因：

- `FRONTEND_HOST_PORT` 被占用。
- `frontend` 镜像构建失败。
- 反向代理没有把 `/api`、`/ws`、`/preview` 转发到对应服务。

### 3.2 API 或健康检查失败

检查：

```bash
docker compose logs --tail=200 backend
docker compose logs --tail=200 postgres
```

常见原因：

- `.env` 中 `POSTGRES_PASSWORD` 与已初始化的 `data/postgres` 不一致。
- 数据库迁移失败。
- `JWT_SECRET_KEY`、对象存储或文件目录配置缺失。

如果修改过 PostgreSQL 密码但保留了旧的 `data/postgres`，需要使用旧密码启动后再改密，或清理本地开发数据目录重新初始化。

### 3.3 左侧没有项目

可能原因：

- 没有执行种子数据。
- 当前用户未加入任何工作空间或项目。

处理：

```bash
SEED_DATA=1 docker compose up -d backend
```

或在前端「管理」中创建工作空间和项目，再添加成员。

### 3.4 @ Bot 没有回复

检查：

- Bot 是否已加入当前项目。
- @ 的 username 是否完全一致。
- Agent Bridge Bot 是否有 provider 连接 `/ws/agent-bridge/control` 和 `/ws/agent-bridge/data`。
- HTTP Bot 对应 AIModel 的 `base_url`、`model_name`、API Key 是否正确。

可查看：

```bash
docker compose logs -f backend
curl -H "X-Agent-Bridge-Token: <AGENT_BRIDGE_TOKEN>" \
  http://localhost:8000/api/v1/agent-bridge/status
```

### 3.5 文件预览失败

预览是 gateway 内置能力：前端调用 `GET /files/:id/preview`，gateway 通过
Gotenberg 把 office 文档转成 PDF。先确认普通下载是否正常，再检查 gateway 和
Gotenberg：

```bash
curl -I http://localhost:8000/api/v1/files/<file_id>/preview
docker compose logs --tail=200 gateway
docker compose logs --tail=200 gotenberg
```

常见原因：

- gateway 无法通过 `GOTENBERG_URL` 访问 Gotenberg。
- `gotenberg` 服务未启动。
- 对象存储访问密钥或桶配置错误。

详见 [RustFS对象存储部署说明](RustFS对象存储部署说明.md)。

## 四、数据库排查

当前默认使用 PostgreSQL。连接信息以 `.env` 中的 `DATABASE_URL` 和 `CONTEXT_DB_URL` 为准。

Docker 内部可先进入 postgres：

```bash
docker compose exec postgres psql -U "${POSTGRES_USER:-cheers}" "${POSTGRES_DB:-cheers}"
```

常看表：

- `users`、`workspaces`、`workspace_memberships`
- `channels`、`channel_memberships`
- `bot_accounts`
- `messages`
- `memory_entries`、`history_pages`
- `file_records`

## 五、升级与回滚

升级后优先确认迁移：

```bash
docker compose logs --tail=200 backend
docker compose --profile tools run --rm db-migrate
```

回滚旧代码前，先按 [安装部署说明](安装部署说明.md) 的数据库回退章节，将主库和 Context Store 降到旧代码认识的 revision。
