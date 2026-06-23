# Cheers Agent Bridge Integration Guide

> **Language**: English | [中文](AgentBridge接入指南.zh-CN.md)

Agent Bridge lets external providers such as local ACP agents appear as Cheers Bots. A user mentions a Bot in a channel or DM; Cheers sends the task to the provider over WebSocket; the provider returns streaming text, final replies, and optional files.

> **OpenClaw deprecation notice**
>
> OpenClaw plugin links and package downloads in this guide are legacy/deprecated. New deployments should use `/acp-bridge` and migrate to a local ACP-capable agent installed from npm, such as Codex ACP, Claude Agent ACP, OpenCode, Gemini CLI, GitHub Copilot CLI, Qwen Code, Cline, Kilo Code, or pi ACP.

## Concepts

| Term | Meaning |
|---|---|
| Agent Bridge Bot | A Bot account with `binding_type=agent_bridge`. |
| Bot token | One-time plaintext token with prefix `agb_...`, used by the provider. |
| control WebSocket | `/ws/agent-bridge/control`, used for handshake, membership snapshots, join/leave events, heartbeat. |
| data WebSocket | `/ws/agent-bridge/data`, used for inbound messages, `delta`, `reply`, `done`, `error`, and file events. |

Default local variables:

```bash
export CHEERS_BASE_URL=http://localhost:8000
export CHEERS_WS_BASE=ws://localhost:8000
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

1. Open Cheers frontend.
2. Go to Manage -> Bot Management.
3. Create a Bot and choose **Agent Bridge Bot**.
4. Set `bridge_provider` to `acp` for local ACP agents. Use `openclaw` only for legacy OpenClaw deployments.
5. Save the returned `agb_...` token immediately.
6. Add the Bot to the channel where it should work.

Registration API:

```bash
curl -X POST "$CHEERS_BASE_URL/docs/agent-bridge/register" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "my-agent",
    "display_name": "My Agent",
    "bridge_provider": "acp",
    "account_username": "admin",
    "account_password": "<your-password>",
    "agent_id": "main",
    "scope": "private"
  }'
```

Save `data.bot.bot_token`, `data.bridge.control_ws`, and `data.bridge.data_ws`.

## OpenClaw Provider (Deprecated / Legacy)

The OpenClaw channel package is disabled and no longer maintained in this
repository. Existing deployments should migrate to `/acp-bridge` and a local
ACP-capable agent; new deployments must not use the old OpenClaw package path.

## ACP / OpenCode ACP Provider

Install:

```bash
cargo install --path packages/cheers-acp-connector-rs --locked
cce-acp-connector --help
```

Register an ACP Bot with `bridge_provider=acp`, save the token in an environment
variable, then configure the Rust connector with a local TOML policy file.

## Docker Compose OpenCode Bot

The Compose template includes an optional `opencode-bot` profile that seeds an
OpenCode Agent Bridge Bot and runs the Rust `cce-acp-connector` with
OpenCode ACP. OpenCode ACP declares image input and embedded-context support;
actual image understanding still depends on the configured model/provider.

In `.env`, set:

```bash
OPENCODE_BOT_ENABLED=true
OPENCODE_BOT_TOKEN=agb_<random-secret>
OPENCODE_OPENAI_API_KEY=<your-openai-compatible-key>
OPENCODE_OPENAI_BASE_URL=https://api.deepseek.com
OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=<model-name>
```

Then start it with:

```bash
docker compose --profile opencode-bot up -d --wait
```

`OPENCODE_BOT_TOKEN` must be the same value for the backend seed and the `opencode-bot` container. Generate one with `python -c "import secrets; print('agb_' + secrets.token_urlsafe(32))"`.

## Status and Debugging

```bash
curl -H "X-Agent-Bridge-Token: <AGENT_BRIDGE_TOKEN>" \
  "$CHEERS_BASE_URL/api/v1/agent-bridge/status"
```

Common WebSocket close codes:

| Code | Meaning | Action |
|---|---|---|
| `4401` | Invalid token | Rotate and copy the plaintext token again. |
| `4402` | Superseded connection | Only one provider instance should use a token. |
| `4403` | Bot unavailable | Check Bot status and `binding_type`. |

## Best Practices

- Treat `bot_token` as a secret.
- Store one provider account per Cheers Bot.
- Reconnect both control and data planes.
- Add the Bot to a channel before expecting messages.
- Use structured `error` events for provider failures.
