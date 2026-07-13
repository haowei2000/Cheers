# 架构文档

> **语言**：中文 | [English](README.md)

本目录存放网关架构、协议与集成设计文档。

## 从这开始

- [架构状态网页](index.html) — 由 `architecture-status.page.json` 通过 `make docs-pages` 生成
- [架构总览](ARCHITECTURE_OVERVIEW.md)
- [前端重做架构](FRONTEND_REBUILD_ARCHITECTURE.zh-CN.md) / [English](FRONTEND_REBUILD_ARCHITECTURE.md)
- [网关与传输协议](WIRE_PROTOCOL.md)
- [消息内容格式](MESSAGE_CONTENT_FORMAT.md)
- [任务投递流程](TASK_DELIVERY.md)
- [网关代码结构](GATEWAY_CODE_ARCH.md)

## ACP 与 Agent 接入

- [Agent Bridge 协议](AGENT_BRIDGE_PROTOCOL.md)
- [客户端 Daemon 架构](CLIENT_DAEMON_ARCHITECTURE.zh-CN.md) / [English](CLIENT_DAEMON_ARCHITECTURE.md)
- [ACP 连接模型](ACP_CONNECTION_MODEL.md)
- [Agent Bridge 与 ACP 兼容设计](AGENT_BRIDGE_ACP_COMPATIBILITY.md)
- [ACP 集成](ACP_INTEGRATION.md)
- [Agent Bridge 资源模型](AGENT_BRIDGE_RESOURCE.md)
- [内置 Agent 说明](BUILTIN_AGENT.md)

## 安全与运行语境

- [安全说明](SECURITY.md)
- [Bot 权限模型](BOT_PERMISSION.md)
- [Bot 配置分层](BOT_CONFIG_LAYERING.md)
- [文件存储](FILE_STORAGE.md)
- [环境与上下文](context-and-environment.md)
- [端到端加密说明](E2EE_NOTES.md)

## 规划文档（非当前状态参考）

工作中的工程规划——持续维护，但不代表系统当前的真实行为。当它们与 [架构总览](ARCHITECTURE_OVERVIEW.md) 或当前代码冲突时，以后者为准。

- 🛠 [工程执行路线图](ROADMAP.md) —— 逐里程碑的落地顺序、验收门、改造项 R1–R14
- 🛠 [数据流全景与改造计划](DATA_FLOW_AND_REFACTOR_PLAN.md) —— 代码现状快照 + 协议/代码差异表 + 改造项
- 🛠 [网关重构计划](REFACTOR_PLAN.md)
- [去中心化 Mesh](DECENTRALIZED_MESH.md) / [中文](DECENTRALIZED_MESH.zh-CN.md)
- [移动端客户端策略](MOBILE_CLIENT_STRATEGY.zh-CN.md) / [English](MOBILE_CLIENT_STRATEGY.md)

## 提案（草稿）

- 📝 [科研场景（research-lab）](RESEARCH_SCENARIO.md) —— 尚未实现的场景提案

## 返回入口

- [返回文档总入口](../README.md)
