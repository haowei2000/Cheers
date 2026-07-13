# Cheers 架构重构总览

> 版本：v0.2
> 分支：`break/rust-gateway-arch`
> 本文是架构重构的**索引入口**。细则见：
> - [DATA_FLOW_AND_REFACTOR_PLAN.md](./DATA_FLOW_AND_REFACTOR_PLAN.md) —— **数据流全景与改造计划（代码现状快照）**：三面协议帧表、八条端到端流程、系统不变量、协议-代码差异表、改造项 R1–R13
> - [ROADMAP.md](./ROADMAP.md) —— **工程执行路线图**：里程碑 M0–M4、依赖与验收门、schema-超前-code 缺口、功能裁剪表（把 R1–R13 与 Phase 计划合成可落地序列）
> - [REFACTOR_PLAN.md](./REFACTOR_PLAN.md) —— 模块迁移、目录结构、阶段计划、风险
> - [WIRE_PROTOCOL.md](./WIRE_PROTOCOL.md) —— 实时线协议 v1（浏览器 ↔ Rust Backend）
> - [TASK_DELIVERY.md](./TASK_DELIVERY.md) —— Agent 任务投递契约 v2（Backend → Agent Bridge WS → Agent Service）
> - [AGENT_BRIDGE_RESOURCE.md](./AGENT_BRIDGE_RESOURCE.md) —— 资源访问协议 v1（Bot 通过协议访问平台资源）
> - [BOT_PERMISSION.md](./BOT_PERMISSION.md) —— Bot 权限模型 v1（基于 ACP RBAC）
> - [BOT_CONFIG_LAYERING.md](./BOT_CONFIG_LAYERING.md) —— Bot 配置分级设计
> - [ACP_INTEGRATION.md](./ACP_INTEGRATION.md) —— ACP 接入设计（内置/外置 bot 统一协议）
> - [ACP_CONNECTION_MODEL.md](./ACP_CONNECTION_MODEL.md) —— ACP 连接模型（单连接多 session、重连重放）
> - [SECURITY.md](./SECURITY.md) —— 安全架构（传输安全、设备认证；bot 级 ACP 端点 E2EE 为可选）
> - [FILE_STORAGE.md](./FILE_STORAGE.md) —— 文件存储与权限（S3 存储、scope link、Agent 文件交互）
> - [E2EE_NOTES.md](./E2EE_NOTES.md) —— 端到端加密可行性分析（搁置/未来计划）
> - [context-and-environment.md](./context-and-environment.md) —— 上下文与 Environment 架构（会话/记忆/Environment 三分、记忆即文件系统、Environment 即插件；v1 声明式渲染，预留代码插件升级路径）
> - [DECENTRALIZED_MESH.md](./DECENTRALIZED_MESH.md) —— 去中心化 Bot 网格（去调度层、channel_seq 事件时钟、两类资源一致性、频道操作日志、Bot@Bot 任务链与取消、可选预算）
> - [BUILTIN_AGENT.md](./BUILTIN_AGENT.md) —— 内置 Agent：删光所有内置 bot 类，改为**一份通用 runtime**（代码只写一次、无 per-bot 分支）；身份是**数据**（seed 的 bot_account，≥1 个保住网格多 peer）；行为是 Environment 模板；确定性逻辑下沉成 tool 而非 bot
> - [MESSAGE_CONTENT_FORMAT.md](./MESSAGE_CONTENT_FORMAT.md) —— 消息正文格式：text + 扁平 token（`<@bot:id>`/`<@user:id>`/`<#file:id>`/`<#chan:id>`）；操作永不进正文（typed resource_req）；不上 XML/AST；富内容走 content_data；token=渲染位置、message_mentions 表=查询，互补

---

> ⚠️ **本文部分内容描述的是已被取代的旧模型（SUPERSEDED）。** 本文中出现的死概念包括：
> **Grant / trust_level 细粒度授权**（第四节资源写契约、第六节权限模型）与 **Python `features/memory/` 分层记忆**（第三节职责切分）。
> 现行模型一句话：**无独立 memory 概念；文件是唯一基质；Context = 插件策展的文件；agent 一律 pull；授权唯 channel-role**。
> 权威定义见 [context-and-environment.md](./context-and-environment.md) 顶部的「⚠️ CURRENT MODEL (2026-06-23)」声明。下文相关断言已就地加 ⚠️ 注，正文保留作历史记录。

