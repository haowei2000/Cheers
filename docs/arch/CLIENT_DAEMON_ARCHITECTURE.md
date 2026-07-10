# Client Daemon Architecture

> **Language**: English | [中文](CLIENT_DAEMON_ARCHITECTURE.zh-CN.md)

> Status: accepted direction
> Scope: local client-side daemon / connector stack
> Related: [Agent Bridge Protocol](AGENT_BRIDGE_PROTOCOL.md), [Agent Bridge Resources](AGENT_BRIDGE_RESOURCE.md), [Agent Bridge and ACP Compatibility](AGENT_BRIDGE_ACP_COMPATIBILITY.md)

This document fixes the client-side daemon architecture so implementation does not drift between
process supervision, Agent Bridge transport, ACP runtime behavior, and MCP/resource forwarding.

The client daemon side is a layered local system. Each layer owns one kind of state and one protocol
boundary.

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
       └─ cheers-mcp-server
```

## 1. Component Boundaries

| Component | Owns | Talks to | Does not do |
|-----------|------|----------|-------------|
| Supervisor / CLI | Local process lifecycle, daemon metadata, logs | OS process table, local filesystem | Does not understand task, ACP, MCP, prompts, or channel permissions. |
| Config + State Store | Local connector security config and runtime session mapping | Local TOML config and JSON state files | Does not execute work or decide platform permission. |
| BridgeSession | Agent Bridge control/data WebSocket transport | Rust Backend Agent Bridge WS | Does not call ACP, build prompts, or handle local files. |
| BridgeRuntime | Task orchestration and local runtime state machine | BridgeSession, RuntimeAdapter, Loopback Resource Server | Does not implement vendor-specific ACP/stdout parsing itself. |
| RuntimeAdapter | Runtime protocol adapter interface | BridgeRuntime | Does not know Agent Bridge transport details. |
| AcpAdapter | ACP JSON-RPC stdio lifecycle and ACP session calls | ACP agent child process | Does not hold bot token or open Agent Bridge WS. |
| Local Loopback Resource Server | Local endpoint for MCP tool calls | cheers-mcp-server, BridgeRuntime | Does not validate platform grants locally. |
| cheers-mcp-server | MCP tools for Cheers resources | Loopback endpoint | Does not open its own Agent Bridge connection. |
| Rust Backend | Platform facts, permission, persistence, fanout | Agent Bridge Protocol | Does not manage local ACP/MCP child processes. |

One-line rule:

```text
Supervisor manages process lifecycle.
BridgeSession manages Agent Bridge WS.
BridgeRuntime manages task orchestration.
AcpAdapter manages ACP JSON-RPC.
Loopback manages MCP/resource forwarding.
State Store manages session mapping.
```

## 1.1 Local Config Shape

The local TOML config is an authorization boundary for Agent Bridge frames, not an ACP business
config file.

```text
[daemon]
[accounts.<id>.bridge]
[accounts.<id>.adapter]
[accounts.<id>.policy.sessions]
[accounts.<id>.policy.prompt]
[accounts.<id>.policy.workspace]
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

`adapter` only describes how to start the local ACP runtime. `cwd` and environment exposure live
under `policy.workspace` and `policy.env`. Local filesystem and terminal access belong to the local
ACP agent process itself and are bounded by the OS user, cwd/env, container, or sandbox; the
connector advertises ACP client-side `fs` and `terminal` capabilities as unavailable. Permission
forwarding, send/file behavior, and trace or session-update emission still live under `policy.*`.
`policy.loopback` only carries local loopback transport settings; channel resource authorization is
resolved by Backend membership role. There is no local `permissionMode = "ask"` field; ACP
permission requests are forwarded to Backend and resolved through `permission_resolution`.

## 2. Protocol Boundaries

Agent Bridge Protocol is the only Backend-to-connector protocol:

```text
Rust Backend  <── Agent Bridge Protocol ──>  BridgeSession
```

ACP is only inside the runtime adapter:

```text
BridgeRuntime  <── RuntimeAdapter trait ──>  AcpAdapter  <── ACP JSON-RPC stdio ──>  ACP agent
```

MCP is only inside the ACP agent / local resource path:

```text
ACP agent  <── MCP stdio ──>  cheers-mcp-server  <── loopback ──>  BridgeRuntime
```

