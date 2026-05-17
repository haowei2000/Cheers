# AgentNexus Agent Bridge Integration Guide

> **Language**: English | [中文](AgentBridge接入指南.zh-CN.md)

Agent Bridge lets external providers such as OpenClaw plugins or ACP connectors appear as AgentNexus Bots. A user mentions a Bot in a channel or DM; AgentNexus sends the task to the provider over WebSocket; the provider returns streaming text, final replies, and optional files.

## Concepts

| Term | Meaning |
|---|---|
| Agent Bridge Bot | A Bot account with `binding_type=agent_bridge`. |
| Bot token | One-time plaintext token with prefix `agb_...`, used by the provider. |
| control WebSocket | `/ws/agent-bridge/control`, used for handshake, membership snapshots, join/leave events, heartbeat. |
| data WebSocket | `/ws/agent-bridge/data`, used for inbound messages, `delta`, `reply`, `done`, `error`, and file events. |

Default local variables:

```bash
export AGENTNEXUS_BASE_URL=http://localhost:8000
export AGENTNEXUS_WS_BASE=ws://localhost:8000
```

Use `wss://` behind HTTPS reverse proxies.

## Enable Agent Bridge

In `.env`:

```bash
AGENT_BRIDGE_ENABLED=true
AGENT_BRIDGE_TOKEN=<shared-admin-debug-token>
AGENT_BRIDGE_TIMEOUT_SECONDS=600
```

`AGENT_BRIDGE_TOKEN` protects management/debug HTTP endpoints. Provider WebSocket connections use the per-Bot `agb_...` token.

## Create an Agent Bridge Bot

Recommended UI flow:

1. Open AgentNexus frontend.
2. Go to Manage -> Bot Management.
3. Create a Bot and choose **Agent Bridge Bot**.
4. Set `bridge_provider` to `openclaw`, `acp`, or another provider identifier.
5. Save the returned `agb_...` token immediately.
6. Add the Bot to the channel where it should work.

Registration API:

```bash
curl -X POST "$AGENTNEXUS_BASE_URL/docs/agent-bridge/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "my-agent",
    "display_name": "My Agent",
    "bridge_provider": "openclaw",
    "account_username": "admin",
    "account_password": "<your-password>",
    "agent_id": "main",
    "scope": "private"
  }'
```

Save `data.bot.bot_token`, `data.bridge.control_ws`, and `data.bridge.data_ws`.

## OpenClaw Provider

Install the public package:

```bash
npm pack @haowei0520/openclaw-channel-agentnexus@0.2.4 --pack-destination /tmp
openclaw plugins install /tmp/haowei0520-openclaw-channel-agentnexus-0.2.4.tgz
```

Then configure OpenClaw with the returned token and WebSocket URLs.

## ACP / Codex ACP Provider

Install:

```bash
npm install -g @haowei0520/acp-connector
agentnexus-acp-connector --help
```

Register an ACP Bot with `bridge_provider=acp`, save the token, then configure the connector with `controlUrl`, `dataUrl`, and your local ACP agent command.

## Status and Debugging

```bash
curl -H "X-Agent-Bridge-Token: <AGENT_BRIDGE_TOKEN>" \
  "$AGENTNEXUS_BASE_URL/api/v1/agent-bridge/status"
```

Common WebSocket close codes:

| Code | Meaning | Action |
|---|---|---|
| `4401` | Invalid token | Rotate and copy the plaintext token again. |
| `4402` | Superseded connection | Only one provider instance should use a token. |
| `4403` | Bot unavailable | Check Bot status and `binding_type`. |

## Best Practices

- Treat `bot_token` as a secret.
- Store one provider account per AgentNexus Bot.
- Reconnect both control and data planes.
- Add the Bot to a channel before expecting messages.
- Use structured `error` events for provider failures.
