# Cheers Help Documentation

> **Language**: English | [中文](README.zh-CN.md)

This directory contains user-facing, administrator-facing, and operations-facing documentation. Start here if you are new to Cheers. For architecture background, use [Documentation Index](../INDEX.md) and the `docs/arch/` documents; when they conflict, help docs, README, and current code are authoritative.

## Read by Role

| Reader | Start Here | Covers |
|---|---|---|
| First-time deployer | [Installation Guide](安装部署说明.md) | Docker Compose, local development, migrations, seed data |
| Daily user | [User Guide](普通用户使用说明.md) | Entering channels, sending messages, mentioning Bots, uploading files |
| Frontend operator | [Frontend Operation Manual](<Cheers 前端操作手册.md>) | Main UI entry points, controls, and common operations |
| UI reviewer | [Interface Interaction Guide](<Cheers 界面交互指南.md>) | Layout, interaction rules, and usage recommendations |
| System administrator | [Admin Guide](系统管理说明书.md) | Workspaces, channels, members, Bots, Agent Bridge |
| Prompt operator | [Prompt Template Operations Guide](prompt-template-operations.md) | Prompt template variables, runtime priority, Bot binding, overrides, and troubleshooting |
| Agent provider author | [Agent Bridge Integration Guide](AgentBridge接入指南.md) | Registering Agent Bridge Bots and connecting local ACP-capable agents; OpenClaw links are legacy/deprecated |
| File preview operator | [kkFileView Preview Guide](kkFileView配置说明.md) | Complex Office/PDF preview setup and troubleshooting |
| Object storage operator | [RustFS Object Storage Guide](RustFS对象存储部署说明.md) | S3-compatible storage, bucket, and key setup |
| Troubleshooter | [Troubleshooting Q&A](技术排查Q&A.md) | Health checks, logs, database, Bot no-response, preview failures |

## Current Defaults

- Frontend: `http://localhost`
- Backend API: `http://localhost:8000`
- Main database and Context Store: PostgreSQL
- Redis, RustFS, and kkFileView are started by Docker Compose
- For public deployment, use `docker-compose.production.tls.yml` (Caddy + HTTPS + strict `CORS_ALLOWED_ORIGINS`) with `APP_DOMAIN` and `TLS_*` configured in `.env`.
- Built-in assistant username: `Coordinator`
- Chinese versions are available next to each document as `*.zh-CN.md`

## Related

- [User Manual](使用说明书.md)
- [Documentation Index](../INDEX.md)
- [Release Notes](../release_note/README.md)
