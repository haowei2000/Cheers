# AgentNexus

> **语言**：中文 | [English](README.md)

[![CI](https://github.com/Grant-Huang/AgentNexus/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Grant-Huang/AgentNexus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

AgentNexus 是一个面向人类与 AI Agent 的 Slack 风格协作平台。它集成了实时频道聊天、Agent Bridge 接入、HTTP LLM Bot、文件感知对话以及四层频道记忆模型。

> 项目状态：早期公开预览阶段。核心聊天、Bot 路由、Agent Bridge 连接、文件预览和频道记忆流程已可用。部署加固、权限边界和更广泛的 Agent 生态集成仍在持续演进中。

## 文档

中文文档使用 `.zh-CN.md` 后缀。英文为默认文档语言。

**用户与运维文档**

- [文档首页](docs/help/README.zh-CN.md)
- [使用说明书](docs/help/使用说明书.zh-CN.md)
- [普通用户使用说明](docs/help/普通用户使用说明.zh-CN.md)
- [系统管理说明书](docs/help/系统管理说明书.zh-CN.md)
- [安装部署说明](docs/help/安装部署说明.zh-CN.md)
- [技术排查 Q&A](docs/help/技术排查Q&A.zh-CN.md)
- [Agent Bridge 接入指南](docs/help/AgentBridge接入指南.zh-CN.md) — 推荐使用 ACP 本地 Agent 接入；OpenClaw 链接为旧版/已弃用。
- [RustFS 对象存储部署说明](docs/help/RustFS对象存储部署说明.zh-CN.md)
- [kkFileView 配置说明](docs/help/kkFileView配置说明.zh-CN.md)

**开发与架构文档**

- [路线图](docs/ROADMAP.zh-CN.md)
- [架构总览](docs/arch/ARCHITECTURE_OVERVIEW.md)
- [Mesh 重构计划](docs/arch/REFACTOR_PLAN.md)
- [网关协议](docs/arch/WIRE_PROTOCOL.md)
- [Bot 权限与信任](docs/arch/BOT_PERMISSION.md)
- [网关架构](docs/arch/GATEWAY_CODE_ARCH.md)
- [ACP 连接与资源协议](docs/arch/ACP_CONNECTION_MODEL.md) / [Agent Bridge 资源](docs/arch/AGENT_BRIDGE_RESOURCE.md)
- [统一架构索引](docs/INDEX.zh-CN.md)

## 技术栈

- 后端：Rust + Axum + SQLx（网关）及 React 前端
- 前端：React、TypeScript、Tailwind CSS、Vite
- Agent 运行时：通过 `agentnexus-mcp-server` 和 ACP 连接器接入外部 ACP Agent
- 存储：PostgreSQL 用于业务数据和记忆，S3 兼容对象存储用于文件，可选 kkFileView 用于复杂文档预览
- 部署：Docker Compose

## 快速开始

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# 首次启动前，请至少修改 ADMIN_PASSWORD、JWT_SECRET_KEY、
# POSTGRES_PASSWORD、RUSTFS_ACCESS_KEY 和 RUSTFS_SECRET_KEY。
docker compose up -d
```

默认本地端点：

- 前端：http://localhost
- API：http://localhost:8000
- 健康检查：http://localhost:8000/health

如果启用了文档预览，请确保 `PUBLIC_BASE_URL` 可被 kkFileView 容器访问。切勿在生产环境中使用 `.env.example` 中的密钥。

## 本地开发

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
docker compose up -d postgres redis rustfs kkfileview

# Rust 网关（启动时自动运行 sqlx 迁移）
cd server
cargo run
```

```bash
cd frontend
npm install
npm run dev
```

## Bot

本平台采用 **外部 Agent 优先** 架构：没有内置 Bot（旧版 `Coordinator` 已移除 — 路由为确定性的 `@mention → bot` 查找）。通过 `packages/agentnexus-mcp-server` 或 ACP 连接器接入外部 ACP Agent（OpenCode、Claude、Codex），然后在频道中 `@` 它即可。详见 [内置 Agent](docs/arch/BUILTIN_AGENT.md) 和 [去中心化 Mesh](docs/arch/DECENTRALIZED_MESH.md)。网关的默认种子数据正在重建中。

## 贡献

提交 Pull Request 前请先阅读 [CONTRIBUTING.md](docs/community/CONTRIBUTING.md)。

- 工作分支须指向 `develop`。
- `main` 仅接受从 `develop` 合并。
- 提交前请运行 `cd server && cargo build && cargo test` 以及前端构建。
- 安全问题请按照 [SECURITY.md](docs/governance/SECURITY.md) 私下报告。

## 许可证

MIT。详见 [LICENSE](LICENSE)。
