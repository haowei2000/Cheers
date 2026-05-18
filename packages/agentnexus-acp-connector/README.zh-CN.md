# @haowei0520/acp-connector

> **语言**：中文 | [English](README.md)

Runs local ACP stdio agents, such as Codex or Claude-compatible agents, and
reverse-connects them to a public AgentNexus server through the existing Agent
Bridge WebSocket protocol.

```json
{
  "accounts": {
    "codex-main": {
      "botToken": "agb_xxx",
      "controlUrl": "wss://agentnexus.example.com/ws/agent-bridge/control",
      "dataUrl": "wss://agentnexus.example.com/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "codex-acp",
        "args": [],
        "cwd": "/Users/me/project",
        "env": {
          "OPENAI_API_KEY": "$OPENAI_API_KEY"
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
agentnexus-acp-connector start --config ./agentnexus-acp.json --name codex-main
agentnexus-acp-connector status --name codex-main
agentnexus-acp-connector logs --name codex-main --lines 200
agentnexus-acp-connector restart --name codex-main
agentnexus-acp-connector stop --name codex-main
```

From a source checkout, the same commands can be run through npm:

```bash
npm run daemon:start -- --config ./agentnexus-acp.json --name codex-main
npm run daemon:status -- --name codex-main
npm run daemon:logs -- --name codex-main
npm run daemon:stop -- --name codex-main
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
    "username": "codex-main",
    "bridge_provider": "acp",
    "account_username": "alice",
    "account_password": "password",
    "agent_id": "codex-main",
    "scope": "private"
  }'
```

2. Save the returned `data.acp_connector_config` as a local JSON file. Edit only
   the local ACP agent command, workspace, and environment values, for example:

```json
{
  "accounts": {
    "codex-main": {
      "botToken": "agb_xxx",
      "controlUrl": "ws://localhost:8000/ws/agent-bridge/control",
      "dataUrl": "ws://localhost:8000/ws/agent-bridge/data",
      "agent": {
        "transport": "stdio",
        "command": "codex-acp",
        "args": [],
        "cwd": "/Users/me/project",
        "env": {
          "OPENAI_API_KEY": "$OPENAI_API_KEY"
        }
      }
    }
  }
}
```

3. Start the connector from the local machine that can run Codex/Claude:

```bash
agentnexus-acp-connector start --config ./agentnexus-acp.json --name codex-main
```

4. Add the Agent Bridge bot to a channel or DM in AgentNexus, then send
   `@codex-main hello`. The connector receives the AgentNexus dispatch frame,
   calls the local ACP agent over stdio, and streams `delta`/`done` frames back
   through the existing Agent Bridge WebSocket.

## Receiving AgentNexus files

When a user message in AgentNexus includes attachments, the bridge dispatch
sends file metadata to the connector. The connector then uses the bot token to
hydrate the files on demand:

- document/text attachments call
  `GET /api/v1/agent-bridge/files/{file_id}/content` and are sent to ACP as
  `resource` content blocks when the agent declares `embeddedContext`
  capability;
- image attachments call
  `GET /api/v1/agent-bridge/files/{file_id}/binary` and are sent to ACP as
  `image` content blocks when the agent declares `image` capability;
- when a capability is missing or hydration fails, the connector falls back to
  the filename and summary metadata in a text block.

This matches `codex-acp` 0.14.0, which declares both `image` and
`embeddedContext` prompt capabilities during ACP initialization.

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

Some ACP agents, including `codex-acp`, may create a local file and mention it
in the final text instead of emitting a structured `resource` block. As a
compatibility fallback, the connector also scans the final ACP text for
Markdown links or `file://` links that point inside `agent.cwd` and uploads
newly-created/modified files as AgentNexus attachments.

If the ACP agent needs to create or modify files before returning them, set
`agent.permissionMode` intentionally. The default is `reject`; use `allow` only
for a trusted local workspace.

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
