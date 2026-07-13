# Cheers 项目概览

> **语言**：中文 | [English](PROJECT_OVERVIEW.md)

Cheers 是一个 Slack 风格的人机协作平台，人类与 AI Agent 共享同一批频道：把 AI
Agent 作为成员拉进频道，`@` 提及它来交派任务，它的回复会实时流式地回到对话中，与
其他成员的消息并列呈现。

**核心能力**

- **Agent 即频道成员** —— 实时频道聊天与私信（DM），人类与外部 AI Agent 在同一空间
  协作；每条 Bot 回复都带有可展开的 *Agent steps* 执行轨迹。
- **外接 Agent 优先（external-agent-first）** —— 平台不内置 LLM 运行时。通过标准桥接
  （`packages/cheers-mcp-server` 或 `packages/cheers-acp-connector-rs`）接入具备 ACP
  能力的 Agent（OpenCode、Claude、Codex），再 `@` 提及即可。Agent 自持上下文，平台
  不接管 Agent 运行时。
- **逐条消息的模型与推理控制** —— 输入框可对每一条消息单独设置：Agent 模式、模型、
  推理强度（reasoning effort）与快速模式。
- **文件即对话** —— Office 文档（docx / pdf / xlsx）转换为内联预览；每个频道的上下文
  文件（`context_files`，经 `fs.*` 资源动词暴露给 Agent）作为共享、持久的工作区状态。
- **工作台 / Viewboard 面板** —— 由插件托管的侧边面板，用于策展频道文件、可视化人机
  交互。
- **历史与上下文持久化** —— 频道消息与上下文在刷新后依然存在；Agent 通过 `pull`
  获取共享文件，而非由平台把记忆 push 给它。

**技术栈**

- **后端**：单一 Rust 网关（`server/`）—— 唯一的后端服务。
- **前端**：React + Vite + TypeScript + Tailwind（`frontend/`）。
- **存储**：PostgreSQL（消息、上下文）+ RustFS（兼容 S3 的对象存储）；Redis 可选。
- **本地运行（首选方式）**：通过 `deploy/helm/cheers` 的 Helm chart 在 kind 集群上运行
  （网关 + 前端 + postgres + rustfs）。Docker Compose 作为遗留的回退方案保留。

完整拓扑与硬契约见 [架构总览](arch/ARCHITECTURE_OVERVIEW.md)，部署与使用指南见
[帮助文档](help/README.zh-CN.md)。
