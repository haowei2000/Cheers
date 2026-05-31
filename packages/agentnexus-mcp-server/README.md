# AgentNexus MCP Server

Local stdio MCP server for ACP agents. It exposes AgentNexus channel resources as
MCP tools and forwards each call to the ACP connector through a loopback resource
endpoint.

## Runtime

The connector starts this server as an MCP child process and injects:

- `AGENTNEXUS_RESOURCE_URL`: connector loopback endpoint that accepts resource calls.
- `AGENTNEXUS_CHANNEL_ID`: default channel for channel-scoped tools.
- `AGENTNEXUS_BOT_ID`: optional diagnostic bot id.
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
- `read_memory`
- `fs_ls`
- `fs_read`

Grant-gated write tools:

- `post_message`
- `create_file`
- `update_memory`
- `fs_write`
- `fs_edit`
- `fs_append`
- `fs_rm`
- `fs_mv`

`channel_id` is optional on every tool. If omitted, the server uses
`AGENTNEXUS_CHANNEL_ID`. Server-side membership and Grant checks still apply.
