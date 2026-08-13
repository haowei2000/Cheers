# Cheers MCP Server (deprecated stdio compatibility process)

> **Deprecated:** this connector-owned stdio child process is retained only for
> compatibility with ACP agents that cannot yet consume the Cheers remote HTTP
> MCP endpoint. Do not add new capabilities here; migrate clients to the
> stateless `POST /mcp` endpoint using protocol `2026-07-28`.

Local stdio MCP server for ACP agents, implemented as a Rust binary. It
exposes Cheers channel resources as MCP tools and forwards each call to the
CCE ACP connector through a loopback resource endpoint.

## Build

```bash
cd packages/cheers-mcp-server
cargo build
```

The binary name is `cheers-mcp-server`.

## Runtime

When the deprecated `inject_cheers` compatibility option is enabled, the
connector starts this server as an MCP child process and injects:

- `CHEERS_RESOURCE_URL`: connector loopback endpoint that accepts resource calls.
- `CHEERS_RESOURCE_TOKEN`: optional bearer token for the connector loopback endpoint.
- `CHEERS_BOT_ID`: optional diagnostic bot id.
- `CHEERS_SESSION_ID`: optional platform session id for correlation only.
- `CHEERS_REQUEST_TIMEOUT_MS`: optional per-call timeout, default `30000`.

## Tools

Read-only tools:

- `get_channel_info`
- `list_members`
- `read_messages`
- `messages_index`
- `messages_by_seq`
- `read_activity`
- `get_context`
- `list_files`
- `read_file`
- `fs_ls`
- `fs_read`

Membership-role-gated write tools:

- `post_message`
- `create_file`
- `fs_write`
- `fs_edit`
- `fs_append`
- `fs_rm`
- `fs_mv`

`channel_id` is required on channel-scoped tools because one MCP server process
is shared across agent sessions. Server-side channel membership role checks
still apply.

## Resources

The server advertises MCP Resources in addition to tools:

- `resources/list` returns a built-in resource guide.
- `resources/templates/list` describes channel information, members, messages,
  context, plan, sessions, usage, attachments, and desk-file URI templates.
- `resources/read` resolves `cheers://channel/...` URIs through the same gateway
  resource handlers and authorization checks used by tools.

Examples:

```text
cheers://channel/{channel_id}/messages?limit=50&since_seq=100
cheers://channel/{channel_id}/files/{file_id}?as_base64=true
cheers://channel/{channel_id}/desk/reports/weekly%20summary.md
```

The stdio server negotiates initialize-based MCP revisions through
`2025-11-25`. A `2026-07-28` client can use the standard discovery fallback to
the legacy initialize flow; modern stateless `server/discover` support belongs
to the remote HTTP MCP endpoint rather than this connector-owned stdio process.

## Remote HTTP endpoint

The Cheers gateway exposes the modern stateless endpoint at `POST /mcp` for
protocol `2026-07-28`. It implements `server/discover`, Resources, Tools,
Prompts, Completion, request-scoped Progress, and multimodal content; every
successful result has `resultType`, `ttlMs`, and `cacheScope`. There is no
`initialize` handshake or server-side MCP session. The frozen OAuth scope and
Tool mapping is documented in
`docs/arch/MCP_HTTP_OAUTH_TOOL_SCOPE.md`.

Unattended Agent terminals authenticate at `POST /oauth/token` with their
installation id and installation credential. Interactive public clients use
Authorization Code + PKCE S256 and Client ID Metadata Documents. Every MCP
request revalidates the active installation and current credential hash, so
rotation, revocation, or disabling the Bot invalidates outstanding access tokens
immediately. Bot credentials are not accepted by either `/oauth/token` or `/mcp`.

RFC 9728 metadata is available at
`/.well-known/oauth-protected-resource` (and the path-derived `/mcp` alias).
Production must set `MCP_PUBLIC_URL=https://<public-host>/mcp`; this exact value
is returned as `resource` and enforced as the access-token audience.

`CHEERS_MCP_CONFORMANCE_FIXTURES=1` enables the exact fixtures used by the
official full server conformance runner. This switch is test-only and must
remain unset in production. The endpoint remains authenticated when it is on.

## Security boundary

- A `cheers://` URI is only an identifier. Every read is forwarded to a fixed
  connector loopback endpoint and authorized again by the gateway against the
  bot's current channel membership; the URI cannot expand the bot's access.
- Resource URIs are length-bounded and reject userinfo, ports, fragments,
  unknown or duplicate query parameters, control characters, and oversized
  workspace paths.
- URI input never selects an arbitrary HTTP destination, preventing the
  Resources surface from becoming an SSRF proxy.
- Binary attachment reads retain the gateway's 8 MiB inline cap. Active content
  types such as HTML and SVG are downgraded to inert MIME types before reaching
  an MCP host UI.
- Internal database and storage failures remain opaque to the agent; detailed
  errors are logged only in the gateway.
