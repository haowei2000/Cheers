# Cheers Troubleshooting Q&A

> **Language**: English | [中文](技术排查Q&A.zh-CN.md)

Use this guide to diagnose common deployment, runtime, Bot, file, and database problems. Always start from the `.env` used by the current deployment instead of copying example values blindly.

## Basic Checks

```bash
docker compose ps
curl http://localhost:8000/health
curl http://localhost:8000/docs
```

Expected:

- backend, frontend, postgres, redis, rustfs, and kkfileview are running.
- `/health` returns `{"status":"ok"}`.
- Swagger opens at `http://localhost:8000/docs`.

## Logs

```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

Backend file logs are written to `data/logs` when `LOG_DIR` is enabled:

- `cheers.log`: general logs
- `error.log`: errors and tracebacks

## Frontend Does Not Open

Check:

```bash
docker compose ps frontend
curl -I http://localhost
```

Common causes:

- `FRONTEND_HOST_PORT` is already in use.
- Frontend image build failed.
- Reverse proxy does not forward `/api`, `/ws`, or `/preview` correctly.

## API or Health Check Fails

Check backend and PostgreSQL logs:

```bash
docker compose logs --tail=200 backend
docker compose logs --tail=200 postgres
```

Common causes:

- `.env` PostgreSQL password does not match an already-initialized `data/postgres` directory.
- Alembic migration failed.
- Required secrets or storage configuration are missing.

## No Projects in Sidebar

Possible causes:

- Seed data was not created.
- Current user is not a member of any workspace/channel.

Fix by enabling seed data or creating a workspace and channel from the admin UI.

## Bot Does Not Reply

Check:

- The Bot is a member of the current channel.
- The mention username is exact.
- HTTP Bot model URL, model name, and API key are correct.
- Agent Bridge provider is connected to both `/ws/agent-bridge/control` and `/ws/agent-bridge/data`.

Agent Bridge status:

```bash
curl -H "X-Agent-Bridge-Token: <AGENT_BRIDGE_TOKEN>" \
  http://localhost:8000/api/v1/agent-bridge/status
```

## File Preview Fails

First verify regular download, then inspect kkFileView:

```bash
curl -I http://localhost/preview/
docker compose logs --tail=200 kkfileview
```

Common causes:

- `PUBLIC_BASE_URL` is not reachable from the kkFileView container.
- `KKFILEVIEW_BASE_URL` does not include `/preview`.
- `KKFILEVIEW_TRUST_HOST` does not match the public hostname.
- Object storage key, bucket, or endpoint is wrong.

See [kkFileView Preview Guide](kkFileView配置说明.md) and [RustFS Object Storage Guide](RustFS对象存储部署说明.md).

## Database Inspection

Cheers defaults to PostgreSQL. Use the connection values in `.env`:

```bash
docker compose exec postgres psql -U "${POSTGRES_USER:-cheers}" "${POSTGRES_DB:-cheers}"
```

Common tables:

- `users`, `workspaces`, `workspace_memberships`
- `channels`, `channel_memberships`
- `bot_accounts`
- `messages`
- `memory_entries`, `history_pages`
- `file_records`

Before rolling back code, downgrade the main database and Context Store to revisions supported by the target code version.