Do not let ACP fields leak into Backend contracts. Do not let Agent Bridge transport logic leak into
ACP adapter code.

## 3. Startup Flow

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

`ready` must mean the connector can accept task frames. It should not be sent before the local
runtime adapter is initialized.

## 4. Task Flow

Canonical v1 task dispatch uses the control stream:

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

Important boundary:

```text
Agent Bridge task != ACP session/prompt.
```

`task` is a platform command to run one turn. `session/prompt` is ACP adapter internals.

## 5. Session Mapping

The platform session identity and provider session identity are different:

```text
Cheers runtime session:
  session_id
  provider_session_key

ACP provider session:
  acp_session_id
```

The local State Store owns this mapping:

```text
account_id + provider_session_key -> acp_session_id
```

Task handling:

```text
if provider_session_key has a mapped acp_session_id:
  reuse or session/load
else:
  session/new
  persist provider_session_key -> acp_session_id

BridgeRuntime reports provider identity with data.session_update.
```

Backend should not depend on ACP session internals. It only stores provider session identifiers as
metadata and audit context.

## 6. MCP / Resource Flow

The daemon must not directly manage `cheers-mcp-server` as a child process. MCP lifecycle belongs
to the ACP `mcpServers` mechanism.

```text
BridgeRuntime
  -> AcpAdapter session/new or session/load with mcpServers
ACP agent
  -> starts cheers-mcp-server by ACP/MCP stdio rules
cheers-mcp-server
  -> calls local loopback endpoint
Local Loopback Resource Server
  -> BridgeRuntime
BridgeRuntime
  -> data.resource_req
Backend
  -> data.resource_res
BridgeRuntime
  -> loopback response
cheers-mcp-server
  -> MCP tool result
ACP agent
```

All platform resources still go through Backend permission and resource handlers. Local loopback is
only a transport bridge; it is not the permission authority.

## 7. Permission Flow

Provider permission requests must be resolved through Cheers, not forged locally.

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

Local policy may decide whether permission requests are forwarded to Backend and how long the
daemon waits for a resolution. It must not silently allow or reject platform-visible permission
requests. Approval cards and grant checks remain Backend-owned.

## 8. Config Flow

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

Backend stores desired config and last reported status under `binding_config.connector_control.*`.
Connector reports execution status; it is not the source of platform config truth.

## 9. Implementation Mapping

Current and target Rust module ownership:

| Module | Role |
|--------|------|
| `daemon.rs` | Supervisor lifecycle, daemon metadata, process identity verification. |
| `bridge.rs` | Agent Bridge v1 frame types and raw WebSocket read/write. |
| `bridge_session.rs` | Control/data session handshake, ready, membership snapshot, frame send/receive. |
| `bridge_runtime.rs` | Orchestration layer: task/cancel/session/config/permission/resource routing. |
| `runtime_adapter.rs` | Adapter trait and runtime events. |
| `acp_adapter.rs` | ACP stdio JSON-RPC adapter. |
| `loopback.rs` | Local endpoint for MCP tool calls. |
| `state.rs` | Local provider session mapping store. |

## 10. Non-Goals

- Do not make the supervisor parse or execute Agent Bridge tasks.
- Do not make BridgeSession call ACP or build prompts.
- Do not make AcpAdapter open Agent Bridge WebSockets or hold bot tokens.
- Do not let daemon directly spawn or own `cheers-mcp-server`.
- Do not decide Cheers channel/file/grant permissions locally.
- Do not replace `task` with ACP `session/prompt`; they are different concepts.
- Do not add compatibility placeholders to fake a working runtime path.

## 11. Current Runtime Status

The default `run` path is Rust-only. The old TypeScript foreground runtime and private TypeScript
bridge-client copy have been removed from the repository.

Remaining work should extend the Rust modules above rather than reintroducing compatibility
packages.

## 12. Final Principle

```text
Backend owns platform truth.
BridgeSession owns transport.
BridgeRuntime owns orchestration.
RuntimeAdapter owns agent protocol differences.
Loopback owns MCP/resource transport.
Supervisor owns local process lifecycle.
```

This keeps the local daemon stack understandable while allowing the connector runtime to become fully
Rust without turning the daemon into a monolithic agent implementation.
