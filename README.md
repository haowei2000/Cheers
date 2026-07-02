# Cheers

> **Language**: English | [中文](README.zh-CN.md)

[![CI](https://github.com/haowei2000/Cheers/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/haowei2000/Cheers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Cheers is a Slack-style collaboration hub for humans and AI agents. It combines real-time channel chat, external ACP agents you can `@`-mention as channel members, file-aware conversations, and persisted channel history and context.

> Project status: early public preview. Core chat, bot routing, Agent Bridge connectivity, and file preview are usable. Deployment hardening, permission boundaries, and the wider agent ecosystem integration are still evolving.

## Documentation

English is the default documentation language. Chinese mirrors use the `.zh-CN.md` suffix.

**User and operations docs**

- [Documentation Home](docs/help/README.md) / [中文](docs/help/README.zh-CN.md)
- [**Deployment Guide** (source · Docker Compose · Helm/K8s)](docs/help/deployment.md) / [中文](docs/help/deployment.zh-CN.md)
- [User Manual](docs/help/使用说明书.md) / [中文](docs/help/使用说明书.zh-CN.md)
- [User Guide](docs/help/普通用户使用说明.md) / [中文](docs/help/普通用户使用说明.zh-CN.md)
- [Admin Guide](docs/help/系统管理说明书.md) / [中文](docs/help/系统管理说明书.zh-CN.md)
- [Docker Compose Deployment Guide](docs/help/docker-compose-deploy.md) / [中文](docs/help/docker-compose-deploy.zh-CN.md)
- [Installation Guide (legacy)](docs/help/安装部署说明.md) / [中文](docs/help/安装部署说明.zh-CN.md)
- [Troubleshooting Q&A](docs/help/技术排查Q&A.md) / [中文](docs/help/技术排查Q&A.zh-CN.md)
- [Agent Bridge Integration Guide](docs/help/AgentBridge接入指南.md) / [中文](docs/help/AgentBridge接入指南.zh-CN.md) — ACP local agents are the recommended path; OpenClaw links are legacy/deprecated.
- [RustFS Object Storage Guide](docs/help/RustFS对象存储部署说明.md) / [中文](docs/help/RustFS对象存储部署说明.zh-CN.md)

**Development and architecture docs**

- [Roadmap](docs/ROADMAP.md) / [中文](docs/ROADMAP.zh-CN.md)
- [Architecture Overview](docs/arch/ARCHITECTURE_OVERVIEW.md)
- [Mesh Rework Plan](docs/arch/REFACTOR_PLAN.md)
- [Gateway Protocol](docs/arch/WIRE_PROTOCOL.md)
- [Bot Permission & Trust](docs/arch/BOT_PERMISSION.md)
- [Gateway Architecture](docs/arch/GATEWAY_CODE_ARCH.md)
- [ACP Connection & Resource Protocols](docs/arch/ACP_CONNECTION_MODEL.md) / [docs/arch/AGENT_BRIDGE_RESOURCE.md](docs/arch/AGENT_BRIDGE_RESOURCE.md)
- [Unified Architecture Index](docs/INDEX.md) / [中文](docs/INDEX.zh-CN.md)

## Stack

- Backend: Rust gateway (Axum + SQLx) — the only backend service
- Frontend: React, TypeScript, Tailwind CSS, Vite
- Agents: external ACP agents (OpenCode, Claude, Codex) via `cheers-mcp-server` and ACP connectors
- Storage: PostgreSQL for business data and channel history, S3-compatible object storage for files
- Preview: built into the gateway (`GET /files/:id/preview`); office→PDF conversion via optional Gotenberg
- Deployment: Docker Compose (single host) or Kubernetes via the Helm chart in `deploy/helm/cheers`

## Deployment

Cheers runs three ways — see the [Deployment Guide](docs/help/deployment.md) for all three:

1. **From source** — `cargo run` + `npm run dev` with backing services in Docker (development).
2. **Docker Compose** — one host, all containers (self-hosting, demos). Quick Start below.
3. **Helm / Kubernetes** — cluster workloads (production, scale-out); chart in `deploy/helm/cheers`.

## Quick Start

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# Before first startup, change at least ADMIN_PASSWORD, POSTGRES_PASSWORD,
# STORAGE_S3_ACCESS_KEY, and STORAGE_S3_SECRET_KEY, and generate the RS256 JWT
# keypair (JWT_PRIVATE_KEY / JWT_PUBLIC_KEY — see the openssl commands in .env.example).
docker compose up -d
```

Default local endpoints:

- Frontend: http://localhost
- API: http://localhost:8000
- Health check: http://localhost:8000/health

Document preview (office→PDF) uses the bundled Gotenberg service and needs no extra configuration. Never use `.env.example` secrets in production.

## Local Development

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
docker compose up -d postgres redis rustfs gotenberg

# Rust gateway (runs sqlx migrations on startup)
cd server
cargo run
```

```bash
cd frontend
npm install
npm run dev
```

## Bots

The platform is **external-agent-first**: there is no built-in bot (the old
`Coordinator` is gone — routing is a deterministic `@mention → bot` lookup). Connect an
external ACP agent (OpenCode, Claude, Codex) via `packages/cheers-mcp-server` or an
ACP connector, then `@` it in a channel. See
[docs/arch/BUILTIN_AGENT.md](docs/arch/BUILTIN_AGENT.md) and
[docs/arch/DECENTRALIZED_MESH.md](docs/arch/DECENTRALIZED_MESH.md). Default seed data for
the gateway is being re-established.

## Contributing

Read [CONTRIBUTING.md](docs/community/CONTRIBUTING.md) before opening a pull request.

- Work branches must target `develop`.
- `main` only accepts merges from `develop`.
- Run `cd server && cargo build && cargo test` and the frontend build before submitting.
- Report security issues privately according to [SECURITY.md](docs/governance/SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

Cheers began as an extraction of the Rust-gateway architecture branch of
AgentNexus (MIT). The original copyright notice is preserved in
[LICENSE](LICENSE).
