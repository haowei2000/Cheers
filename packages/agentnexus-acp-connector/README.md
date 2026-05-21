# @haowei0520/acp-connector

> **Language**: English | [Chinese](README.zh-CN.md)

Runs local ACP stdio agents, such as OpenCode or Claude-compatible agents, and
reverse-connects them to a public AgentNexus server through the existing Agent
Bridge WebSocket protocol.

Use this package when AgentNexus is deployed on a server, but the ACP agent
must run on a developer workstation, private machine, or another environment
that can access local credentials and project files. The connector keeps a
reverse WebSocket connection to AgentNexus, starts the local ACP stdio process,
forwards user messages and attachments to the agent, and streams replies plus
generated files back to AgentNexus.

Key capabilities:

| Area | Behavior |
| --- | --- |
| Transport | Reverse-connects to AgentNexus over authenticated control/data WebSockets. |
| Sessions | Reuses provider session keys so channel/DM conversations keep ACP session context. |
| Inbound files | Sends parsed documents, images, and unsupported binary attachments to the ACP agent through the best available path. |
| Outbound files | Uploads ACP resource/file chunks and newly created local files back to AgentNexus. |
| Operations | Supports foreground runs and named daemon mode with local logs and status commands. |

```json
{
  "accounts": {
    "opencode-main": {
      "botToken": "agb_xxx",
      "controlUrl": "wss://agentnexus.example.com/ws/agent-bridge/control",
      "dataUrl": "wss://agentnexus.example.com/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "opencode",
        "args": ["acp", "--cwd", "/Users/me/project"],
        "cwd": "/Users/me/project",
        "env": {
          "OPENCODE_CONFIG_CONTENT": "$OPENCODE_CONFIG_CONTENT"
        }
      }
    }
  }
}
```

```bash
agentnexus-acp-connector --config ./agentnexus-acp.json
```

## npm CLI and daemon mode

Install from npm after the package is published:

```bash
npm install -g @haowei0520/acp-connector
npm list -g @haowei0520/acp-connector --depth=0
```

Upgrade an existing global install after a new npm release:

```bash
npm install -g @haowei0520/acp-connector@latest
agentnexus-acp-connector restart --name opencode-main
```

Install from this repository checkout:

```bash
npm install -g ./packages/agentnexus-bridge-client
npm install -g ./packages/agentnexus-acp-connector
```

Or run from the package source after building:

```bash
cd packages/agentnexus-acp-connector
npm install
npm run build
```

Foreground mode is useful for first-time debugging:

```bash
agentnexus-acp-connector run --config ./agentnexus-acp.json
# Backward-compatible:
agentnexus-acp-connector --config ./agentnexus-acp.json
```

Daemon mode keeps the connector running after the terminal exits. It writes a
PID file plus stdout/stderr logs under `~/.agentnexus/acp-connector/<name>/`.

```bash
agentnexus-acp-connector start --config ./agentnexus-acp.json --name opencode-main
agentnexus-acp-connector status --name opencode-main
agentnexus-acp-connector logs --name opencode-main --lines 200
agentnexus-acp-connector restart --name opencode-main
agentnexus-acp-connector stop --name opencode-main
```

From a source checkout, the same commands can be run through npm:

```bash
npm run daemon:start -- --config ./agentnexus-acp.json --name opencode-main
npm run daemon:status -- --name opencode-main
npm run daemon:logs -- --name opencode-main
npm run daemon:stop -- --name opencode-main
```

Use `AGENTNEXUS_ACP_HOME=/path/to/state` or `--home /path/to/state` to change
where daemon metadata and logs are stored.

## Local operation flow

1. Create or pick an AgentNexus user, then register an Agent Bridge bot with
   ACP metadata:

```bash
curl -X POST http://localhost:8000/docs/agent-bridge/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "opencode-main",
    "bridge_provider": "acp",
    "account_username": "alice",
    "account_password": "password",
    "agent_id": "opencode-main",
    "scope": "private"
  }'
```

