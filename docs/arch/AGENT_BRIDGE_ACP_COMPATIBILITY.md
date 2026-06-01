# Agent Bridge 自定义协议与 ACP 兼容设计

> 状态：讨论稿
> 日期：2026-06-01
> 配套：[AGENT_BRIDGE_PROTOCOL](./AGENT_BRIDGE_PROTOCOL.md) · [ACP_CONNECTION_MODEL](./ACP_CONNECTION_MODEL.md) · [ACP_INTEGRATION](./ACP_INTEGRATION.md) · [AGENT_BRIDGE_RESOURCE](./AGENT_BRIDGE_RESOURCE.md) · [WIRE_PROTOCOL](./WIRE_PROTOCOL.md)

本文专门讨论 AgentNexus 当前的服务端 `acp-bridge` 协议与外部 Agent Client Protocol
（ACP）的关系，并给出一个能同时兼顾自定义 agent 协议和 ACP 协议的系统边界。

Agent Bridge Protocol 的握手、请求/事件表、时序和实现范围见
[AGENT_BRIDGE_PROTOCOL](./AGENT_BRIDGE_PROTOCOL.md)。本文只讨论它与 ACP 的边界关系。

这里的核心判断是：

**AgentNexus 服务端不应该直接变成 ACP Server。服务端应保留平台侧 Agent Bridge
Protocol，ACP 只作为 connector 面向本地 agent runtime 的一种适配协议。**

换句话说：

```
Browser / User
  │
  │ AgentNexus REST + browser WS
  ▼
Rust Backend
  │
  │ AgentNexus Agent Bridge Protocol
  │ control WS + data WS
  ▼
Connector
  │
  ├─ ACP Adapter       → OpenCode / Codex / Claude 等 ACP agent
  ├─ Custom Adapter    → 自定义 stdio / HTTP / WS agent
  └─ Future Adapters   → MCP / A2A / vendor-specific runtime
```

这样做的好处是：平台语义由服务端统一裁判，agent runtime 的多样性由 connector
吸收。服务端不需要为每一种 agent 协议长出一套状态机。

---

## 1. 两个协议解决的问题不同

### 1.1 AgentNexus Agent Bridge Protocol

AgentNexus 自定义的 Bridge Protocol 是平台边界协议。它连接的是：

```
AgentNexus Backend ↔ connector
```

它需要表达 AgentNexus 的平台事实：

- bot 身份、bot token、在线状态、control/data 连接生命周期。
- workspace/channel/member/message/file/memory 等平台资源。
- 用户消息触发、bot 占位消息、流式 delta、最终 done。
- 浏览器审批、bot 权限请求、cancel、配置下发。
- 服务端写后投递、channel fanout、持久化与最终一致。
- capability delegation、平台级资源鉴权和审计。

这些都不是纯粹的 ACP 语义，而是 AgentNexus 作为协作平台必须拥有的语义。

### 1.2 ACP

ACP 是 agent client 与 coding agent 之间的标准协议。根据官方文档，ACP 当前使用
JSON-RPC 2.0；连接初始化通过 `initialize` 协商 `protocolVersion` 和 capabilities；
典型链路是 `session/new` 或 `session/load` 后调用 `session/prompt`，agent 再通过
`session/update` 通知输出、工具调用、计划、配置变更等事件。

ACP 的默认场景是：

```
editor / client ↔ coding agent
```

它擅长表达：

- agent 初始化和能力协商。
- coding session 生命周期。
- prompt turn。
- agent message chunk、tool call、plan、mode、config options。
- 客户端文件系统、terminal、权限请求。
- JSON-RPC 错误、`_meta`、下划线自定义方法、自定义 transport。

ACP 不直接建模 AgentNexus 的 workspace/channel/message/fanout/DB 持久化边界。
因此，把 AgentNexus 服务端协议强行改成 ACP，会把平台语义塞进 ACP 扩展字段里，
长期会让协议边界更混乱。

---

## 2. 决策摘要

