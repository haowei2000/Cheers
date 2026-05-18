# CLAUDE.md

> **语言**：中文 | [English](CLAUDE.md)

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentNexus (智枢协作平台) is a Slack-like multi-agent + human collaboration chat hub. Users @mention bots in channels; an orchestrator dispatches requests to LLM-backed bots and writes replies back to the channel in real time via WebSocket.

## Branch Strategy

- All work branch PRs must be merged into `develop` first.
- The `main` branch must only receive merges from `develop`.
- Do not merge feature, fix, hotfix, or other work branch PRs directly into `main`.

## Commands

### Backend

```bash
cd backend
uv venv                        # create venv (first time)
source .venv/bin/activate
uv sync                        # install all deps including dev
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Run tests (from `backend/` with venv active, or from project root):
```bash
cd backend && pytest                        # all tests
cd backend && pytest ../tests/test_memory.py   # single file
cd backend && pytest ../tests/test_orchestrator_integration.py -v
```

Lint:
```bash
cd backend && ruff check app/
```

Database migrations (Alembic — must run before starting the server):
```bash
cd backend

# 主数据库（main.db）
alembic upgrade head

# Context Store（context.db，四层记忆）
alembic -c alembic_context.ini upgrade head

# 新建迁移（主库）
alembic revision -m "描述"

