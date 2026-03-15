# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentNexus (智枢协作平台) is a Slack-like multi-agent + human collaboration chat hub. Users @mention bots in channels; an orchestrator dispatches requests to LLM-backed bots and writes replies back to the channel in real time via WebSocket.

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
cd backend && flake8 app/
```

Database initialization (tables only, no migrations):
```bash
# Tables are auto-created on first startup via SQLAlchemy metadata.create_all
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
4. `orchestrator/adapter_resolver.py` maps `bot_id` -> `LLMBotAdapter` (or `MockOpenClawAdapter` if bot is misconfigured)
5. `adapters/llm_bot.py` (`LLMBotAdapter`) builds system prompt + user message and calls the bot's configured LLM via OpenAI-compatible API
6. Bot reply is written to DB as a `Message` and broadcast via `chat_core/ws_manager.py` WebSocket to `ws/channels/{channel_id}`

### Bot Architecture

Each `BotAccount` is composed of:
- **`AIModel`** — LLM provider config (base_url, model_name, api_key, provider)
- **`PromptTemplate`** — system_prompt + user_template with `{{message}}` placeholder
- Optional `custom_system_prompt` overrides the template's system_prompt

The `OpenClawAdapter` ABC (`adapters/base.py`) is the isolation boundary. Orchestrator only depends on this interface. Current implementations: `LLMBotAdapter`, `MockOpenClawAdapter`, `HttpOpenClawAdapter`, `WsOpenClawAdapter`.

### Special Bot: coordinator

Username `coordinator` has two modes:
- **Explicit @coordinator**: aggregates replies from all other channel bots into one combined response
- **`orchestrator_direct_answer` setting enabled**: auto-routes any unanswered message to coordinator, which can suggest other bots via `extract_suggested_bots()` (triggers `orchestrator_auto_takeover` if enabled)

### Four-Layer Memory

Each channel has four memory layers stored in a separate SQLite DB (`data/context_store/context.db`):
- `anchor` — project anchor (highest priority)
- `decisions` — important decisions
- `files_index` — uploaded files index
- `recent` — recent channel activity

Loaded by `memory/manager.py` and injected into every `AgentPayload.memory_context`. Written to `AgentPayload` and available as template variables in `LLMBotAdapter`.

### Key Files

| File | Purpose |
|---|---|
| `backend/app/main.py` | FastAPI app entry, router registration, startup hooks |
| `backend/app/config.py` | All settings via `pydantic-settings` + `.env` |
| `backend/app/db/models.py` | SQLAlchemy ORM models (UUID PKs as String(36)) |
| `backend/app/db/session.py` | Async engine (SQLite: NullPool + WAL mode) |
| `backend/app/orchestrator/service.py` | Core dispatch logic |
| `backend/app/adapters/base.py` | `OpenClawAdapter` ABC, `AgentPayload`, `AgentResponse` |
| `backend/app/adapters/llm_bot.py` | `LLMBotAdapter` — main bot implementation |
| `backend/app/memory/manager.py` | Four-layer memory read/write |
| `backend/app/admin/settings_store.py` | JSON-file-backed admin settings (LLM providers, orchestrator flags) |
| `frontend/src/App.tsx` | Entire frontend SPA (single file, React + Tailwind) |
| `frontend/src/AdminPage.tsx` | Admin panel SPA |
| `tests/conftest.py` | Pytest fixtures: in-memory SQLite, HTTPX AsyncClient |

### Database

- **Main DB**: `backend/data/main.db` (SQLite, all business entities)
- **Context Store**: `backend/data/context_store/context.db` (four-layer memory, separate SQLite)
- SQLite uses `NullPool` + WAL journal mode for concurrency safety
- Tables are created via `Base.metadata.create_all` on startup (no Alembic migrations in current dev setup)
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
DATABASE_URL=sqlite+aiosqlite:///data/main.db
SQLITE_CONTEXT_PATH=data/context_store/context.db
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
- `db_session` — isolated in-memory SQLite session per test
- `client` — HTTPX `AsyncClient` with dependency-injected test DB

All tests are async (`asyncio_mode = "auto"`).
