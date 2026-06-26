# Cheers ACP connector 协议库采用（typed schema → 官方 runtime）

> 版本：v0.1（2026-06-26）
> 上层：[ACP_INTEGRATION.md](./ACP_INTEGRATION.md)（ACP 在架构中的定位）
> 配套：[ACP_CONNECTION_MODEL.md](./ACP_CONNECTION_MODEL.md) · [ACP_FS_PROXY.md](./ACP_FS_PROXY.md) · [ACP_APPROVAL_FLOW.md](./ACP_APPROVAL_FLOW.md)
> 本文专注：connector ↔ **ACP agent 进程**（stdio）这一侧的协议实现 —— 从手写 JSON-RPC 迁移到官方 Rust 库的**两档计划**。

---

## 0. 决策摘要

| 维度 | 决策 | 理由 |
|------|------|------|
| 库来源 | 官方 [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol)（agentclientprotocol/rust-sdk）；类型层 [`agent-client-protocol-schema`](https://crates.io/crates/agent-client-protocol-schema) | Zed 同源、协议权威；connector 做的正是 **client 端** |
| **Tier A（已落地）** | 依赖 `agent-client-protocol-schema`，仅在**安全敏感的 ACP 报文边界**用 typed struct，**保留**自有传输层 | 低风险、消灭 stringly-typed 脆弱点、把锁定姿态变成类型断言 |
| **Tier B（规划）** | 全量采用 `agent-client-protocol` runtime（builder/callback/connection），删掉手写 JSON-RPC + 子进程 + framing | 维护性最佳，但需重塑事件模型、绑定刚发布 2 天的 1.0 API |
| 接缝 | `RuntimeAdapter` trait（`runtime_adapter.rs`，Value in/out）—— 两档都只改 `acp_adapter.rs`，trait 面不变 | blast radius = 单文件 |
| 协议版本 | 稳定 wire **v1**（`schema::v1::*` + `ProtocolVersion::V1`），**不启用任何 `unstable` feature** | 当前 `protocolVersion:1` 直接对应；v2 是 opt-in 草案 |

---

## 1. 现状（迁移前）

ACP 协议集中在 `packages/cheers-acp-connector-rs/src/acp_adapter.rs`（~875 行），**手写 JSON-RPC over stdio**：

- 自拼 `{"jsonrpc":"2.0",...}`，自维护 `PendingMap`（`BTreeMap<u64, oneshot>`）+ `AtomicU64` id；
- 自实现**双 framing**：行分隔 JSON **与** LSP 式 `Content-Length`（`read_acp_message`）；
- 自 spawn / kill agent 子进程，读 stdout/stderr。

connector 是 **client 端**（驱动外部 agent）：出站 `initialize` / `session/new` / `session/load` / `session/prompt` / `session/cancel` / `session/set_config_option` / `session/set_mode`；入站只服务 `session/request_permission`，其余 agent→client 方法一律 `-32601`（见 `peer_method_supported`，刻意只暴露权限一项）。

整个 connector ~8.3k 行里**只有这一文件是 ACP**；其余（`bridge_runtime`、到 Backend 的 Agent Bridge WS 协议、TOML policy、Ed25519 capability 签名）与 ACP 库无关。

---

## 2. Tier A —— typed schema（已落地）

> 首版基于 `c86e621b` 实现；**已在 `feat/acp-tier-ab`（off develop，fd4a4a29 base）重新落地**——develop 的 connector 重构把 Tier A 的面缩小了（见下）。

依赖：`agent-client-protocol-schema = "1.1"`（Cargo.lock 锁 `1.1.0`；MSRV 1.88，本机 rustc 1.95）。

**原则**：type 化「connector 自己构造」且**安全敏感**的报文；**纯透传**的 payload 保持 `Value`，避免有损 reshape（符合 CLAUDE.md「problem-first，不掩盖契约差异」）。

### 2.1 已 typed 的边界（develop 版）

| 位置 | 改动 | 收益 |
|------|------|------|
| `initialize` 出站 caps | `default_client_capabilities()` 函数体 → `ClientCapabilities::default()` | **`ClientCapabilities::default()` == 锁定姿态**（`fs.readTextFile/writeTextFile=false`、`terminal=false`），由类型断言而非手写 JSON。两结构体均 `#[skip_serializing_none]`，序列化**逐字节等于**旧手写，config.rs 的精确相等测试不变 |
| `initialize` 出站 clientInfo | 手写 JSON → `Implementation::new(...)` | 去掉手搓 JSON（非安全敏感，但与上同处一条报文，顺手 typed） |
| 权限响应 | `RequestPermissionResponse` / `RequestPermissionOutcome` / `SelectedPermissionOutcome`（新 helper `write_permission_response`） | 删手写 `{"outcome":{...}}` 两处 + `PermissionOutcome::to_acp_value()`；**wire-identical** |

权限响应 wire 形态经核实与旧手写**逐字节等价**（`RequestPermissionOutcome` 是 `#[serde(tag="outcome", rename_all="snake_case")]`）：选中 → `{"outcome":{"outcome":"selected","optionId":"…"}}`；取消 → `{"outcome":{"outcome":"cancelled"}}`。

`protocolVersion` 保持 develop 的单一事实源常量 `ACP_PROTOCOL_VERSION`（= `ProtocolVersion::V1` 的 wire 值 1），不强行替换。运营方 config override `client_capabilities` 仍**逐字透传**。

> **与首版的差异（develop 缩小了 Tier A）**：首版还包含「`initialize` 入站用 `InitializeResponse` 解析 `agent_info.name` + `load_session`」。develop 的 fd4a4a29 **已经**把这些响应读取重构成一个共享的 `agent_capabilities() -> Option<&Value>` helper（被 `supports_load_session/prompt_image/mcp_http/mcp_sse` 复用），脆弱性已消除，且该读取**非安全敏感**。因此 develop 版 Tier A **不再做这条**，把范围收回到两个安全边界（能力宣告 + 权限决定）。

### 2.2 刻意保持 opaque（**不**该 typed）

下列是纯中继 payload，typed 会引入有损 reshape 或不必要的 strict 解析，**有意保留 `Value`/`json!`**：

- `session/new` · `session/load` 的 `mcpServers` —— 来自 TOML config，schema 的 `McpServer` 是 tagged enum（Http/Sse/Acp/Stdio）；
- `session/prompt` 的 prompt content —— `Vec<ContentBlock>`，由 Backend 下发；
- `session/update` 的 payload —— 整体透传给 Backend，connector 不解释；
- `session/request_permission` 的 `tool_call`（`ToolCallUpdate`，富类型）—— connector **不消费**，整个 `params` 透传 Backend；`permission_options` 的入站 options 解析保留宽松。

### 2.3 回归守护

- `default_client_capabilities_advertise_no_fs_or_terminal`（develop 既有测试，已加强）—— 钉住 fs/terminal=false **且** typed 默认序列化成精确锁定形态，防 crate 升级漂移；
- `permission_response_is_wire_compatible` —— 钉住权限响应 wire 形态；
- `config::tests::loads_toml_config_with_local_policy`（既有）—— 精确相等地验证 `ClientCapabilities::default()` == 旧手写 caps，确保未引入 `_meta` 等多余键。

传输层（PendingMap / framing / 子进程 / transport）**完全未动** —— 那是 Tier B。

---

## 3. Tier B —— 全量 runtime（规划，未启动）

目标：用官方 `agent-client-protocol`（runtime crate，**1.0.0，2026-06-24 发布**）替换 `acp_adapter.rs` 的传输部分。

### 3.1 API 模型（与现状不同）

1.0 的 client 是 **builder + callback** 模型：

```rust
Client.builder()
    .on_receive_notification(|n: SessionNotification, _| async { /* → RuntimeEvent::SessionUpdate */ }, on_receive_notification!())
    .on_receive_request(|r: RequestPermissionRequest, responder, _| async { /* → RuntimeEvent::PermissionRequest */ }, on_receive_request!())
    .connect_with(AcpAgent::from_str(&command)?, |cx: ConnectionTo<Agent>| async move {
        cx.send_request(InitializeRequest::new(ProtocolVersion::V1)).block_task().await?;
        cx.send_request(NewSessionRequest::new(cwd)).block_task().await?;
        cx.send_request(PromptRequest::new(session_id, content)).block_task().await?;
        Ok(())
    }).await?;
```

- **删除**：手写 JSON-RPC plumbing、`PendingMap`、双 framing、子进程 spawn（`AcpAgent`/`-tokio` 内建）。
- **重塑**：把 `RuntimeEvent`（`SessionUpdate`、带 `oneshot respond_to` 的 `PermissionRequest`）映射到 callback + responder 模型 —— **非 drop-in，是改写**。

### 3.2 风险 / 决策门（启动 Tier B 前必须消解）

1. **1.0 才发布 2 天 + 刚大重构**（迁 org `zed-industries → agentclientprotocol/rust-sdk`、拆 v1/v2 schema、新增 `-tokio`/`-rmcp`/`-derive`/`-conductor`）。API churn 风险高 → **先观察 1.x 稳定性、锁定确切版本**。
2. **Send / 线程模型 —— ✅ 已核实(Send-based)**：`ConnectTo<R>: Send + 'static`、`connect_with`/`run_until` 闭包与 future 全带 `+ Send`、`SessionBlockState: Send + Sync`。→ **不需要 `LocalSet`/`spawn_local`**,直接塞进现有多线程 runtime。配套设计:**actor 包装** —— 一个长生命周期 task 在 `connect_with` 闭包里跑命令循环,`RuntimeAdapter` 的方法翻成 mpsc Command,`ConnectionTo::send_request(&self)` 走 `Arc<ConnectionTo>`(`send_request` 取 `&self`)支持多 session 并发;`ActiveSession<'responder>` 是借用、出不了闭包,故走低层 `cx.send_request(PromptRequest::new(session_id,…))`。trait 接缝因此不变。
3. **双 framing 兼容性**：官方库大概率只按 ACP 规范做行分隔；需确认对接 agent 无人依赖 `Content-Length`。
4. **安全姿态不能退**（最高优先）：`fs`/`terminal` 能力报 `false`、fs/* 返回 `-32601`、Ed25519 capability delegation、workspace symlink 逃逸修复（见近期 commit）。**Tier B 前重跑 `/security-review`**，确认库默认行为不偷偷重开 fs/terminal handler 或自动 advertise 能力。
5. **opaque 透传**：§2.2 的 mcpServers / prompt content / session_update / tool_call 在 runtime 模型下如何保持不有损中继 —— 需逐项验证库是否给出 raw JSON 出入口。

### 3.3 触发条件

满足「1.x 出 ≥1 个 patch 且无 API 破坏」+「~~Send 模型已确认可嵌入~~ ✅ 已确认」+「security-review 通过」+「§3.5 opaque-relay 门已判定」后，再立项 Tier B。在此之前，Tier A 即为 connector 的 ACP 类型基线。

### 3.4 Cheers 资源 MCP 注入 —— **已在产，Tier B 必须原样带过去**

> 结论来源：多 agent 调研 + 对抗复核（2026-06-26）。要点：这个能力**今天已经在跑**，不是新功能。

**现状（已 ship）**：`mcp_servers_for_task`（`bridge_runtime/mod.rs:1293-1322`）默认把一个 `cheers` **stdio MCP server**（`cheers-mcp-server` 二进制）注入 `session/new` 的 `mcpServers`，由 `policy.mcp.inject_cheers`（默认 `true`）开关。调用链：agent → `cheers-mcp-server`(stdio MCP) → loopback HTTP（`loopback.rs`，`127.0.0.1/resource`，随机 per-connector token 鉴权）→ `resource_req` data 帧 → gateway `resource::dispatch(Principal::bot, channel_id)`（成员/角色校验 + 可选 Ed25519 capability）。

**Tier B 必做（carry-through，属于 Tier B）**：runtime swap 时，`acp_adapter.rs` 的 `new_session`/`load_session`（`:332-369`）要把**同一份** `mcp_servers_for_task` 输出序列化进 runtime 的 **typed `McpServer::Stdio`**。纯传输翻译 —— 不碰 gateway、不碰安全模型。
- 测试 ①：切 runtime 后 `mcpServers` entry 逐字段存活（不被运行时悄悄丢/改）。
- 测试 ②：gateway 仍**拒绝非成员 `channel_id`**（该 `channel_id` 是 client 提供的 tool arg，`cheers-mcp-server` 侧 `channel_id_prop()`，gateway 必须每次 membership-check，绝不信 client 断言）。

**必须守住的安全闸**（任何阶段）：(i) 每个工具最终落到 `resource::dispatch` 带服务端绑定的 `Principal::bot(bot_id)` + per-call `channel_id`；(ii) `require_capability` 的 Ed25519 仍生效；(iii) 不得成为 OS-absolute `fs/*` 后门（Desk = `context_files`，相对路径，≠ 本地盘）；(iv) 破坏性操作靠 role/capability 把关 —— **平台资源 MCP 工具不经 `session/request_permission`**（那层只管 `local:*` Bash/Write），所以授权全在 `dispatch` 的 role/membership 层。

**一个被低估的现状点（Tier B 只能保持、不得扩大）**：loopback token 注入在 **agent 进程树的 env**（`CHEERS_RESOURCE_TOKEN`，agent 及其子进程可见），它在 connector 生命周期内授予对 `127.0.0.1/resource` 的**免成员校验 POST**。bot token 与 Ed25519 私钥**不**下发给 child（已核实 `mod.rs:1313-1318`）。

**不属于 Tier B（留给 Tier C RFC）**：
- **MCP-over-ACP 连接器自当工具服务端**（`agent-client-protocol-rmcp` 的 `with_mcp_server`/`tool_fn`，或 `McpServerAcp`）—— 连接器变成 tool server = 新 SDK 面 + 新角色；`McpServerAcp` 还在 `unstable_mcp_over_acp` 门控下（“may be removed”），与 Tier A「不碰 unstable」冲突。
- 退役独立 `cheers-mcp-server` 二进制、改 in-process tools。
- 任何**新增**自主资源 verb / 触达 OS-absolute `fs/*` —— 带真实安全 scope，需重过安全闸。

### 3.5 opaque-relay 门（Tier B 的 make-or-break）

runtime 的入站回调给的是 **typed** `SessionNotification` / `RequestPermissionRequest`，而 connector 是把 `session/update` payload、`tool_call` **整体透传给 Backend** 的。Tier B 必须先判定 `typed → Value` 往返是否**无损**（schema 是否用 `RawValue`/`_meta` 兜住扩展字段）：无损→畅通；有损但 Backend 只消费已知字段→可接受记风险；有损且 Backend 依赖原始形态→**Tier B 阻塞**（等 SDK raw hook 或把 Backend 契约也升 typed）。这是 P0 spike 第一件事。

---

## 4. 参考

- 官方库页：<https://agentclientprotocol.com/libraries/rust>
- runtime crate / 示例：<https://github.com/agentclientprotocol/rust-sdk>（`src/agent-client-protocol/examples/`）
- schema crate：`agent-client-protocol-schema`（wire v1 在 `src/v1/`）
