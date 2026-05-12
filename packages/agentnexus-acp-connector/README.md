# @agentnexus/acp-connector

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
        "command": "codex",
        "args": ["acp"],
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
        "command": "codex",
        "args": ["acp"],
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
