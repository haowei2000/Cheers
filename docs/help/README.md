# Cheers Help Documentation

> **Language**: English | [中文](README.zh-CN.md)

This directory contains user-facing, administrator-facing, and operations-facing documentation. Start here if you are new to Cheers. For architecture background, use [Documentation Index](../INDEX.md) and the `docs/arch/` documents; when they conflict, help docs, README, and current code are authoritative.

## Read by Role

| Reader | Start Here | Covers |
|---|---|---|
| Anyone deploying | [Deployment Guide](deployment.md) | The three methods — from source, Docker Compose, Helm/Kubernetes — and when to use each |
| First-time deployer (Compose) | [Docker Compose Deployment Guide](docker-compose-deploy.md) | Single-host Compose stack: JWT keys, `.env`, core stack, OpenCode bot, TLS, ops |
| First-time deployer (legacy) | [Installation Guide](安装部署说明.md) | Older combined install notes (predates the Rust gateway; being revised) |
| Daily user | [User Guide](普通用户使用说明.md) | Entering channels, sending messages, mentioning Bots, uploading files |
| Frontend operator | [Frontend Operation Manual](<Cheers 前端操作手册.md>) | Main UI entry points, controls, and common operations |
| UI reviewer | [Interface Interaction Guide](<Cheers 界面交互指南.md>) | Layout, interaction rules, and usage recommendations |
| System administrator | [Admin Guide](系统管理说明书.md) | Workspaces, channels, members, Bots, Agent Bridge |
| Prompt operator | [Prompt Template Operations Guide](prompt-template-operations.md) | Prompt template variables, runtime priority, Bot binding, overrides, and troubleshooting |
| Agent provider author | [Agent Bridge Integration Guide](AgentBridge接入指南.md) | Registering Agent Bridge Bots and connecting local ACP-capable agents; OpenClaw links are legacy/deprecated |
| Local ACP agent (developer) | [Local Bot Setup Guide](本地Bot配置指南.md) | Host daemon: one TOML per bot, sidecar-file tokens, multi-bot management, full field reference, troubleshooting |
| Anyone asking "what is a Bot?" | [MCP Cheers: Bots vs. Users](mcp-bot-vs-user.md) | The MCP tool surface, the bot auth chain, and how a Bot is the same as / different from a regular user |
| Object storage operator | [RustFS Object Storage Guide](RustFS对象存储部署说明.md) | S3-compatible storage, bucket, and key setup |
| Troubleshooter | [Troubleshooting Q&A](技术排查Q&A.md) | Health checks, logs, database, Bot no-response, preview failures |

## Current Defaults

- Frontend: `http://localhost`
- Backend API: `http://localhost:8000`
- Main database and Context Store: PostgreSQL
- Redis, RustFS, and Gotenberg (office→PDF preview) are started by Docker Compose
- For public deployment, use `docker-compose.production.tls.yml` (Caddy + HTTPS + strict `CORS_ALLOWED_ORIGINS`) with `APP_DOMAIN` and `TLS_*` configured in `.env`.
- No built-in assistant: Cheers is external-agent-first — connect an ACP agent (OpenCode, Claude, Codex) and `@`-mention it in a channel.
- Chinese versions are available next to each document as `*.zh-CN.md`

## Related

- [User Manual](使用说明书.md)
- [Documentation Index](../INDEX.md)
- [Release Notes](../release_note/README.md)