| 问题 | 决策 |
|------|------|
| 服务端 `/ws/acp-bridge/*` 是否直接说 ACP JSON-RPC | 否。保持 AgentNexus Bridge Protocol。 |
| ACP 放在哪里 | 放在 connector 的 runtime adapter 层。connector 是 ACP client，本地 agent 是 ACP agent。 |
| 自定义 agent 协议怎么接 | 自定义 adapter 接入 connector，或高级集成方直接实现 AgentNexus Bridge Protocol。 |
| 服务端是否关心本地 agent 是 ACP 还是 custom | 默认不关心。服务端只看 connector 上报的能力和平台帧。 |
| 平台资源访问是否走 ACP `fs/*` | 不直接走。平台资源继续走 `resource_req/resource_res`；connector 可把它暴露给 ACP agent 的 MCP server 或 prompt context。 |
| 权限谁裁判 | 服务端裁判平台权限；connector 只负责把 ACP permission request 翻译成平台 `permission_request` 并等待结果。 |
| 配置谁权威 | 服务端保存平台配置；ACP session config options 由 connector 映射和同步。 |
| 是否预留 ACP-native remote endpoint | 可以预留，但作为独立 gateway adapter，不替代现有 Bridge Protocol。 |

---

## 3. 分层架构

### 3.1 平台层：Rust Backend

Rust Backend 的边界是平台事实和平台安全：

- 验证 bot token。
- 管理每个 bot 的 control/data WS 生命周期。
- 新连接 supersede 旧连接。
- 派发 `task`、`cancel`、`config_update`、`config_option_set`、`permission_resolution`。
- 接收 `delta`、`done`、`send`、`file_upload`、`resource_req`、`permission_request`。
- 校验 bot 是否在目标 channel。
- 校验 capability delegation。
- 将终态消息写入 PG，再 fanout 到浏览器。
- 保存 connector 状态、配置状态和 ACP discovered options。

服务端不应该知道 OpenCode、Codex、Claude、某个自定义 agent 的 stdio 细节。

### 3.2 Bridge 层：AgentNexus Bridge Protocol

这是服务端和 connector 的稳定协议。当前已经有两条 WS：

| WS | 方向 | 职责 |
|----|------|------|
| control | Backend ↔ connector | 生命周期、task、cancel、配置、审批结果 |
| data | Backend ↔ connector | delta/done/send/file/resource/permission_request/session_update |

建议把它正式命名为 **AgentNexus Agent Bridge Protocol**，避免把服务端
`acp-bridge` 与标准 ACP 混成一件事。

### 3.3 Adapter 层：connector 内部 runtime adapter

connector 应该抽象出一个 runtime adapter 接口：

```ts
interface AgentRuntimeAdapter {
  initialize(): Promise<RuntimeCapabilities>;
  openSession(scope: RuntimeSessionScope): Promise<RuntimeSessionRef>;
  prompt(input: RuntimePrompt): AsyncIterable<RuntimeEvent>;
  cancel(ref: RuntimeTurnRef): Promise<void>;
  setConfigOption?(ref: RuntimeSessionRef, configId: string, value: string): Promise<RuntimeConfigState>;
  dispose(): Promise<void>;
}
```

ACP 只是其中一个实现：

```ts
class AcpRuntimeAdapter implements AgentRuntimeAdapter {
  // AgentNexus task → ACP session/prompt
  // ACP session/update → AgentNexus delta / trace / permission_request / config_options
}
```

自定义 agent 协议也实现同一个接口：

```ts
class CustomHttpRuntimeAdapter implements AgentRuntimeAdapter {
  // AgentNexus task → vendor HTTP request
  // vendor stream → AgentNexus delta / done / files
}
```

这样，AgentNexus Bridge Protocol 面向服务端保持稳定，connector 内部可替换 runtime。

---

## 4. 语义映射

### 4.1 Task / prompt

AgentNexus 的 `task` 和 ACP session 不是同一个概念：

- `runtime_session_control` 负责 create/pause/terminate/resume 远端 ACP/custom runtime session。
- `task` 只是在某个 runtime session 上启动一次 prompt turn / agent run。
- `task` 可以按 `session_policy` 隐式 create/resume session，但这只是便捷行为，不是概念合并。

