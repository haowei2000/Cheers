# Cheers

> **Language**: English | [中文](README.zh-CN.md)

[![CI](https://github.com/Grant-Huang/Cheers/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Grant-Huang/Cheers/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Cheers is a Slack-style collaboration hub for humans and AI agents. It combines real-time channel chat, Agent Bridge providers, HTTP LLM bots, file-aware conversations, and a four-layer channel memory model.

> Project status: early public preview. Core chat, Bot routing, Agent Bridge connectivity, file preview, and channel memory flows are usable. Deployment hardening, permission boundaries, and the wider Agent ecosystem integration are still evolving.

## Documentation

English is the default documentation language. Chinese mirrors use the `.zh-CN.md` suffix.

**User and operations docs**

- [Documentation Home](docs/help/README.md) / [中文](docs/help/README.zh-CN.md)
- [User Manual](docs/help/使用说明书.md) / [中文](docs/help/使用说明书.zh-CN.md)
- [User Guide](docs/help/普通用户使用说明.md) / [中文](docs/help/普通用户使用说明.zh-CN.md)
- [Admin Guide](docs/help/系统管理说明书.md) / [中文](docs/help/系统管理说明书.zh-CN.md)
- [Installation Guide](docs/help/安装部署说明.md) / [中文](docs/help/安装部署说明.zh-CN.md)
- [Troubleshooting Q&A](docs/help/技术排查Q&A.md) / [中文](docs/help/技术排查Q&A.zh-CN.md)
- [Agent Bridge Integration Guide](docs/help/AgentBridge接入指南.md) / [中文](docs/help/AgentBridge接入指南.zh-CN.md) — ACP local agents are the recommended path; OpenClaw links are legacy/deprecated.
- [RustFS Object Storage Guide](docs/help/RustFS对象存储部署说明.md) / [中文](docs/help/RustFS对象存储部署说明.zh-CN.md)
- [kkFileView Preview Guide](docs/help/kkFileView配置说明.md) / [中文](docs/help/kkFileView配置说明.zh-CN.md)

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

- Backend: Rust + Axum + SQLx (Gateway) and React Frontend
- Frontend: React, TypeScript, Tailwind CSS, Vite
- Agent runtime: external ACP agents via `cheers-mcp-server` and ACP connectors
- Storage: PostgreSQL for business data and memory, S3-compatible object storage for files, optional kkFileView for complex document preview
- Deployment: Docker Compose

## Quick Start

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# Before first startup, change at least ADMIN_PASSWORD, JWT_SECRET_KEY,
# POSTGRES_PASSWORD, RUSTFS_ACCESS_KEY, and RUSTFS_SECRET_KEY.
docker compose up -d
```

Default local endpoints:

- Frontend: http://localhost
- API: http://localhost:8000
- Health check: http://localhost:8000/health

If document preview is enabled, make sure `PUBLIC_BASE_URL` is reachable from the kkFileView container. Never use `.env.example` secrets in production.

## Local Development

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
docker compose up -d postgres redis rustfs kkfileview

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

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

- Work branches must target `develop`.
- `main` only accepts merges from `develop`.
- Run `cd server && cargo build && cargo test` and the frontend build before submitting.
- Report security issues privately according to [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
