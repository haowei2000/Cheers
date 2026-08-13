---
title: Cheers ACP 官方 SDK 迁移与 Elicitation 路由
date: 2026-08-13
tags:
  - Cheers
  - ACP
  - Connector
  - Elicitation
  - Security
status: implemented
---

# Cheers ACP 官方 SDK 迁移与 Elicitation 路由

## 本次结果

Rust ACP Connector 已升级到 `agent-client-protocol 2.0.0`，并以官方 runtime 作为 `0.1.37` 默认 transport。Cheers 仍只协商稳定 ACP wire v1，继续使用本地 stdio agent，不引入远程 ACP HTTP/SSE/WebSocket、conductor、polyfill 或 MCP-over-ACP。

本轮同时打通 ACP v1 Elicitation：Connector 声明 form/url capability，接收 `elicitation/create`，经 Agent Bridge 和 Gateway 生成可交互 Web 卡片，再将用户的 accept/decline/cancel 响应送回原 ACP connection。既支持 session-scoped elicitation，也支持具有可信用户来源的 request-scoped elicitation。

## 核心理念

### 协议交给 SDK，产品语义留在 Cheers

- 官方 SDK 负责 ACP framing、JSON-RPC 路由、请求响应关联和稳定 v1 typed request。
- Cheers 保留 Tokio 子进程启动层，因为 connector 仍需控制 `cwd`、`env_clear`、精确环境继承和 stderr 生命周期。
- `session/update`、`session/request_permission` 与 Elicitation 扩展字段继续经过 raw/untyped 边界，避免未知 update、`_meta.codex.params` 或 Claude/Codex 私有字段在中转时丢失。
- 认证选择、默认 client capabilities、permission option 归一化和 settings 应用规则放入 transport-neutral 语义模块，official runtime 不再反向依赖 legacy adapter。

### 能力最小化，不因 SDK 升级扩大权限

- `clientCapabilities.fs.readTextFile=false`、`fs.writeTextFile=false`、`terminal=false` 保持不变。
- 未支持的 `fs/*`、terminal 与其他 agent→client 方法继续返回标准未实现错误。
- Elicitation 只声明已经贯通到 Bridge、Gateway 和 UI 的 form/url 能力。
- form schema 若疑似请求 password、token、private key、recovery code 或 payment credential，会在 Connector/Gateway 边界 fail closed。
- URL 模式仅允许 HTTPS；本地开发允许 loopback HTTP。Web 在用户确认前展示完整 URL，不预取、不自动跳转。

### 两种 request ID，各司其职

Gateway/Web 消息同时保留两类 ID：

- `request_id`：Cheers 生成的 UUID，是卡片、REST API 和 Bridge resolution 的业务主键。
- `acp_request_id`：ACP JSON-RPC 原始 ID，只用于协议关联、日志审计和故障排查，绝不作为授权凭证。

数字 JSON-RPC ID `12` 与字符串 ID `"12"` 使用不同的 canonical key，避免类型碰撞。

### Request-scoped Elicitation 必须绑定可信用户

没有 `sessionId` 的 elicitation 通过 `requestId` 关联正在执行的 client→agent request。Cheers 为 human-originated `session/new`、`session/load` 和 `authenticate` 临时登记 `RequestRoute`，其中包含：

- channel、task、placeholder message；
- 原始用户消息 `origin_msg_id`；
- 发起用户 `initiating_user_id`；
- 可选 Cheers session。

Gateway 创建卡片前会重新验证：原始消息存在于同一频道、sender 是该用户、该用户当前仍是频道成员。解析卡片时还要求 JWT 用户与 `initiating_user_id` 完全一致，并继续经过现有 approver/`RESPOND` policy。

路由只在对应 ACP 请求未结束时存在；响应、错误或超时都会移除。无法匹配、已经过期、bot/system 发起和 startup initialize 场景统一返回 `cancel`。这使 request ID 成为短生命周期 correlation key，而不是可重放 capability。

## Runtime 解耦

- `RuntimeAdapter` 管理生命周期、initialize、session、认证与配置。
- 可克隆 `PromptClient` 承担并发 prompt，Bridge 主流程不再依赖具体 adapter enum。
- 不可变 `AgentCapabilities` 集中表达 load-session、image/audio prompt、MCP HTTP/SSE 等能力。
- runtime factory 返回 trait object，测试可以直接注入 fake runtime。
- official 和 legacy transport 共享相同的上层 Bridge runtime；legacy 仅保留为 `0.1.37` 的回滚窗口。

## 流式并发修复

Delta frame 在 `ActiveRun` 锁内完成状态计算和 frame 构造，释放锁后才等待 Bridge I/O。网络背压不再长期占用 run lock，因此 permission、elicitation 和终态处理不会被慢连接阻塞。

后续性能加固进一步实现：