| AgentNexus Bridge | ACP | 说明 |
|-------------------|-----|------|
| control `runtime_session_control: create` | `session/new` | Backend 显式要求 connector 创建或打开 runtime session。 |
| control `runtime_session_control: pause` | connector-local park | ACP 无强制等价方法时，由 connector 暂停并保留映射。 |
| control `runtime_session_control: terminate` | active turn `session/cancel` + adapter dispose | Backend 要求 connector 终止并释放 runtime session。 |
| control `runtime_session_control: resume` | `session/load` 或 connector cache restore | Backend 显式要求恢复已有 runtime session。 |
| control `task` | `session/new` 或 `session/load` + `session/prompt` | connector 根据 `provider_session_key` 选择或创建 ACP session。 |
| `trigger_message` / attachments / history | ACP `ContentBlock[]` | 文本、图片、文件引用、嵌入上下文由 connector 转换。 |
| `placeholder_msg_id` | adapter 内部 `RunContext.msgId` | ACP 不需要知道平台占位消息 id，可放进 `_meta` 做追踪。 |
| control `cancel` | ACP `session/cancel` | 服务端取消的是平台输出；connector best-effort 取消本地 agent turn。 |

原则：`task` 是平台事件，`session/prompt` 是 runtime 调用。两者不要合并成一个协议对象。

### 4.2 Streaming output

| ACP | AgentNexus Bridge |
|-----|-------------------|
| `session/update` + `agent_message_chunk` | data `delta` |
| `session/update` + plan/tool/status | data `trace` 或 `session_update` |
| `session/prompt` response stop reason | data `done` |
| ACP error / rejected prompt | data `error` 或 finalize partial message |

服务端面向浏览器的流式 `seq` 必须仍由 Backend 盖戳。connector 或 ACP agent 自带的 seq
只能作为诊断字段，不能作为客户端去重依据。

### 4.3 Permission

| ACP | AgentNexus Bridge | 谁负责 |
|-----|-------------------|--------|
| Agent 调 Client `session/request_permission` | data `permission_request` | connector 翻译 |
| 浏览器用户审批 | browser REST/WS → Backend | Backend 校验用户和频道 |
| Backend 推回结果 | control `permission_resolution` | Backend 权威下发 |
| connector 回 ACP response | JSON-RPC response to `session/request_permission` | connector 完成本地等待 |

这里的服务端闭环很重要。connector 不能自己决定平台权限结果；它只能等待 Backend
下发 `permission_resolution`。

### 4.4 Files and resources

| 场景 | AgentNexus Bridge | ACP adapter 行为 |
|------|-------------------|------------------|
| 用户附件给 agent | task attachments / file HTTP endpoint / resource | 转成 ACP image/resource/resourceLink 或下载到本地文件。 |
| agent 读取频道历史 | data `resource_req: channel.messages/context` | 可由 connector 调用后塞进 prompt，也可通过本地 MCP server 暴露。 |
| agent 写平台记忆 | data `resource_req: channel.memory.update` | Backend 校验 bot 权限后执行。 |
| agent 生成文件 | data `file_upload` 或 done `file_ids` | connector 上传到平台，再把 file_id 绑到消息。 |
| ACP `fs/read_text_file` | 本地工作区文件 | 不等于 AgentNexus channel file。 |

不要把 AgentNexus 平台资源伪装成本地文件系统。平台资源有成员、审计、对象存储、
频道归属等语义，应继续走 `resource_req/resource_res`。

### 4.5 Config options

ACP 的 session config options 可以作为 AgentNexus bot 设置页的动态选项来源。

| ACP | AgentNexus Bridge |
|-----|-------------------|
| `session/new` result `configOptions` | control `config_options` 上报 |
| `session/update: config_option_update` | control `config_options` 上报 |
| 用户在设置页选择值 | Backend 保存 `binding_config.connector_control` |
| Backend 在线推送 | control `config_option_set` |
| connector 调 ACP `session/set_config_option` | control `config_option_status` 回报 |

服务端保存的是用户期望和最近状态；connector 负责把期望应用到具体 ACP session。

---

## 5. 如何同时兼顾自定义协议和 ACP

### 5.1 保持一个服务端协议

服务端只维护一套 AgentNexus Bridge Protocol，不为 ACP/custom 分叉：

```
Backend → connector:
  hello, task, cancel, config_update, config_option_set, permission_resolution

connector → Backend:
  ready, delta, done, send, file_upload, resource_req, permission_request,
  config_status, config_options, config_option_status, session_update
```

这样服务端代码的复杂度与 agent 协议数量无关。

### 5.2 connector 支持多个 runtime adapter

配置文件中可以显式声明 runtime 协议：

```jsonc
{
  "agent": {
    "protocol": "acp",
    "command": "opencode",
    "args": ["--acp", "--stdio"],
    "cwd": "/repo"
  }
}
```

自定义协议示例：