# 新建迁移（context store）
alembic -c alembic_context.ini revision -m "描述"
```

Seed data (optional, run after migrations):
```bash
# For seed data: set SEED_DATA=1 before starting the server
SEED_DATA=1 uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev       # dev server at http://localhost:5173
npm run build     # production build (tsc + vite)
```

### Docker (full stack)

```bash
cp docker-compose.yml.template docker-compose.yml
docker compose up -d
# Frontend: http://localhost:80   API: http://localhost:8000
```

## Architecture

### Data Flow: Message -> Bot Reply

1. User POSTs message to `POST /api/channels/{channel_id}/messages`
2. `chat_core/messages.py` saves the message and calls `run_orchestrator()`
3. `orchestrator/service.py` extracts `@mentions`, resolves target bots, loads four-layer memory, and serially calls each bot's adapter
4. `orchestrator/adapter_resolver.py` maps `bot_id` -> `HttpBotAdapter` (or `MockBotAdapter` if bot is misconfigured)
5. `adapters/http_bot.py` (`HttpBotAdapter`) builds system prompt + user message and calls the bot's configured LLM via OpenAI-compatible API
6. Bot reply is written to DB as a `Message` and broadcast via `chat_core/ws_manager.py` WebSocket to `ws/channels/{channel_id}`

### Bot Architecture

Each `BotAccount` is composed of:
- **`AIModel`** — LLM provider config (base_url, model_name, api_key, provider)
- **`PromptTemplate`** — system_prompt + user_template with `{{message}}` placeholder
- Optional `custom_system_prompt` overrides the template's system_prompt

The `OpenClawAdapter` ABC (`services/adapters/base.py`) is the isolation boundary. Only `services/orchestrator/adapter_resolver.py` constructs concrete adapters — routes and domain services must go through the resolver, not import adapter classes directly. Current implementations: `HttpBotAdapter`, `ChannelBotAdapter`, `HelpBotAdapter`, `WebsocketBotAdapter`, `MockBotAdapter`.

### Special Bot: coordinator

Username `coordinator` has two modes:
- **Explicit @coordinator**: aggregates replies from all other channel bots into one combined response
- **`orchestrator_direct_answer` setting enabled**: auto-routes any unanswered message to coordinator, which can suggest other bots via `extract_suggested_bots()` (triggers `orchestrator_auto_takeover` if enabled)

### Four-Layer Memory

Each channel has four memory layers stored in the PostgreSQL DB (`context_store` table, same or separate DB via `CONTEXT_DB_URL`):
- `anchor` — project anchor (highest priority)
- `decisions` — important decisions
- `files_index` — uploaded files index
- `recent` — recent channel activity

Loaded by `memory/manager.py` and injected into every `AgentPayload.memory_context`. Written to `AgentPayload` and available as template variables in `HttpBotAdapter`.

### Bot Tools (ChannelBotAdapter)

Bots using `ChannelBotAdapter` have access to built-in tools via LangChain function calling:

| Tool | Purpose |
|------|---------|
| `call_bot` | Delegate task to another channel bot |
| `call_user` | @mention a user with optional question |
| `update_anchor` | Update project anchor memory layer |
| `update_decision` | Record decisions to memory layer |
| `update_progress` | Update progress layer |
| `create_file` | Save content as markdown file |
| `read_file` | Read uploaded file content |
| `generate_image` | Generate images via AI |
| `edit_image` | Edit images via AI |
| `web_fetch` | **Fetch webpage content from URL** |
| `web_search` | **Search the web via DuckDuckGo** |

Tools are defined in `backend/app/services/adapters/channel_bot.py` (`_make_tools()`). Web tools implementation is in `backend/app/tools/web.py`.

### Key Files

| File | Purpose |
|---|---|
| `backend/app/main.py` | FastAPI app entry, router registration, startup hooks |
| `backend/app/config.py` | All settings via `pydantic-settings` + `.env` |
| `backend/app/db/models.py` | SQLAlchemy ORM models (UUID PKs as String(36)) |
| `backend/app/db/session.py` | Async engine (PostgreSQL via asyncpg) |
| `backend/app/services/orchestrator/service.py` | Core dispatch logic |
| `backend/app/services/orchestrator/adapter_resolver.py` | Sole entry point for building adapters from a `bot_id` |
| `backend/app/services/adapters/base.py` | `OpenClawAdapter` ABC, `AgentPayload`, `AgentResponse` |
| `backend/app/services/adapters/http_bot.py` | `HttpBotAdapter` — main bot implementation |
| `backend/app/services/adapters/channel_bot.py` | `ChannelBotAdapter` with tool system |
| `backend/app/services/memory/manager.py` | Four-layer memory read/write |
| `backend/app/services/admin/settings_store.py` | JSON-file-backed admin settings (LLM providers, orchestrator flags) |
| `backend/app/tools/web.py` | Web tools: `web_fetch` and `web_search` |
| `frontend/src/App.tsx` | Entire frontend SPA (single file, React + Tailwind) |
| `frontend/src/AdminPage.tsx` | Admin panel SPA |
| `tests/conftest.py` | Pytest fixtures: PostgreSQL test DB, HTTPX AsyncClient |

### Database

- **Main DB**: PostgreSQL (`DATABASE_URL`, default `postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus`)
- **Context Store**: PostgreSQL (`CONTEXT_DB_URL`, defaults to same DB as main; stores four-layer memory in `context_store` table)
- Tables managed by Alembic migrations; run `alembic upgrade head` before first start
- All IDs are `String(36)` UUIDs

### API Structure

All REST routes are prefixed under `/api/`:
- `/api/workspaces/` — workspace CRUD + member management
- `/api/channels/` — channel CRUD + membership
- `/api/channels/{id}/messages` — message history + send (triggers orchestrator)
- `/api/bots/` — bot account CRUD
- `/api/admin/` — LLM providers, orchestrator settings, logs
- `/api/admin/models/` — AIModel CRUD
- `/api/admin/templates/` — PromptTemplate CRUD
- `/api/files/` — file upload + conversion (docx/pdf/xlsx -> markdown via `file_processor/`)
- `/ws/channels/{channel_id}` — WebSocket for real-time push

### Configuration (`.env`)

Key env vars (all have defaults in `config.py`):
```
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus
CONTEXT_DB_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/agentnexus
GUIDE_LLM_BASE_URL=http://localhost:11434/v1
GUIDE_LLM_MODEL=llama3.2
SYSTEM_LLM_API_KEY=
SYSTEM_LLM_BASE_URL=
SEED_DATA=1
```

### Frontend

The frontend is a minimal React SPA (React 18 + Vite + Tailwind CSS + TypeScript). The entire main chat UI is in `frontend/src/App.tsx` and admin panel in `frontend/src/AdminPage.tsx`. The frontend uses a hardcoded dev user ID (`a0000000-0000-0000-0000-000000000001`); auth routes exist in `auth/routes.py` but are not fully integrated in the UI yet.

### Testing

Tests live in `tests/` (at project root), configured in `backend/pyproject.toml` with `testpaths = ["../tests"]`. The conftest provides:
- `db_session` — isolated PostgreSQL session per test (uses `TEST_DATABASE_URL` env var)
- `client` — HTTPX `AsyncClient` with dependency-injected test DB

All tests are async (`asyncio_mode = "auto"`).

```bash
cd backend && pytest ../tests/test_web_tools.py -v  # web tools tests
cd backend && pytest ../tests/test_adapters.py -v   # adapter tests
```

## Skills 配置

### Skills 目录

本项目集成了 **SkillHub** 作为 Skills 管理平台：

| 路径 | 说明 |
|------|------|
| `skills-repo/skills/` | Git 仓库中的 Skills（源码） |
| `skillhub-standalone/backend/data/skills-local/` | SkillHub 本地缓存（已同步到本地） |

**推荐使用路径**：`skillhub-standalone/backend/data/skills-local/`

### SkillHub 服务

- **前端**：`http://localhost:5173`（或 5174）
- **后端 API**：`http://localhost:8002`
- **API 文档**：`http://localhost:8002/docs`

### 使用 Skills

当需要使用某个 Skill 时：

1. **通过 SkillHub Web UI**：访问 http://localhost:5173 浏览和下载 Skills
2. **通过 API**：SkillHub 提供了 OpenClaw 兼容接口
   - `GET /api/v1/skillhub/openclaw/skills` - 列出所有 Skills
   - `GET /api/v1/skillhub/openclaw/paths/{skill_id}` - 获取 Skill 路径

### 同步 Skills

在 SkillHub 前端点击"更新"按钮，从 GitFox 仓库同步最新 Skills 到本地。

### 可用 Skills

当前已同步的 Skills：

| Skill | 用途 |
|-------|------|
| `ai-dev` | AI 自主编程工作流 |
| `zentao-task` | 禅道任务整理 |
| `zentao-live` | 禅道实时 API 操作 |
| `gitfox-live` | GitFox 操作 |
| `docx` | Word 文档处理 |
| `pdf` | PDF 处理 |
| `pptx` | PPT 处理 |
| `xlsx` | Excel 处理 |
| `self-improving` | 自我改进 Agent |
| `obsidian-kb` | 知识库操作 |
| `mcp-builder` | MCP 服务器构建 |
| `skill-creator` | Skill 创建工具 |