- 相邻 Delta 在 12ms/8KiB 边界内合并，减少 JSON 序列化和 WebSocket frame；
- priority 与 streaming 使用独立有界队列，交互事件不再被满 Delta 队列阻塞；
- `SharedRuntimeState` 拆成 run、interaction、resource、session lock、channel name、watch 六个锁域；
- 高频 `session/update` 移动 JSON subtree，不再为了 relay 深拷贝整个 payload；
- official runtime 将 prompt 与 control 分为独立有界并发池，队列饱和时明确失败而不是无限创建 Tokio task。

详细约束与调优指标见 `docs/arch/ACP_CONNECTOR_PERFORMANCE.md`。

## MCP 边界

- 当前产品只注入 Gateway 提供的 canonical、headerless HTTP MCP URL；Agent 自行完成 OAuth discovery、登录、token 保存和刷新。
- Connector 的 stdio Cheers MCP sidecar、loopback resource server 和 Agent Bridge `resource_req/resource_res` 已从活跃 runtime 删除；无 OAuth proxy、静态 Bearer 或自动回退。
- `workspace_req/workspace_res` 继续保留为远程 `read_workspace` 读取 owner Connector 本机文件的最后一跳。
- `agent-client-protocol-http` 是远程 ACP agent transport，不是 MCP Web transport。
- 不启用 `unstable_mcp_over_acp`；本地 Connector→Agent 仍使用 ACP stdio。
- 原生 OAuth 兼容证据与限制见 [[Cheers-Native-HTTP-MCP-ACP-Completion-2026-08-13]]。

## Web 交互

- Gateway 将 elicitation 持久化为 `msg_type=elicitation` 普通频道消息。
- `ElicitationContentData` 是 Gateway 与 Web 之间的 DTO，包含 Cheers request ID、ACP request ID、发起用户、schema、URL 和 resolution 状态。
- Web form 使用共享 Input/Select/Checkbox 组件，并执行 required-field 基础检查。
- URL card 在用户点击 Continue 后先记录 consent，再导航到完整目标 URL。
- `elicitation/complete`、timeout 和 connector cancellation 会把卡片更新为终态。

## 文档与代码注释

- Rust 模块使用 `//!` 描述模块职责、边界和安全假设。
- 公共类型、trait 和关键函数使用 `///` rustdoc。
- TypeScript DTO、组件和关键交互函数使用 TSDoc/JSDoc。
- 详细协议说明见 [[ACP_ELICITATION]] 和 `docs/arch/ACP_RUST_SDK_ADOPTION.md`。

## 验证结果

- Connector `cargo fmt --check`：通过。
- Connector `cargo test --workspace --locked`：137 个测试通过。
- Connector `cargo check --workspace --locked`：通过。
- Connector `cargo build --release --locked`：通过。
- Gateway `cargo fmt --check`：通过。
- Gateway `cargo test --locked`：258 个测试通过。
- Frontend `npm run typecheck`：通过。
- Frontend `npm test -- --run`：38 个测试文件、213 个测试通过。
- Frontend `npm run design-system:check`：通过，无新增视觉债务。
- Frontend `npm run build`：通过，PWA service worker 正常生成。

## 关键文件

- `packages/cheers-acp-connector-rs/src/runtime_adapter.rs`
- `packages/cheers-acp-connector-rs/src/acp_runtime.rs`
- `packages/cheers-acp-connector-rs/src/acp_adapter.rs`
- `packages/cheers-acp-connector-rs/src/acp_semantics.rs`
- `packages/cheers-acp-connector-rs/src/bridge_runtime/elicitation.rs`
- `packages/cheers-acp-connector-rs/bridge-protocol/src/lib.rs`
- `server/src/gateway/ws/agent_bridge.rs`
- `server/src/api/approval.rs`
- `frontend/src/features/chat/ElicitationCard.tsx`
- `frontend/src/types/index.ts`
- `docs/arch/ACP_ELICITATION.md`
- `docs/arch/ACP_CONNECTOR_PERFORMANCE.md`
- `docs/arch/MCP_STREAMABLE_HTTP_SPIKE.md`

## 发布与后续

- `0.1.37` 默认 `CHEERS_ACP_TRANSPORT=official`，保留 `legacy` 回滚；旧 `CHEERS_ACP_RUNTIME` 兼容读取一个版本并输出弃用警告。
- 真实 Codex/Claude、macOS/Linux smoke matrix 至少观察 7 天，且没有未解决 P0/P1 runtime 回归后，才能进入 `0.1.38`。
- `0.1.38` 删除 hand-rolled framing、pending map、legacy requester、transport 选择枚举和临时环境变量。
- transport 稳定后再拆分 `RuntimeContext` 的会话协调、运行记录、权限、workspace/watch 和 Bridge sink 状态，避免把 SDK 迁移与大规模锁重构混在同一发布风险中。