```jsonc
{
  "agent": {
    "protocol": "custom-http",
    "baseUrl": "http://127.0.0.1:9000",
    "cwd": "/repo"
  }
}
```

服务端只看到 connector 上报的能力：

```jsonc
{
  "type": "ready",
  "connector_version": "0.2.0",
  "runtime": {
    "protocol": "acp",
    "name": "opencode",
    "version": "..."
  },
  "capabilities": {
    "streaming": true,
    "files": true,
    "permission_request": true,
    "config_options": true
  }
}
```

### 5.3 自定义协议集成的两条路

| 路径 | 适用对象 | 代价 | 推荐度 |
|------|----------|------|--------|
| 写 connector runtime adapter | 本地/私有 agent、vendor CLI、HTTP agent | 低；复用 bot token、WS、文件、权限、配置 | 首选 |
| 直接实现 AgentNexus Bridge Protocol | 高级第三方 connector 或云端 agent 服务 | 中；需要完整实现 control/data WS | 可支持 |
| 让服务端直接兼容 vendor 协议 | 每接一个协议改服务端 | 高；污染平台边界 | 不推荐 |
| 把 AgentNexus 平台语义塞进 ACP `_meta` | 表面标准，实际强耦合 | 高；调试和兼容困难 | 不推荐 |

### 5.4 ACP extensibility 的使用边界

ACP 官方支持 `_meta`、下划线自定义方法和自定义 capabilities。AgentNexus 可以使用这些机制，
但只在 connector ↔ ACP agent 这一层使用：

- 可以在 ACP `_meta` 中携带 `agentnexus.taskId`、`agentnexus.msgId`、`traceparent`。
- 可以通过 ACP capabilities 判断 agent 是否支持 image、embeddedContext、configOptions。
- 可以在自有 ACP agent 中定义 `_agentnexus/*` 方法，但不能要求所有第三方 ACP agent 支持它。

不要把 `_meta` 当成平台协议主通道。平台必需字段应保留在 AgentNexus Bridge Protocol 中。

---

## 6. 服务端协议应补强的地方

为了让自定义协议和 ACP adapter 都更稳，服务端 Bridge Protocol 需要补几个明确契约。

### 6.1 hello 增加协议版本和能力

当前 hello 已包含 bot 身份和 membership snapshot。建议增加：

```jsonc
{
  "type": "hello",
  "bridge_protocol_version": 1,
  "server_capabilities": {
    "permission_resolution": true,
    "connector_config": true,
    "config_option_set": true,
    "resource_req": true,
    "capability_delegation": true
  }
}
```

connector 也在 `ready` 中回报：

```jsonc
{
  "type": "ready",
  "connector_capabilities": {
    "runtime_protocols": ["acp", "custom-http"],
    "permission_request": true,
    "config_options": true,
    "file_upload": true
  }
}
```

### 6.2 error 帧统一

所有 Backend → connector 的错误都应该统一成：

```jsonc
{
  "type": "error",
  "code": "CAPABILITY_DENIED",
  "detail": "...",
  "request_id": "optional",
  "retryable": false
}
```

不要出现有的 error 带 `code`、有的不带 `code` 的情况。否则 ACP adapter 和 custom adapter
都只能靠字符串解析错误。

### 6.3 permission_resolution 闭环

服务端需要正式实现：

```
Browser approval
  → Backend 校验审批人、channel、permission request 状态
  → 写入或更新平台消息/状态
  → control WS: permission_resolution
  → connector 唤醒 ACP/custom runtime
```

### 6.4 connector_config 闭环

服务端需要将 `binding_config.connector_control` 作为权威配置源：

- connector 在线：保存后立即推 `config_update` / `config_option_set`。
- connector 离线：保存，下一次 control `hello.connector_config` 下发。
- connector 回报：`config_status` / `config_options` / `config_option_status` 写回
  `binding_config.connector_control.last_status/options/last_option_status`。

### 6.5 resource_req 保持平台协议

`resource_req/resource_res` 应继续作为 AgentNexus 平台资源协议，而不是改造成 ACP `fs/*`。
ACP adapter 可以在内部把 resource 内容转成 prompt content 或 MCP tool 结果。

---

## 7. 命名建议

当前路径和包名里有 `acp-bridge`，容易让人误以为服务端 WS 本身就是 ACP。建议文档和代码逐步采用：

