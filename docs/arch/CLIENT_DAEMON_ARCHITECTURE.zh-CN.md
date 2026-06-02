# 客户端 Daemon 架构

> 状态：已确认方向
> 范围：本地客户端 daemon / connector 栈
> 关联：[Agent Bridge 协议](AGENT_BRIDGE_PROTOCOL.md)、[Agent Bridge 资源模型](AGENT_BRIDGE_RESOURCE.md)、[Agent Bridge 与 ACP 兼容设计](AGENT_BRIDGE_ACP_COMPATIBILITY.md)

本文固化客户端 daemon 侧架构，避免实现时把进程监管、Agent Bridge 传输、ACP runtime 行为、
MCP/resource 转发混在一起。

客户端 daemon 侧是一个本地分层系统。每一层只拥有一种状态和一个协议边界。

```text
Local daemon process
  ├─ Supervisor / CLI
  ├─ Config + State Store
  ├─ BridgeSession
  ├─ BridgeRuntime
  ├─ RuntimeAdapter
  │    └─ AcpAdapter
  ├─ Local Loopback Resource Server
  └─ Child processes
       ├─ ACP agent
       └─ agentnexus-mcp-server
```

## 1. 组件边界

| 组件 | 拥有什么 | 对接什么 | 不做什么 |
|------|----------|----------|----------|
| Supervisor / CLI | 本地进程生命周期、daemon metadata、日志 | OS 进程表、本地文件系统 | 不理解 task、ACP、MCP、prompt、频道权限。 |
| Config + State Store | 本地 connector 安全配置和 runtime session 映射 | 本地 TOML 配置和 JSON state 文件 | 不执行任务，不做平台权限裁判。 |
| BridgeSession | Agent Bridge control/data WebSocket 传输 | Rust Backend Agent Bridge WS | 不调用 ACP、不拼 prompt、不处理本地文件。 |
| BridgeRuntime | 任务编排和本地 runtime 状态机 | BridgeSession、RuntimeAdapter、Loopback Resource Server | 不直接实现 vendor 私有协议或 ACP stdio 解析细节。 |
| RuntimeAdapter | runtime 协议适配接口 | BridgeRuntime | 不知道 Agent Bridge transport 细节。 |
| AcpAdapter | ACP JSON-RPC stdio 生命周期和 ACP session 调用 | ACP agent 子进程 | 不持有 bot token，不打开 Agent Bridge WS。 |
| Local Loopback Resource Server | MCP tool call 的本机入口 | agentnexus-mcp-server、BridgeRuntime | 不在本地校验平台 Grant。 |
| agentnexus-mcp-server | 暴露 AgentNexus 资源类 MCP tools | loopback endpoint | 不打开自己的 Agent Bridge 连接。 |
| Rust Backend | 平台事实、权限、持久化、fanout | Agent Bridge Protocol | 不管理本地 ACP/MCP 子进程。 |

一句话规则：

```text
Supervisor 管进程生命周期。
BridgeSession 管 Agent Bridge WS。
BridgeRuntime 管 task 编排。
AcpAdapter 管 ACP JSON-RPC。
Loopback 管 MCP/resource 转发。
State Store 管 session 映射。
```

## 1.1 本地配置形态

本地 TOML config 是 Agent Bridge frame 的本机授权边界，不是 ACP 业务配置文件。

```text
[daemon]
[accounts.<id>.bridge]
[accounts.<id>.adapter]
[accounts.<id>.policy.sessions]
[accounts.<id>.policy.prompt]
[accounts.<id>.policy.workspace]
[accounts.<id>.policy.filesystem.read/write]
[accounts.<id>.policy.terminal]
[accounts.<id>.policy.env]
[accounts.<id>.policy.config]
[accounts.<id>.policy.permission]
[accounts.<id>.policy.send]
[accounts.<id>.policy.file_upload]
[accounts.<id>.policy.trace]
[accounts.<id>.policy.session_update]
[accounts.<id>.policy.mcp]
[accounts.<id>.policy.loopback]
[accounts.<id>.security.acp_capability]
```

`adapter` 只描述如何启动本地 ACP runtime。`cwd`、环境变量暴露、文件系统访问、terminal
访问、resource 转发、permission 转发、send/file 行为、trace/session_update 发射能力都放在
`policy.*` 下。本地没有 `permissionMode = "ask"` 字段；ACP permission request 必须转发给
Backend，并通过 `permission_resolution` 解决。

## 2. 协议边界

Agent Bridge Protocol 是唯一的 Backend-to-connector 协议：

```text
Rust Backend  <── Agent Bridge Protocol ──>  BridgeSession
```

ACP 只存在于 runtime adapter 内部：

```text
BridgeRuntime  <── RuntimeAdapter trait ──>  AcpAdapter  <── ACP JSON-RPC stdio ──>  ACP agent
```

MCP 只存在于 ACP agent / 本地 resource 路径：

```text
ACP agent  <── MCP stdio ──>  agentnexus-mcp-server  <── loopback ──>  BridgeRuntime
```

不要让 ACP 字段污染 Backend 契约，也不要让 Agent Bridge 传输逻辑进入 ACP adapter。

## 3. 启动流

```text
Supervisor
  -> read config
  -> start BridgeRuntime
  -> BridgeRuntime creates AcpAdapter
  -> AcpAdapter spawns ACP agent
  -> AcpAdapter sends ACP initialize
  -> BridgeRuntime creates BridgeSession
  -> BridgeSession opens control/data WS
  -> BridgeSession sends auth on both streams
  <- Backend sends control/data hello
  -> BridgeSession validates both hellos belong to the same bot
  -> BridgeSession sends ready after local runtime is initialized
```

