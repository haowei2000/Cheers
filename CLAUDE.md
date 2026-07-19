# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Language**: English | [中文](CLAUDE.zh-CN.md)

## Project Overview

Cheers is an **external-agent-first** chat platform: the **Rust gateway** (`server/`)
is the only backend, the **React frontend** (`frontend/`) is the web client, and
intelligence comes from externally connected ACP agents — there is no built-in Python
agent service. See [docs/arch/ARCHITECTURE_OVERVIEW.md](docs/arch/ARCHITECTURE_OVERVIEW.md).

Repo layout:

- `server/` — Rust (axum + sqlx/Postgres) gateway: REST API, browser WS gateway, Agent Bridge
- `frontend/` — React 18 + Vite + Tailwind + zustand + react-query web client (also the Tauri webview)
- `packages/cheers-acp-connector-rs/` — Rust ACP connector daemon (the supported connector; the old npm connector was removed and must not be reintroduced). `bridge-protocol/` inside it is shared with the server build.
- `packages/cheers-mcp-server/` — Rust MCP bridge, the standard way agents reach platform resources
- `apps/macos/` — Tauri desktop shell wrapping the frontend; `apps/ios/`, `apps/android/` — mobile apps
- `deploy/helm/cheers/` — Helm chart, the canonical local/dev deployment
- `docs/arch/` — design notes; some describe superseded models — check for ⚠️ SUPERSEDED markers, and treat README, `docs/help/`, and current code as authoritative

## Architecture Big Picture

One Rust process serves three "faces" on the same port:

1. **REST API** (`server/src/api/`) — CRUD for users, channels, messages, bots, workspaces, files…
2. **WS Gateway** (`server/src/gateway/`, `ws/`, `realtime/`) — browser/mobile realtime connections, presence, fan-out
3. **Agent Bridge** (`server/src/gateway/bridge_frames.rs`, `dispatcher.rs`) — bot connector connections, task dispatch, streamed delta forwarding, ACP session management

Supporting layers: `server/src/domain/` (business logic; sessions, mentions, chains, ACP policy/events), `server/src/resource/` (the typed resource-access protocol bots use to read/write platform state — messages, files, fs, members, plans…), `server/src/infra/` (Postgres, S3/rustfs, email, web push, STT, rate limiting), `server/src/notify/` (APNs, relay).

Key model invariants (current, post-refactor):