---

## 一、为什么要拆

现有 Python 单体把**两类性质完全不同的负载**塞进同一个 asyncio 事件循环：

| 负载 | 性质 | 诉求 |
|------|------|------|
| 实时连接层 | I/O bound | 高并发长连接、低延迟、稳定广播 |
| Agent 编排层 | CPU / LLM bound | AI 生态、快速迭代、独立扩容 |

两者争抢事件循环 → token 流式输出抖动；且无法按各自负载特性独立扩容。
**结论**：Rust 做后端（I/O 密集），Python 做 Agent（LLM 生态），通过 Agent Bridge 协议解耦。

---

## 二、目标拓扑

> **外接优先，无内置 runtime。** 平台侧只有 Rust Backend，无 Python 服务。
> Intelligence 完全来自用户自己连接的外部 ACP Agent。见 [BUILTIN_AGENT.md](./BUILTIN_AGENT.md)。

```
Browser / Mobile
  │ WS + REST（同一端口 :8000）
  ▼
┌──────────────────────────────────────────────────────────┐
│                    Rust Backend                           │
│  ├─ REST API（全量 CRUD）                                  │
│  ├─ WS Gateway（浏览器侧连接管理 + fan-out）                 │
│  ├─ Agent Bridge（bot 连接管理 + 任务派发 + delta 转发）      │
│  ├─ Resource API（bot 通过协议访问平台资源）                  │
│  ├─ 权限引擎（ACP RBAC）                                   │
│  └─ DB / S3 / SMTP / JWT                                 │
└──────────┬───────────────────────────────────────────────┘
           │ Agent Bridge WS (control + data)
    ┌──────┴──────────────────────────────────┐
    ▼                                         ▼
┌───────────────────────┐     ┌───────────────────────────────┐
│  外置 ACP Agent        │     │  cheers-mcp-server (stdio) │
│  OpenCode / Codex /   │     │  MCP ↔ Agent Bridge 桥         │
│  任何 ACP connector   │     │  (Claude / Codex / Cursor 等)   │
└───────────────────────┘     └───────────────────────────────┘
```

**关键决策**：
- **没有独立的 Gateway**：Gateway + REST API 合并为一个 Rust Backend
- **没有 NATS**：WS 直连，不需要消息总线（单实例前提，见下文部署模型）
- **没有 Python REST API**：所有 REST 端点迁移到 Rust
- **没有内置 Python Agent Service**：平台不提供内置 runtime；bot 全部来自外部连接
- **`cheers-mcp-server`** 是 MCP 能力 agent 接入平台的标准桥，非独立服务

> **外置 ACP bot 的本地形态**：外置 bot 通过本地 **Daemon（事件网关）** 接入——Daemon 负责本地事件过滤、设备认证、本地文件白名单（见 [BOT_PERMISSION](./BOT_PERMISSION.md) / [SECURITY](./SECURITY.md)）。

```
（外置 agent 完整接入形态）
┌─ 用户本地 ──────────────────────────┐     ┌─ 平台云端 ──────────────┐
│  Claude / Codex / OpenCode          │     │  Rust Backend（单实例）  │
│    │ MCP stdio                       │     │  transport/domain/       │
│    ▼                                │     │  realtime/agent_bridge   │
│  cheers-mcp-server              │     │                          │
│    │ 或直接 ACP connector + Daemon   │─WSS▶│                          │
└────────────────────────────────────┘     └──────────────────────────┘
```

---

## 二之二、部署模型（本期定调：单实例）

| 维度 | 本期决策 | 说明 |
|------|---------|------|
| 实例数 | **单实例 Rust Backend** | 进程内 fan-out + 进程内 bot 连接管理成立的前提 |
| 取舍 | 用 HA / 水平扩展换「无 NATS、无跨实例」 | 删 NATS 同时删掉了实时层的横向扩容机制 |
| 故障域 | 单进程崩溃 = 全平台实时中断；靠进程级重启 + 客户端重连 + REST 拉全量恢复 | 接受此 SLA 上限；如需 HA 见下 |
| 数据持久性 | 不受单实例影响（PG/S3 是状态真相） | 重启后 event_log 重放对齐 |
| **预留接口** | `Fanout` 与 `BotLocator` 抽象为可替换 **trait** | 单实例=进程内；多实例=接 Redis/NATS。**协议层不变**（见 [WIRE_PROTOCOL §8.2](./WIRE_PROTOCOL.md)、[ACP_CONNECTION_MODEL §2.1](./ACP_CONNECTION_MODEL.md)） |

