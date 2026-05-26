# AgentNexus Help Documentation

> **Language**: English | [中文](README.zh-CN.md)

This directory contains user-facing, administrator-facing, and operations-facing documentation. Start here if you are new to AgentNexus. Design documents under `docs/develop/` may include historical decisions; when they conflict with help docs, the help docs, README, and current code are authoritative.

## Read by Role

| Reader | Start Here | Covers |
|---|---|---|
| First-time deployer | [Installation Guide](安装部署说明.md) | Docker Compose, local development, migrations, seed data |
| Daily user | [User Guide](普通用户使用说明.md) | Entering channels, sending messages, mentioning Bots, uploading files |
| Frontend operator | [Frontend Operation Manual](<AgentNexus 前端操作手册.md>) | Main UI entry points, controls, and common operations |
| UI reviewer | [Interface Interaction Guide](<AgentNexus 界面交互指南.md>) | Layout, interaction rules, and usage recommendations |
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
- Built-in assistant username: `Coordinator`
- Chinese versions are available next to each document as `*.zh-CN.md`

## Related

- [User Manual](使用说明书.md)
- [Development Document Index](../develop/00-文档索引与LLM使用说明.md)
- [Open Source Release Checklist](../develop/开源发布检查清单.md)