2. Save the returned `data.acp_connector_config` as a local JSON file. Edit only
   the local ACP agent command, workspace, and environment values, for example:

```json
{
  "accounts": {
    "opencode-main": {
      "botToken": "agb_xxx",
      "controlUrl": "ws://localhost:8000/ws/agent-bridge/control",
      "dataUrl": "ws://localhost:8000/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "opencode",
        "args": ["acp", "--cwd", "/Users/me/project"],
        "cwd": "/Users/me/project",
        "env": {
          "OPENCODE_CONFIG_CONTENT": "$OPENCODE_CONFIG_CONTENT"
        }
      }
    }
  }
}
```

3. Start the connector from the local machine that can run OpenCode/Claude:

```bash
agentnexus-acp-connector start --config ./agentnexus-acp.json --name opencode-main
```

4. Add the Agent Bridge bot to a channel or DM in AgentNexus, then send
   `@opencode-main hello`. The connector receives the AgentNexus dispatch frame,
   calls the local ACP agent over stdio, and streams `delta`/`done` frames back
   through the existing Agent Bridge WebSocket.

## Receiving AgentNexus files

When a user message in AgentNexus includes attachments, the bridge dispatch
sends file metadata to the connector. The connector then uses the bot token to
hydrate the files on demand:

- parsable document/text attachments (`pdf`, `docx`, `xlsx`, `txt`, `md`,
  `html`) call
  `GET /api/v1/agent-bridge/files/{file_id}/content` and are sent to ACP as
  `resource` content blocks when the agent declares `embeddedContext`
  capability;
- image attachments call
  `GET /api/v1/agent-bridge/files/{file_id}/binary` and are sent to ACP as
  `image` content blocks when the agent declares `image` capability;
- other non-image attachments call
  `GET /api/v1/agent-bridge/files/{file_id}/binary`, are saved under
  `agent.cwd/.agentnexus/attachments/<task_id>/<file_id>/`, and are exposed to
  the ACP agent through a local `file://` resource plus prompt metadata;
- when a capability is missing or hydration fails, the connector falls back to
  the filename and summary metadata in a text block.

This matches OpenCode ACP, which declares both `image` and
`embeddedContext` prompt capabilities during ACP initialization.

Unsupported document types are intentionally not sent as large inline base64
prompt text. The local file handoff lets agents inspect, convert, unzip, or
otherwise process the original bytes with their own tools while keeping the ACP
prompt small. Downloaded inbound attachments are ignored by the output-file
scanner, so an agent echoing the local path will not upload the same input file
back to AgentNexus as a generated result.

Inbound attachment summary:

| Attachment type | Connector action | ACP-facing result |
| --- | --- | --- |
| `pdf`, `docx`, `xlsx`, `txt`, `md`, `html` | Fetch parsed text from `/content`. | `resource.text` when `embeddedContext` is available, otherwise a text block. |
| Images | Fetch bytes from `/binary`, or use inline `image_b64` when AgentNexus already supplied it. | `image` content block when the agent declares image support. |
| Other non-image files, such as `doc`, `xls`, `pptx`, `zip`, `csv`, `cad` | Fetch original bytes from `/binary` and write them under `agent.cwd/.agentnexus/attachments/...`. | Local `file://` resource plus a text block containing the path, MIME type, and size. |
| Hydration unavailable | Use metadata only. | Filename and summary fallback text. |

For unsupported binary files, the local saved path is intentionally inside
`agent.cwd`. This keeps ACP file access within the same workspace boundary used
for generated file uploads, and lets OpenCode or another ACP agent decide how to
inspect the file.

## Returning files

ACP `agent_message_chunk` updates can include file-like content. The connector
uploads those files to AgentNexus over the data WebSocket and attaches the
returned `file_id` to the final `done` or `reply` frame.