> **多实例为未来计划**：一旦跑 ≥2 实例，「连接黏性 / 跨实例 fan-out」回归，通过上述 trait 接入消息总线解决，届时不必改协议、不必改前端。

> **灰度方案（Phase 1）**：新 Rust Backend 与旧 Python 单体并存期间，按**端点**而非流量百分比切分更安全——先把无状态读端点（如 `GET /channels`）切到 Rust，写端点与 WS 后切，避免两个进程对同一 PG 行的写竞态。前端 WS 连接目标整体切换（WS 难以半切）。新旧并存期务必只让**一方**负责 bot 派发与占位 upsert，防双写。

---

## 三、职责切分

> ⚠️ **本节的「Python / Rust 双层切分」已被 external-agent-first 取代（见第二节与
> [BUILTIN_AGENT.md](./BUILTIN_AGENT.md)）。** 现状：平台侧**只有** `server/` 下的 Rust
> 网关这一个后端；**没有独立的 Python Agent Service**——智能全部来自用户自连的外部 ACP
> Agent。下表保留原始「拆分」设想作历史记录，`Python Agent Service` 行整行已废弃。

| 层 | 语言 | 拿走的现有模块 |
|----|------|--------------|
| **Rust Backend**（现为唯一后端，代码在 `server/src`） | Rust | `api/v1/*` + `services/*` + `features/agent_bridge/` + `db/` |
| **Python Agent Service** ⚠️ 整行已废弃 —— 该层从未落地，external-agent-first 下平台不提供内置 runtime | Python | `features/bot_runtime/` + `features/memory/`（`memory_entries` 分层记忆已被 `context_files` 文件树取代，见 CURRENT MODEL）+ `tools/` |
| **共用** | — | PostgreSQL + **sqlx**（迁移在 `server/migrations/`，网关启动时自动运行）；JWT（RS256）；S3 |

---

## 四、协议层硬契约（已锁定）

| 维度 | 决策 | 出处 |
|------|------|------|
| 浏览器传输 | WS-only，SSE 退场 | WIRE §0 |
| 浏览器连接 | 单连接复用，`subscribe/unsubscribe` 切频道 | WIRE §1 |
| 浏览器鉴权 | 首帧 `{type:auth,token}` + RS256 | WIRE §6.1 |
| 浏览器顺序 | 流式帧带 `seq`，客户端去重排序 | WIRE §5 |
| bot 接入 | Agent Bridge WS（control + data） | ACP_INTEGRATION |
| bot 资源访问（读） | `resource_req/res`，仅需频道成员 | AGENT_BRIDGE_RESOURCE §3.4 |
| bot 资源访问（写） | `resource_req/res`，频道成员 **+ Grant**（按 trust_level）<br>⚠️ 历史设计，已废弃 — Grant/trust_level 细粒度授权在 R13 退场，channel-role 是唯一授权事实源，见 CURRENT MODEL | AGENT_BRIDGE_RESOURCE §3.4 / BOT_PERMISSION §5.3 |
| bot 权限 | ACP RBAC（Grant + 覆盖 + 审批）；trust_level 枚举 `system>trusted>standard>untrusted`<br>⚠️ 历史设计，已废弃 — 授权唯 channel-role，见 CURRENT MODEL | BOT_PERMISSION |
| **写后投递（Write-Before-Deliver）** | **终态帧必须先落 PG，再 fan-out**；流式帧（delta）直接 fan-out 不落库，靠 `message_done` 全量自愈 | WIRE §4.2 |
| 实时传输模型 | 单实例进程内 fan-out（无 NATS）；fan-out/locator 抽象为 trait | WIRE §8 / 部署模型 |
| E2EE | **默认关闭；按 bot 配置可选开启。当前仅“配置+握手”入链，数据内容加密未全面落地** | SECURITY / E2EE_NOTES / BOT_CONFIG_LAYERING |
| bot 任务投递 | Backend → control WS task 帧 → Agent Service | TASK_DELIVERY v2 |
| bot 输出回传 | data WS delta/done → Backend → 浏览器 fan-out | ACP_CONNECTION_MODEL |
| 内置 vs 外置 | **零区别**，同一套协议 | ACP_INTEGRATION |

