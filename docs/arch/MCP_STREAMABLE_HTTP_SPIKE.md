# MCP Streamable HTTP 技术验证（非产品实现）

> 状态：待验证。该工作不阻塞 ACP official runtime 迁移，也不改变当前 stdio
> `cheers-mcp-server` 注入。

## 假设

gateway 提供标准 MCP Streamable HTTP endpoint，服务端优先直接基于 `rmcp`。
connector 只在 agent initialize 明确声明 MCP HTTP capability 时注入 ACP
`McpServer::Http`。`agent-client-protocol-http` 用于远程 ACP agent transport，不能
代替 MCP HTTP server；本验证不启用 `unstable_mcp_over_acp`。

## 安全验收

- 使用短期凭证，服务端绑定 bot、ACP session 和 channel；客户端参数不能扩大绑定。
- 每次调用重新执行 membership/role 与 capability 校验，覆盖撤销、过期和跨频道隔离。
- token 不进入日志、prompt 或长期 session metadata；断线与 gateway 不可达时 fail closed。
- Codex 与 Claude 分别验证 HTTP MCP discovery、调用、重连、取消和错误传播。

## 运行验收

记录 stdio sidecar 与 Streamable HTTP 的首调用/稳态延迟、连接数、内存、失败率、
离线行为和运维复杂度。只有在安全测试全部通过，且 sidecar 删除收益足以覆盖远程
依赖与凭证生命周期成本后，才能提交产品化 RFC；否则继续保留 stdio sidecar。

## 明确不在范围

- 远程 ACP HTTP/SSE/WebSocket agent transport；
- `agent-client-protocol-conductor`、polyfill；
- 进程内 MCP 或 ACP proxy（未来才可能评估 `agent-client-protocol-rmcp`）；
- 本验证期间删除 `cheers-mcp-server`。