- Authorization is **channel-role only** (no Grant/trust_level model — that's a dead concept in old docs)
- Files are the only substrate; agents **pull** context; no separate "memory" concept
- Message bodies are text + flat tokens (`<@bot:id>`, `<#file:id>`…); operations never go in the body — they use typed resource requests
- Bot@bot triggering happens via the `post_message` resource tool with `mention_names`, not literal `@name` text in a reply

## Commands

```bash
# Gateway (run from server/)
cargo build && cargo test          # unit/build checks, no cluster needed
cargo test <name>                  # single test filter
cargo clippy --all-targets         # lint (also: make lint from repo root)
cargo fmt                          # format — run `cargo fmt --check` per-crate before pushing; CI's fmt gate fails PRs that cargo check/test won't catch

# Frontend (run from frontend/)
npm run dev                        # Vite dev server
npm run typecheck                  # tsc --noEmit
npm run test                       # vitest run
npm run build

# Connector / MCP crates: cargo fmt --check, cargo test, cargo check inside each package dir
```

## Local Run: Kubernetes (canonical)

The local stack runs on a **kind** cluster via the **Helm chart** at
`deploy/helm/cheers` — gateway + frontend + postgres + rustfs (redis is opt-in).
This is the supported "start the stack" path; the `docker-compose.*` files are a
legacy fallback (the gitignored local `docker-compose.yml` may be stale —
re-copy from `docker-compose.yml.template` if you use it). Full chart docs:
[deploy/helm/cheers/README.md](deploy/helm/cheers/README.md).

Cluster: kind cluster `cheers` (kube context `kind-cheers`), namespace `cheers`.
UI: frontend NodePort → <http://localhost:30080> (sign in `admin` / `admin12345`).

```bash
# First-time install: build images → load into kind → install the release
docker build -t cheers/gateway:dev -f server/Dockerfile .   # root context: server needs packages/.../bridge-protocol
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend
kind load docker-image cheers/gateway:dev cheers/frontend:dev --name cheers
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt_priv.pem
openssl rsa -in /tmp/jwt_priv.pem -pubout -out /tmp/jwt_pub.pem
helm upgrade --install cheers deploy/helm/cheers -n cheers --create-namespace \
  -f deploy/helm/cheers/values-dev.yaml \
  --set-file secrets.jwtPrivateKey=/tmp/jwt_priv.pem \
  --set-file secrets.jwtPublicKey=/tmp/jwt_pub.pem   # gateway runs sqlx migrations on startup
```

```bash
# Redeploy after a code change: rebuild → reload into kind → roll the pod.
# Shortcut for all of the below: ./scripts/redeploy.sh [gateway|frontend|both]
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend  # gateway: docker build -t cheers/gateway:dev -f server/Dockerfile .
kind load docker-image cheers/frontend:dev --name cheers
kubectl -n cheers rollout restart deployment/cheers-frontend   # or deployment/cheers-gateway
kubectl -n cheers rollout status  deployment/cheers-frontend

# Status / logs / teardown
kubectl get pods -n cheers
kubectl -n cheers logs deploy/cheers-gateway -f
helm uninstall cheers -n cheers           # remove the release (keeps the kind cluster)
```

> Fast frontend-only inner loop: you can still run Vite
> (`npm --prefix frontend run dev`) pointed at the in-cluster gateway, but the
> canonical, reproducible stack is the Helm/kind path above — start it with k8s.

> Integration tests against the running stack are being re-established on the Rust
> gateway (the old `pytest -m integration` suite was removed with the Python backend).
> When added, they must read the target URL from `INTEGRATION_BASE_URL` (never hard-code
> a port) so multiple stacks can run in parallel via a unique `COMPOSE_PROJECT_NAME` +
> distinct host ports.

## sqlx Migration Discipline (Mandatory)

Migrations live in `server/migrations/<NNNN>_<desc>.sql` and run automatically on
gateway startup (`sqlx::migrate!`). Treat them as database protocol changes:

- **Sequential, linear, never reused prefixes.** If two branches add migrations in parallel, rebase and renumber — never two `0003_*.sql`.
- **Never edit an already-applied migration's body** — sqlx checksums them; changing one breaks startup. Add a new numbered migration instead.
- **Idempotent DDL** (`IF NOT EXISTS` / `IF EXISTS`). Postgres has no `ADD CONSTRAINT IF NOT EXISTS` — put constraints inline in `CREATE TABLE`.
- **ids are `VARCHAR(36)`**, not `UUID`; keep FKs consistent.
- Verify from an empty DB before release (clean Postgres + gateway boot, or `sqlx migrate run` on a scratch DB).

## Branch Strategy

Work branches target `develop`; `main` only accepts merges from `develop` (plus
hotfix-from-main as the escape hatch). Never merge one feature branch into both
`main` and `develop` — the criss-cross breaks GitHub's merge state.

## Problem-First Fixing (Required)

- Do **not** use temporary compatibility placeholders to hide real API/domain mismatches
  (for example adding unused arguments like `_after`, `_after_limit`, or returning fallback
  fields only to keep old callers from breaking).
- When contracts differ (pagination, response shape, status format, etc.), fix the source of truth
  first and make both ends follow the same protocol.
- Prefer an explicit migration plan (deprecation + removal window) over silent shims.

## Frontend Conventions

UI work must follow [frontend/DESIGN.md](frontend/DESIGN.md): use the shared
components in `frontend/src/components/ui/`, and copy the documented canonical
recipes instead of inventing new styles. Feature code lives under
`frontend/src/features/<area>/` (auth, bots, chat, desktop, fleet, friends,
invite, settings, workbench).

## Connector Releases

When `packages/cheers-acp-connector-rs` behavior materially changes, follow the
release order in [AGENTS.md](AGENTS.md) (version bump → fmt/test/check → rebuild
`opencode-bot` image → upgrade local daemons → recreate container deployments;
auto-update requires the signed `connector-manifest.json` from the tag's CI job).

## Related Documentation

- [Documentation Home](docs/help/README.md)
- [User Manual](docs/help/使用说明书.md)
- [Roadmap](docs/ROADMAP.md)