| 当前名称 | 建议名称 | 说明 |
|----------|----------|------|
| `acp_bridge.rs` | `agent_bridge.rs` | 服务端说的是 AgentNexus Bridge Protocol。 |
| `/ws/acp-bridge/control` | `/ws/agent-bridge/control` | 不保留旧 WS alias，避免继续把服务端协议误读为 ACP。 |
| `agentnexus-acp-connector` | 短期保留；长期可考虑 `agentnexus-agent-connector` | 现在主 runtime 是 ACP，包名可暂不动。 |
| `ACP Connector` | `AgentNexus Connector with ACP adapter` | 对外说明更准确。 |

命名迁移以正式协议为准：server 侧只暴露 `/ws/agent-bridge/*`，connector 和部署配置同步切换。

---

## 8. 未来可选：ACP-native remote endpoint

如果未来希望让外部 ACP client 直接连接 AgentNexus，可以新增一个独立 adapter：

```
ACP Client / Editor
  │ ACP JSON-RPC over WS/HTTP
  ▼
AgentNexus ACP Gateway Adapter
  │ 内部调用 AgentNexus domain/resource/task APIs
  ▼
Rust Backend
```

这条路的目标是“让 AgentNexus 表现为一个 ACP agent/client endpoint”，不是替代
Backend ↔ connector 的 AgentNexus Bridge Protocol。

适合场景：

- IDE 想把 AgentNexus 当成一个远程 agent。
- 第三方 ACP client 想读取 AgentNexus channel context。
- AgentNexus 需要参与更大的 ACP 生态。

不适合当前主链路：

- 本地 agent 已经由 connector 拉起。
- 平台权限、文件、消息、审批、fanout 都已经由 Bridge Protocol 表达。
- 直接替换会让服务端同时承担平台网关和 ACP runtime client 两种职责。

---

## 9. 实施路线

### Phase 1：把服务端 Bridge Protocol 定义清楚

- 写定 `control` / `data` 的 Backend → connector 发送帧列表。
- 统一 error 帧。
- 在 hello/ready 中加入 protocol version 和 capability fields。
- 文档中正式使用 AgentNexus Agent Bridge Protocol 这个名称。

### Phase 2：补齐现有闭环

- 实现 `permission_resolution`。
- 实现 `connector_config` / `config_update` / `config_option_set`。
- 将 connector 上报的 `config_options` 正确落到 `binding_config.connector_control.options`。

### Phase 3：connector 内部 adapter 化

- 从 `agentnexus-acp-connector` 中抽出 `AgentRuntimeAdapter` 接口。
- 将现有 ACP stdio 逻辑收敛为 `AcpRuntimeAdapter`。
- 增加一个最小 custom adapter 示例，证明服务端无需改动。

### Phase 4：SDK 与测试

- `packages/agentnexus-bridge-client` 成为自定义 connector 的官方 SDK。
- 增加协议 contract tests：
  - task → ACP prompt → delta/done。
  - ACP permission request → permission_resolution。
  - config options 上报和下发。
  - custom adapter 不经 ACP 也能完成同样的 Bridge Contract。

### Phase 5：按需增加 ACP-native gateway

只有当产品明确需要“第三方 ACP client 直接接入 AgentNexus”时再做。

---

## 10. 不做什么

- 不把 Rust Backend 改成直接管理 ACP stdio process。
- 不让服务端为每个 vendor agent 协议新增分支。
- 不把 AgentNexus channel/file/memory 权限放到 connector 本地判断。
- 不把 ACP `_meta` 当作平台协议的主数据结构。
- 不把本地文件系统权限和 AgentNexus 平台文件权限混成一个概念。
- 不为了短期编译或联调加临时 fake field，而不解决真实协议契约错位。

---

## 11. 参考资料

- ACP 官方介绍：https://agentclientprotocol.com/get-started/introduction
- ACP 协议概览：https://agentclientprotocol.com/protocol/overview
- ACP 初始化与能力协商：https://agentclientprotocol.com/protocol/initialization
- ACP Prompt Turn：https://agentclientprotocol.com/protocol/prompt-turn
- ACP Session Config Options：https://agentclientprotocol.com/protocol/session-config-options
- ACP Extensibility：https://agentclientprotocol.com/protocol/extensibility
- ACP Transports：https://agentclientprotocol.com/protocol/transports
- ACP GitHub repository：https://github.com/agentclientprotocol/agent-client-protocol