---

## 五、重建阶段

> **Clean rebuild，无 Phase 0 渐进。** 见 [REFACTOR_PLAN §六](./REFACTOR_PLAN.md) 和 [BUILTIN_AGENT.md](./BUILTIN_AGENT.md)。

> ⚠️ **下表 Phase 1 的「新 Python Agent Service 通用 runtime 从零写」已作废**（[ROADMAP.md](./ROADMAP.md) 已标注此矛盾）。现行 external-agent-first 路线**不写任何平台侧 Python runtime**：Phase 1 只保留「Rust 网关补齐网格 schema + 路由重写、旧 Python 单体整体下线」，智能由外部 ACP Agent 提供；后续行中的 “Agent Service” 均指**外部** Agent，而非平台内置服务。

| Phase | 目标 | 关键动作 |
|-------|------|---------|
| **1** | Rust Backend（唯一后端） | Rust Backend（已启动）补齐网格 schema + 路由重写；旧 Python 单体整体下线（~~新 Python Agent Service 通用 runtime 从零写~~ 已作废，见上注） |
| **2** | 全量 REST + 网格能力 | 补齐 REST 端点；DM resource（topic 已砍 2026-06-24）；Lens 渲染 v1 |
| **3** | 优化 | Agent Service 扩容（多身份分片）；OpenTelemetry；权限审计日志 |

---

## 六、当前未决 / 需留意

| # | 事项 | 状态 |
|---|------|------|
| 1 | **resource 协议** — bot 通过协议访问平台资源 | ✅ 已定稿 → AGENT_BRIDGE_RESOURCE.md |
| 2 | **ACP 权限模型** — Grant + 覆盖 + 审批；资源写走 Grant ⚠️ 历史设计，已废弃 — Grant 授权 R13 退场，授权唯 channel-role，见 CURRENT MODEL | ✅ 已定稿 → BOT_PERMISSION.md |
| 3 | **任务投递** — Backend 直接通过 Agent Bridge WS 派发 | ✅ 已定稿 → TASK_DELIVERY v2 |
| 4 | **E2EE 范围** — 默认仅层级 A；ACP 端点 E2EE 改为 bot 可选能力（`binding_config.acp_security`），当前先落地控制面（握手元数据） | ✅ 已定调 → SECURITY / E2EE_NOTES / BOT_CONFIG_LAYERING |
| 5 | **部署模型** — 单实例 + fan-out/locator trait 预留 | ✅ 已定调 → 部署模型节 |
| 6 | **trust_level 枚举** — `system>trusted>standard>untrusted` ⚠️ 历史设计，已废弃 — trust_level 细粒度授权退场，授权唯 channel-role，见 CURRENT MODEL | ✅ 已统一 → BOT_PERMISSION §7 |
| 7 | **token 里无 workspace_id** — 工作区级 / 全局限流需另想办法（resource 限流目前只有 per-bot） | 🔶 留意 |
| 8 | **Rust Backend 重写范围** — 90 个 REST 端点 + 27 张表 | ⚠️ Phase 1 核心挑战 |
| 9 | **bot 权限的 channel 覆盖 UI** — 前端需要新的设置界面 | ⚠️ Phase 2 |
| 10 | **resource 协议缺 DM scope 与 search 资源** — 当前只有 `channel.*`，RAG/检索无对应 resource（topic 已砍 2026-06-24，不再列入） | 🔶 待补契约 |
| 11 | **presence 来源** — `channel.context.online_users` 在单进程外如何聚合 | 🔶 多实例时再定 |

---

## 七、明确不在本次范围

- 前端框架迁移（继续 React + Vite）
- 数据库选型（继续 PostgreSQL；迁移工具为 sqlx，见 `server/migrations/`）
- 多租户隔离模型变更（现有 workspace 模型不变）
- Vector DB 选型（Phase 3 再评估）
