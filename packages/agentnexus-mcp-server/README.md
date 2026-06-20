# AgentNexus MCP Server

Local stdio MCP server for ACP agents, now implemented as a Rust binary. It
exposes AgentNexus channel resources as MCP tools and forwards each call to the
CCE ACP connector through a loopback resource endpoint.

## Build

```bash
cd packages/agentnexus-mcp-server
cargo build
```

The binary name is `agentnexus-mcp-server`.

## Runtime

The connector starts this server as an MCP child process and injects:

- `AGENTNEXUS_RESOURCE_URL`: connector loopback endpoint that accepts resource calls.
- `AGENTNEXUS_RESOURCE_TOKEN`: optional bearer token for the connector loopback endpoint.
- `AGENTNEXUS_CHANNEL_ID`: default channel for channel-scoped tools.
- `AGENTNEXUS_BOT_ID`: optional diagnostic bot id.
- `AGENTNEXUS_SESSION_ID`: optional platform session id for correlation only.
- `AGENTNEXUS_REQUEST_TIMEOUT_MS`: optional per-call timeout, default `30000`.

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

`channel_id` is optional on every tool. If omitted, the server uses
`AGENTNEXUS_CHANNEL_ID`. Server-side channel membership role checks still apply.