`ready` 的含义必须是 connector 已经可以接 task。不要在本地 runtime adapter 初始化前发送。

## 4. Task 流

v1 canonical task 派发走 control stream：

```text
Backend
  -> control.task
BridgeSession
  -> BridgeRuntime
BridgeRuntime
  -> ensure runtime session
AcpAdapter
  -> session/load or session/new
BridgeRuntime
  -> build prompt from task payload and resource context
AcpAdapter
  -> session/prompt
ACP agent
  -> session/update notifications
AcpAdapter
  -> RuntimeEvent stream
BridgeRuntime
  -> data.delta / data.done / data.error
BridgeSession
  -> Backend
```

关键边界：

```text
Agent Bridge task != ACP session/prompt.
```

`task` 是平台层的一次运行命令；`session/prompt` 是 ACP adapter 内部细节。

## 5. Session 映射

平台 session identity 与 provider session identity 不同：

```text
AgentNexus runtime session:
  session_id
  provider_session_key

ACP provider session:
  acp_session_id
```

本地 State Store 拥有映射：

```text
account_id + provider_session_key -> acp_session_id
```

处理 task 时：

```text
if provider_session_key has a mapped acp_session_id:
  reuse or session/load
else:
  session/new
  persist provider_session_key -> acp_session_id

BridgeRuntime reports provider identity with data.session_update.
```

Backend 不依赖 ACP session 内部细节，只把 provider session id 当作 metadata 和审计上下文。

## 6. MCP / Resource 流

daemon 不直接管理 `agentnexus-mcp-server` 子进程。MCP 生命周期属于 ACP `mcpServers` 机制。

```text
BridgeRuntime
  -> AcpAdapter session/new or session/load with mcpServers
ACP agent
  -> starts agentnexus-mcp-server by ACP/MCP stdio rules
agentnexus-mcp-server
  -> calls local loopback endpoint
Local Loopback Resource Server
  -> BridgeRuntime
BridgeRuntime
  -> data.resource_req
Backend
  -> data.resource_res
BridgeRuntime
  -> loopback response
agentnexus-mcp-server
  -> MCP tool result
ACP agent
```

所有平台资源仍由 Backend 的权限和 resource handler 处理。loopback 只是传输桥，不是权限权威。

## 7. 权限流

Provider permission request 必须通过 AgentNexus 解决，不能在本地伪造。

```text
ACP agent
  -> session/request_permission
AcpAdapter
  -> BridgeRuntime
BridgeRuntime
  -> data.permission_request
Backend
  -> creates approval message/card
User
  -> approve or deny
Backend
  -> control.permission_resolution
BridgeRuntime
  -> AcpAdapter
AcpAdapter
  -> returns ACP permission outcome
```

本地策略只能决定是否把 permission request 转发给 Backend，以及等待 resolution 的超时时间。
本地 daemon 不应静默 allow/reject 平台可见的权限请求。审批卡和 Grant 校验仍归 Backend。

## 8. 配置流

```text
Backend
  -> control.config_update / control.config_option_set
BridgeSession
  -> BridgeRuntime
BridgeRuntime
  -> RuntimeAdapter applies supported fields
RuntimeAdapter
  -> AcpAdapter session/set_config_option when needed
BridgeRuntime
  -> control.config_status / control.config_option_status
```

Backend 在 `binding_config.connector_control.*` 下保存期望配置和最近状态。connector 上报执行状态，
但不是平台配置事实源。

## 9. 实现映射

当前和目标 Rust 模块职责：

| 模块 | 职责 |
|------|------|
| `daemon.rs` | Supervisor 生命周期、daemon metadata、进程身份校验。 |
| `bridge.rs` | Agent Bridge v1 frame 类型和裸 WebSocket 读写。 |
| `bridge_session.rs` | control/data 握手、ready、membership snapshot、frame 收发。 |
| `bridge_runtime.rs` | 编排层：task/cancel/session/config/permission/resource 路由。 |
| `runtime_adapter.rs` | adapter trait 和 runtime event。 |
| `acp_adapter.rs` | ACP stdio JSON-RPC adapter。 |
| `loopback.rs` | MCP tool call 本机 endpoint。 |
| `state.rs` | 本地 provider session 映射存储。 |

## 10. 非目标

- 不让 supervisor 解析或执行 Agent Bridge task。
- 不让 BridgeSession 调 ACP 或拼 prompt。
- 不让 AcpAdapter 打开 Agent Bridge WebSocket 或持有 bot token。
- 不让 daemon 直接 spawn 或持有 `agentnexus-mcp-server`。
- 不在本地判断 AgentNexus channel/file/grant 权限。
- 不用 ACP `session/prompt` 替代 Agent Bridge `task`；两者是不同概念。
- 不添加临时兼容占位来假装 runtime path 已经跑通。

## 11. 当前 Runtime 状态

默认 `run` 路径已经是 Rust-only。旧 TypeScript foreground runtime 和私有 TypeScript
bridge-client 副本已经从仓库删除。

后续工作应继续扩展上面的 Rust 模块，不要重新引入兼容包。

## 12. 最终原则

```text
Backend owns platform truth.
BridgeSession owns transport.
BridgeRuntime owns orchestration.
RuntimeAdapter owns agent protocol differences.
Loopback owns MCP/resource transport.
Supervisor owns local process lifecycle.
```

这样客户端 daemon 栈可以完全 Rust 化，同时不会把 daemon 写成一个不可理解的巨型 agent 实现。
