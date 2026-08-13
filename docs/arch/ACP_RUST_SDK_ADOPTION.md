# Cheers ACP Connector 官方 SDK 迁移

> 状态：0.1.37 切换已实现（2026-08-13）；0.1.38 legacy 删除等待生产验收门。

## 决策

- 核心依赖为 `agent-client-protocol = "2.0.0"`，协议类型只通过主 crate 的
  `schema` re-export 使用。唯一支持的 wire 版本是 stable ACP v1；仅启用 SDK
  暴露 v1 Elicitation 类型所需的 `unstable_elicitation` 编译 feature，不启用
  ACP v2 或其他 `unstable_*` 能力。
- connector 只启动本地 stdio ACP agent。不引入远程 ACP HTTP/SSE/WebSocket、
  conductor、polyfill 或 MCP-over-ACP。
- 保留 Tokio 子进程层，以继续支持 `cwd`、`env_clear`、精确环境继承和 stderr
  管理；官方 SDK 负责 framing、JSON-RPC、batch、路由与 response correlation。
- SDK runtime 迁移本身不改变 connector TOML。Elicitation 的后续产品接线增加了
  Bridge frame、gateway resolve API 和 UI card，但复用现有 permission-request
  capability/RESPOND 权限，不扩大 fs/terminal 权限。

## 0.1.37 架构

`RuntimeAdapter` 是 lifecycle/session/config/auth 的 transport-neutral 接口；
`PromptClient` 是可克隆、可并发等待的 prompt 接口。`BridgeRuntime` 只持有
`Box<dyn RuntimeAdapter>`，测试可直接注入 fake。能力通过不可变
`AgentCapabilities` 快照读取，不再探测具体 adapter 类型。

认证选择、默认 client capabilities、permission option 转换等共享规则位于
`acp_semantics.rs`，official runtime 不依赖 legacy adapter。

official runtime 使用 stable-v1 SDK 类型构造 initialize、authenticate、session
new/load/prompt/cancel、mode 和 config request。`session/set_model` 只是兼容旧 agent
的扩展回退。MCP server 与 prompt content block 使用 typed envelope 加 opaque JSON
overlay，未知字段和 vendor `_meta` 不会被重塑。

入站 `session/update`、`session/request_permission`、`elicitation/create` 与
`elicitation/complete` 使用 `UntypedMessage`，未知
`sessionUpdate` 和 Codex/Claude `_meta` 原样中继。raw handler 只 claim 这四个方法；
`fs/*`、terminal 和其他 agent→client 方法继续落到标准 method-not-found，connector
不扩大本机权限。

Elicitation 的完整链路与 fail-closed 边界见
[ACP_ELICITATION.md](./ACP_ELICITATION.md)。

流式 delta/trace 在 `ActiveRun` 锁内只生成 frame，释放锁后才等待 bridge I/O，
因此 bridge 背压不会阻塞 permission 或终态处理。

## 切换与回滚

- `CHEERS_ACP_TRANSPORT=official|legacy`；缺省为 `official`。
- `CHEERS_ACP_RUNTIME` 在 0.1.37 兼容读取并记录弃用警告：旧值 `0`/`false`
  选择 legacy，其余非空值选择 official。新变量优先。
- 启动日志统一记录 `transport=official|legacy`。
- 0.1.37 发布后至少观察 7 天，完成 Codex/Claude × macOS/Linux smoke matrix，且
  没有未解决 P0/P1 runtime 回归，才允许发布 0.1.38。
- 0.1.38 才删除 hand-rolled JSON-RPC、framing、pending map、legacy requester、
  rollback selector 和临时环境变量。不要在验收门前提前删除。

## MCP 边界

当前继续逐字段注入 `cheers-mcp-server` stdio sidecar，loopback token、gateway
membership/role 校验和 capability signing 均保持不变。

Web MCP 是独立 RFC：gateway 若提供标准 MCP Streamable HTTP endpoint，优先用
`rmcp` 实现服务端，并只向声明 HTTP capability 的 agent 注入 `McpServer::Http`。
`agent-client-protocol-http` 是远程 ACP agent transport，不是 MCP server transport；
`agent-client-protocol-rmcp` 只在未来进程内 MCP/ACP proxy 场景评估。
验证清单见 [MCP_STREAMABLE_HTTP_SPIKE.md](./MCP_STREAMABLE_HTTP_SPIKE.md)。

验证范围必须包括短期凭证、bot/session/channel 绑定、撤销与过期、跨频道隔离、
断网行为、Codex/Claude HTTP MCP 兼容性、延迟和 sidecar 删除收益。

## 验证

每次 connector 行为变更必须同步版本和 lockfile，并执行：

```bash
cargo fmt --check
cargo test
cargo check
cargo build --release --locked
```

发布仍遵循项目规定的 tag、签名 `connector-manifest.json`、本机升级与 gateway
`CHEERS_CONNECTOR_RELEASE_VERSION` 顺序。
