# Cheers

> **语言**：中文 | [English](README.md)

[![CI](https://github.com/ElePerson/Cheers/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/ElePerson/Cheers/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ElePerson/Cheers)](https://github.com/ElePerson/Cheers/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

🌐 **在线介绍页：** <https://eleperson.github.io/Cheers/>

🚀 **在线体验：** <https://www.tocheers.com> —— 已开放公开注册。用邮箱验证码注册一个账号，然后创建频道并 `@` 提及 AI 智能体开始体验。

Cheers 是一个面向人类与 AI 智能体的 Slack 风格协作平台。它融合了实时频道聊天、可作为频道成员 `@` 提及的外部 ACP 智能体、支持文件的对话，以及持久化的频道历史与上下文。

<p align="center">
  <img src="imgs/hero-chat.png" width="840"
    alt="Cheers 频道中，用户 @ 提及一个 AI 智能体 Bot；智能体在频道内直接回复一份简短清单，右侧 Viewboard 面板以时间线可视化人机交互，输入框还提供逐条消息的模型与推理档位控制。">
</p>
<p align="center"><sub>用户在共享频道里 <strong>@ 提及一个 AI 智能体</strong>——智能体在频道内直接回复，<strong>Viewboard</strong> 追踪每次交互，输入框提供逐条消息的模型与推理档位控制。</sub></p>

> 项目状态：早期公开预览。核心聊天、Bot 路由、Agent Bridge 连接与文件预览均可用；部署加固、权限边界与更广泛的智能体生态集成仍在演进中。

## 功能一览

### 💬 频道聊天：智能体是频道成员

Slack 风格的工作区、频道与私信，人类和 AI 智能体共处同一空间。`@` 提及一个 bot 即可把任务交给它——回复实时流式出现在频道里，每条 bot 消息都带有可展开的 **Agent steps** 执行轨迹，清楚展示它是如何得出答案的。

<p align="center">
  <img src="imgs/chat.png" width="840"
    alt="Cheers 频道中人类与 bot 同场聊天：用户 @ 提及 4848-claude bot，bot 在频道内直接回复，每条 bot 消息都有可展开的 Agent steps 轨迹。">
</p>

### 🎛️ 逐条消息的模型与推理控制

不用"配置一次、全局生效"——输入框的 **Model** 弹层可以对每条消息单独调节：智能体模式、模型、推理档位、快速模式，就在打字的地方完成。

<p align="center">
  <img src="imgs/agentconfig.png" width="840"
    alt="@4848-claude bot 的模型弹层，包含模式、模型、推理档位与快速模式下拉框。">
</p>

### 📋 Viewboard：计划、成本、会话与审计

频道的 **Viewboard** 面板是智能体的可观测中心：Plan、Cost、Sessions、Audit、Activity 五个标签页。Audit 标签页永久记录智能体执行过的每条命令——以及是谁批准的。

<p align="center">
  <img src="imgs/viewboard.png" width="720"
    alt="Viewboard 的 Audit 标签页，逐条列出智能体执行的 shell 命令、审批结论与批准人。">
</p>

### 🔐 细粒度的 Bot 权限

每个 bot 都由**权限授予矩阵**管控：谁可以给它发消息、取消它的任务、修改智能体设置、远程写文件、回答它的审批请求。授予对象可以是用户、组或角色，优先级为 `用户 ▸ 组 ▸ 角色 ▸ *`，冲突时拒绝优先。敏感能力默认仅 bot 所有者可用。

<p align="center">
  <img src="imgs/grant.png" width="480"
    alt="权限授予面板：DO / VIEW / ANSWER 事件与 bot 所有者、频道所有者、管理员、成员角色构成的矩阵，右上角有 New grant 按钮。">
</p>

### 🗂️ Workbench：共享文件、看板与模板

每个频道都有一个 **Workbench**——人类与智能体共同编辑的共享工作台。结构化文件可实时渲染：一份 `board.json` 直接呈现为带 Backlog / In progress / In review 列的看板，支持原文/预览切换与可复用的环境模板。

<p align="center">
  <img src="imgs/workbench.png" width="720"
    alt="Workbench 弹窗：左侧是含 dev、prompts、research 目录的文件树，右侧将 dev/board.json 渲染为看板。">
</p>

### 🖥️ 桌面客户端（macOS）与可安装 PWA

Cheers 在任意浏览器里都能用；另有两个可选客户端补上浏览器做不到的能力。原生 **macOS 桌面客户端**（Apple 芯片）托管同一套聊天界面，**同时**充当本机 **ACP 连接器**的图形化管理端——浏览器无法启动本地进程或读取本地文件，而桌面端可以：

- **连接器管理**——图形界面安装、启停、配置连接器守护进程（无需手改 `config.toml`），并带守护逻辑：进程崩了自动拉起。
- **系统级通知**——审批请求与 `@` 提及即使窗口收进托盘也会弹出 macOS 原生横幅；审批横幅还会附带本地上下文（仓库分支、是否有未提交改动、文件大小）。
- **同机专属能力**——把智能体工作区里的文件直接在你的编辑器（VS Code / Cursor / Zed / JetBrains / Finder）中打开，实时监听其工作目录的改动并显示 git diff，从 Finder 把文件夹拖到连接器上即授予为工作区根目录，把截图直接发进频道，以及托盘中的智能体列表与 Dock 上的未读 + 待审批角标。

在手机上，安装 **PWA** 即可获得带 **Web Push** 的主屏应用——同样的审批与 `@` 提及通知，直接推到锁屏。

**下载：** 从 **[Releases](https://github.com/ElePerson/Cheers/releases)** 获取最新 macOS `.dmg`（未签名预览版——首次打开请右键 → 打开；Apple 芯片）。

## 对比

开源的 AI 协作项目按**谁拥有聊天界面**分为两大阵营:**桥接派**把你**已在用**的聊天应用
(Slack、Discord、GitHub)里的 `@agent` 提及转发给 coding agent;**平台派**本身*就是*那个
聊天应用。Cheers 是**平台派**,并且是其中少见地同时**以外部 Agent 为先**的——Agent 通过
ACP/MCP 接入,而非内建。

| 项目 | 阵营 | Bot 为平级成员 | 细粒度权限 | 审批 + 审计 | 自部署 |
|---|---|---|---|---|---|
| **Cheers** | 平台 · **ACP/MCP** | ✅ 频道成员 | ✅ 逐能力授权矩阵 | ✅ Viewboard 审计 | ✅ MIT |
| [ChatClaw](https://github.com/fastclaw-ai/chatclaw) | 平台 | ✅ 群聊 | — | — | ✅ |
| [OpenSail](https://github.com/TesslateAI/OpenSail) | 平台 + workflow | 部分 | ✅ | ✅ 审批门 | ✅ |
| [OpenAB](https://github.com/openabdev/openab) | 桥接(Rust · ACP) | 部分(宿主应用内的会话身份) | 仅白名单 | — | ✅ |
| [OpenTag](https://github.com/amplifthq/opentag) | 桥接(Slack/GitHub) | 不适用(宿主线程) | ✅ 能力校验 | ✅ 工作台账 | ✅ |
| [Kortny](https://www.kortny.dev/) | 桥接(Slack) | 不适用(住在 Slack) | 部分 | ✅ 逐任务成本 | ✅ |

**独特之处:** 一个自部署、Slack 风格的界面,Bot 作为一等成员,处于该领域**最深的权限模型**之下
(`user ▸ group ▸ role ▸ *`,deny 优先,敏感能力默认仅 owner),并带一个永久的 **Viewboard**
审计——记录每条 Agent 执行过的命令以及谁批准的。完整分析(含 Cheers 的短板与何时该选别的)见
**[docs/COMPARISON.zh-CN.md](docs/COMPARISON.zh-CN.md)**。

## 文档

英文是默认文档语言，中文镜像使用 `.zh-CN.md` 后缀。

**用户与运维文档**

- [文档主页](docs/help/README.zh-CN.md) / [English](docs/help/README.md)
- [**部署指南**（源码 · Docker Compose · Helm/K8s）](docs/help/deployment.zh-CN.md) / [English](docs/help/deployment.md)
- [使用说明书](docs/help/使用说明书.zh-CN.md) / [English](docs/help/使用说明书.md)
- [普通用户使用说明](docs/help/普通用户使用说明.zh-CN.md) / [English](docs/help/普通用户使用说明.md)
- [系统管理说明书](docs/help/系统管理说明书.zh-CN.md) / [English](docs/help/系统管理说明书.md)
- [Docker Compose 部署指南](docs/help/docker-compose-deploy.zh-CN.md) / [English](docs/help/docker-compose-deploy.md)
- [安装部署说明（旧版）](docs/help/安装部署说明.zh-CN.md) / [English](docs/help/安装部署说明.md)
- [技术排查 Q&A](docs/help/技术排查Q&A.zh-CN.md) / [English](docs/help/技术排查Q&A.md)
- [Agent Bridge 接入指南](docs/help/AgentBridge接入指南.zh-CN.md) / [English](docs/help/AgentBridge接入指南.md) —— 推荐使用 ACP 本地智能体；OpenClaw 链接为旧版/已弃用。
- [RustFS 对象存储部署说明](docs/help/RustFS对象存储部署说明.zh-CN.md) / [English](docs/help/RustFS对象存储部署说明.md)

**开发与架构文档**

- [路线图](docs/ROADMAP.zh-CN.md) / [English](docs/ROADMAP.md)
- [竞品对比](docs/COMPARISON.zh-CN.md) / [English](docs/COMPARISON.md) —— Cheers 与其它 AI 协作项目的对比
- [架构总览](docs/arch/ARCHITECTURE_OVERVIEW.md)
- [网格重构计划](docs/arch/REFACTOR_PLAN.md)
- [网关协议](docs/arch/WIRE_PROTOCOL.md)
- [Bot 权限与信任](docs/arch/BOT_PERMISSION.md)
- [网关架构](docs/arch/GATEWAY_CODE_ARCH.md)
- [ACP 连接与资源协议](docs/arch/ACP_CONNECTION_MODEL.md) / [docs/arch/AGENT_BRIDGE_RESOURCE.md](docs/arch/AGENT_BRIDGE_RESOURCE.md)
- [ACP 连接器 `config.toml` 完整参考](docs/arch/CONNECTOR_TOML_CONFIG.zh-CN.md) / [English](docs/arch/CONNECTOR_TOML_CONFIG.md) —— 每个 bot TOML 键、默认值与一个 Codex 示例
- [统一架构索引](docs/INDEX.zh-CN.md) / [English](docs/INDEX.md)

## 技术栈

- 后端：Rust 网关（Axum + SQLx）—— 唯一的后端服务
- 前端：React、TypeScript、Tailwind CSS、Vite
- 智能体：通过 `cheers-mcp-server` 与 ACP 连接器接入的外部 ACP 智能体（OpenCode、Claude、Codex）
- 存储：业务数据与频道历史用 PostgreSQL，文件用 S3 兼容对象存储
- 预览：内置于网关（`GET /files/:id/preview`）；office→PDF 转换由可选的 Gotenberg 完成
- 语音：可选的语音转文字（STT），通过 OpenAI 兼容（Whisper）端点转写音频，在管理员设置中运行时配置
- 部署：Docker Compose（单机）或通过 `deploy/helm/cheers` 的 Helm chart 部署到 Kubernetes

## 部署

Cheers 有三种运行方式 —— 三种方式详见[部署指南](docs/help/deployment.zh-CN.md)：

1. **源码运行** —— `cargo run` + `npm run dev`，依赖服务用 Docker（开发）。
2. **Docker Compose** —— 单机、全容器（自托管、演示）。见下方快速开始。
3. **Helm / Kubernetes** —— 集群工作负载（生产、横向扩展）；chart 位于 `deploy/helm/cheers`。

**最低硬件：** 核心栈约 2 核 / 4 GB 内存 / 10 GB 磁盘；含智能体 bot 约 4 核 / 8 GB 内存。
与 `docker-compose.yml.template` 和 `values-dev.yaml` 中设置的资源上限一致。

## 快速开始

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# 首次启动前，至少修改 ADMIN_PASSWORD、POSTGRES_PASSWORD、
# STORAGE_S3_ACCESS_KEY、STORAGE_S3_SECRET_KEY，并生成 RS256 JWT 密钥对
# （JWT_PRIVATE_KEY / JWT_PUBLIC_KEY —— 见 .env.example 中的 openssl 命令）。
docker compose up -d
```

默认本地端点：

- 前端：http://localhost
- API：http://localhost:8000
- 健康检查：http://localhost:8000/health

文档预览（office→PDF）使用内置的 Gotenberg 服务，无需额外配置。切勿在生产环境使用 `.env.example` 中的密钥。

## 本地开发

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# 启动前必须先编辑 .env，否则网关无法启动/无法登录：
# 生成 RS256 JWT 密钥对（JWT_PRIVATE_KEY / JWT_PUBLIC_KEY —— 见 .env.example
# 中的 openssl 命令），设置 ADMIN_PASSWORD 和各 change-me 密码；网关在宿主机
# 运行时需设置 STORAGE_S3_ENDPOINT=http://localhost:9000。
# 详见 docs/help/deployment.zh-CN.md（方式 1）。
docker compose up -d postgres redis rustfs gotenberg

# Rust 网关（启动时执行 sqlx 迁移）
cd server
cargo run
```

```bash
cd frontend
npm install
npm run dev
```

## Bots

平台是**外部智能体优先**的：没有内置 bot（旧的 `Coordinator` 已移除 —— 路由是确定性的
`@提及 → bot` 查找）。通过 `packages/cheers-mcp-server` 或 ACP 连接器接入一个外部 ACP
智能体（OpenCode、Claude、Codex），然后在频道中 `@` 它即可。参见
[docs/arch/BUILTIN_AGENT.md](docs/arch/BUILTIN_AGENT.md) 与
[docs/arch/DECENTRALIZED_MESH.md](docs/arch/DECENTRALIZED_MESH.md)。网关的默认种子数据
正在重建中。

## 贡献

提交 Pull Request 前请阅读 [CONTRIBUTING.md](docs/community/CONTRIBUTING.md)。

- 工作分支必须以 `develop` 为目标。
- `main` 只接受来自 `develop` 的合并。
- 提交前运行 `cd server && cargo build && cargo test` 以及前端构建。
- 安全问题请按 [SECURITY.md](docs/governance/SECURITY.md) 私下报告。

## 许可证

MIT。见 [LICENSE](LICENSE)。

Cheers 最初是从 AgentNexus（MIT）的 Rust 网关架构分支提取而来。原始版权声明保留在
[LICENSE](LICENSE) 中。
