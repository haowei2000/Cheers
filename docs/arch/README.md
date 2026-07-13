# Architecture Documentation

> **Language**: English | [中文](README.zh-CN.md)

This directory stores architecture, protocol, and gateway design docs.

## Start Here

- [Architecture Status Webpage](index.html) — generated from `architecture-status.page.json` by `make docs-pages`
- [Architecture Overview](ARCHITECTURE_OVERVIEW.md)
- [Frontend Rebuild Architecture](FRONTEND_REBUILD_ARCHITECTURE.md) / [中文](FRONTEND_REBUILD_ARCHITECTURE.zh-CN.md)
- [Gateway Protocol](WIRE_PROTOCOL.md)
- [Message Content Format](MESSAGE_CONTENT_FORMAT.md)
- [Message Pagination](MESSAGE_PAGINATION.md)
- [Task Delivery](TASK_DELIVERY.md)
- [Gateway Architecture](GATEWAY_CODE_ARCH.md)

## ACP and Agent Integration

- [Agent Bridge Protocol](AGENT_BRIDGE_PROTOCOL.md)
- [Client Daemon Architecture](CLIENT_DAEMON_ARCHITECTURE.md) / [中文](CLIENT_DAEMON_ARCHITECTURE.zh-CN.md)
- [ACP Connection Model](ACP_CONNECTION_MODEL.md)
- [ACP Capability Delegation](ACP_CAPABILITY_DELEGATION.md)
- [Agent Bridge and ACP Compatibility](AGENT_BRIDGE_ACP_COMPATIBILITY.md)
- [ACP Integration](ACP_INTEGRATION.md)
- [Agent Bridge Resources](AGENT_BRIDGE_RESOURCE.md)
- [MCP Agent Topology & Permission Boundary](MCP_AGENT_SECURITY.md)
- [Built-in Agent Notes](BUILTIN_AGENT.md)

## Security and Operations Context

- [Security Baseline](SECURITY.md)
- [Bot Permission Model](BOT_PERMISSION.md)
- [Bot Config Layering](BOT_CONFIG_LAYERING.md)
- [File Storage](FILE_STORAGE.md)
- [Context & Environment](context-and-environment.md)
- [E2EE Notes](E2EE_NOTES.md)

## Planning Documents (not current-state reference)

Working engineering plans — actively maintained, but not the source of truth for how the system behaves today. When these conflict with [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) or the current code, the latter win.

- 🛠 [Engineering Execution Roadmap](ROADMAP.md) — milestone build order, acceptance gates, refactor items R1–R14
- 🛠 [Data Flow & Refactor Plan](DATA_FLOW_AND_REFACTOR_PLAN.md) — code-current snapshot + protocol/code diff table + change items
- 🛠 [Gateway Refactor Plan](REFACTOR_PLAN.md)
- [Decentralized Mesh](DECENTRALIZED_MESH.md) / [中文](DECENTRALIZED_MESH.zh-CN.md)
- [Mobile Client Strategy](MOBILE_CLIENT_STRATEGY.md) / [中文](MOBILE_CLIENT_STRATEGY.zh-CN.md)

## Proposals (draft)

- 📝 [Research Scenario ("research-lab")](RESEARCH_SCENARIO.md) — not yet implemented; scenario proposal

## Back to Hub

- [docs/README](../README.md)