Supported content shapes:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": {
    "type": "resource",
    "resource": {
      "uri": "file:///Users/me/project/report.md",
      "mimeType": "text/markdown"
    }
  }
}
```

```json
{
  "sessionUpdate": "agent_message_chunk",
  "content": {
    "type": "resource",
    "resource": {
      "uri": "file:///tmp/report.md",
      "mimeType": "text/markdown",
      "text": "# Report\n\nGenerated by ACP."
    }
  }
}
```

Inline `text`, `blob`, `data_b64`, and `data:` base64 payloads are supported.
For `file://` URIs without inline content, the file must be inside the
configured `agent.cwd`; this avoids accidentally attaching unrelated local
files.

Some ACP agents, including OpenCode ACP, may create a local file and mention it
in the final text instead of emitting a structured `resource` block. As a
compatibility fallback, the connector also scans the final ACP text for
Markdown links or `file://` links that point inside `agent.cwd` and uploads
newly-created/modified files as AgentNexus attachments.

If the ACP agent needs to create or modify files before returning them, set
`agent.permissionMode` intentionally. The default is `reject`; use `allow` only
for a trusted local workspace.

## Troubleshooting

### Attachment says "currently only supports pdf/docx/xlsx/txt/md/html"

This usually means an older connector tried to read an unsupported document
through `/api/v1/agent-bridge/files/{file_id}/content`. Upgrade the npm package
and restart the daemon so unsupported non-image files are downloaded through
`/binary` and handed to the ACP agent as local files.

```bash
npm install -g @haowei0520/acp-connector@latest
agentnexus-acp-connector restart --name opencode-main
```

### The agent sees a local file path but cannot inspect it

Check that `agent.cwd` exists, is writable, and is the workspace the ACP agent
is allowed to read. Binary inbound attachments are written below:

```text
<agent.cwd>/.agentnexus/attachments/<task_id>/<file_id>/<filename>
```

If the ACP agent enforces tool permissions, allow file reads for that workspace
or adjust the connector/agent permission mode intentionally.

### The connector cannot hydrate a large binary file

The `/binary` bridge endpoint is bounded by the AgentNexus backend upload/read
limits. Very large files should be shared through an external link, reduced in
size, or handled through a custom backend-side parser.

### Verify which version is running

```bash
npm list -g @haowei0520/acp-connector --depth=0
npm view @haowei0520/acp-connector version
```

## Release

The real npm release is tag-driven by
`.github/workflows/release-acp-connector.yml`.

Prerequisite: configure the GitHub repository secret `NPM_TOKEN` with publish
permission for the public `@haowei0520` npm scope.

The workflow publishes packages in this order:

1. `@haowei0520/bridge-client`
2. `@haowei0520/acp-connector`

If the shared bridge client has changed in a way consumers need, bump
`packages/agentnexus-bridge-client/package.json` before tagging the connector.

Runtime changes in this connector are not available to npm users until
`@haowei0520/acp-connector` is published again. For connector-only changes,
such as attachment hydration behavior, bump and publish only
`@haowei0520/acp-connector`; do not bump `@haowei0520/bridge-client` unless its
public API or published package contents changed.

The repository keeps the connector dependency as
`"@haowei0520/bridge-client": "file:../agentnexus-bridge-client"` for local
development. During release, the workflow rewrites that dependency in the
published tarball to the bridge package version, for example `^0.1.0`, so npm
users can install the connector normally.

To release the connector:

```bash
cd packages/agentnexus-acp-connector
npm version patch --no-git-tag-version
cd ../..
VERSION=$(node -p "require('./packages/agentnexus-acp-connector/package.json').version")
git add packages/agentnexus-acp-connector/package.json packages/agentnexus-acp-connector/package-lock.json
git commit -m "chore: release ACP connector v${VERSION}"
git push origin develop
git tag "agentnexus-acp-connector-v${VERSION}"
git push origin "agentnexus-acp-connector-v${VERSION}"
```

The tag must exactly match the connector package version:

```text
agentnexus-acp-connector-v<package.json version>
```
