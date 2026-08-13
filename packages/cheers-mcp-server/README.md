# Cheers HTTP MCP contracts

This crate is a shared Rust library used by the Gateway. It owns the canonical
remote tool catalog, OAuth scope mapping, resource URI parsing, and translation
from public MCP tool calls to internal resource calls.

It intentionally has no binary target. ACP Agents receive the Gateway's
canonical HTTP MCP URL through `session/new` and perform native OAuth discovery,
consent, token storage, and refresh. The Connector does not start a local MCP
process and does not provide a stdio or OAuth-proxy fallback.

## Verify

```bash
cd packages/cheers-mcp-server
cargo fmt --check
cargo test --locked
cargo check --locked
```

The wire and OAuth contract is documented in
`docs/arch/MCP_HTTP_OAUTH_TOOL_SCOPE.md`.
