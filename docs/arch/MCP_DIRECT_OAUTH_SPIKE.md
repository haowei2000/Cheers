# Direct HTTP MCP OAuth Spike

Status: **implemented harness; macOS matrix pending interactive execution**  
Baseline: `origin/develop@0bc173ce` (merged PR #504)  
Decision gate: all four Agents and both OAuth modes must pass before Cheers MCP
may switch from the local stdio sidecar to mandatory direct HTTP.

## Question and security boundary

The spike asks whether an ACP Agent can connect directly to the Cheers Gateway:

```text
Connector ── ACP over local stdio ──▶ Agent ── HTTP MCP + OAuth ──▶ Gateway
```

There is no Connector MCP proxy and no static `Authorization` header in
`session/new`. The Agent must discover OAuth from the Gateway, own its token
lifecycle, recover after restart, and stop working immediately after its
terminal installation is revoked. The Agent never gains more Cheers authority
than the selected installation's Bot, scopes, channel membership and role.

The harness does not weaken the Gateway's CIMD SSRF checks. Authorization Code
clients must publish a real public HTTPS Client ID Metadata Document. A localhost
client id, Dynamic Client Registration attempt, missing user-facing authorization
URL, or private adapter patch is an incompatibility result—not a reason to add a
test bypass.

## Pinned matrix

The versions come from the ACP registry snapshot inspected on 2026-08-13. Use an
explicit command override only to reproduce a known local version; record the
override in the evidence.

| Agent | Registry version | ACP command | Interactive | Client credentials |
|---|---:|---|---|---|
| Codex | 1.2.0 | `npx -y @agentclientprotocol/codex-acp@1.2.0` | pending | pending |
| Claude | 0.66.0 | `npx -y @agentclientprotocol/claude-agent-acp@0.66.0` | pending | pending |
| Gemini | 0.55.1 | `npx -y @google/gemini-cli@0.55.1 --acp` | pending | pending |
| OpenCode | 1.18.18 | `npx -y opencode-ai@1.18.18 acp` | pending | pending |

The local machine initially had Codex ACP 1.1.9, Gemini CLI 0.41.2 and OpenCode
1.18.11; Claude ACP was absent. These local versions are not used as passing
evidence unless supplied explicitly via `CHEERS_SPIKE_AGENT_COMMAND_JSON`.

## Running the spike

First run the capability phase; it does not start a Gateway or call a model:

```bash
CHEERS_SPIKE_AGENT_ID=codex \
CHEERS_SPIKE_PHASE=capability \
node scripts/mcp-direct-oauth-agent-probe.mjs
```

Preview the complete eight-case matrix without side effects:

```bash
scripts/run-mcp-direct-oauth-matrix.sh --dry-run
```

Run one isolated end-to-end case and retain only redacted artifacts:

```bash
scripts/run-mcp-direct-oauth-spike.sh \
  --agent codex \
  --mode interactive \
  --phase full \
  --keep-artifacts
```

Interactive cases start the real Frontend consent surface. If the Agent emits an
authorization URL, open it, log in as the temporary admin and select the matching
installation. A public HTTPS CIMD is still mandatory; a purely local CIMD is
correctly rejected.

ACP URL elicitation is advertised by the probe and recorded separately. Set
`CHEERS_SPIKE_ACCEPT_ELICITATION_URL=1` only after reviewing the displayed host;
that accepts navigation, not Cheers consent and not completion of OAuth. Form
elicitation is deliberately unsupported because secrets must never be collected
through a form.

For client credentials, configure only a documented Agent credential provider:

```bash
CHEERS_SPIKE_AGENT_ENV_JSON='{"VENDOR_DOCUMENTED_SETTING":"..."}' \
scripts/run-mcp-direct-oauth-spike.sh \
  --agent gemini \
  --mode client-credentials \
  --phase full \
  --keep-artifacts
```

Use `{{installation_id}}` and `{{installation_credential}}` as values where the
documented provider needs the case-specific credentials. The harness substitutes
them only after creating the isolated installation, passes them to the Agent
process, and never writes the resolved JSON to evidence.

The harness deliberately has no generic mapping from installation credential to
Agent environment. If an Agent has no supported provider capable of consuming
installation ID/credential and requesting `/oauth/token`, record
`unsupported_client_credentials`; do not pass secrets through an invented env.

Each case creates a disposable PostgreSQL container, Gateway, Frontend, Bot,
installation, workspace and channel. It then:

1. checks `mcpCapabilities.http`;
2. sends `session/new` with URL and empty headers;
3. asks the real model to call `get_channel_info` and `post_message`;
4. waits 620 seconds and repeats the prompt to cross the ten-minute access-token TTL;
5. restarts the ACP process and verifies token-state recovery;
6. revokes the installation and requires the next direct MCP attempt to fail;
7. checks the durable channel message and OAuth rows server-side;
8. deletes the container and temporary secrets.

Use `CHEERS_SPIKE_AUTO_APPROVE=1` only on the disposable spike workspace. It
selects an Agent-provided allow option for ACP tool execution; it does not approve
Cheers OAuth consent.

## Evidence and classification

`result.json`, restart/revocation results and `assertions.json` are safe to retain
after automatic redaction. Gateway/Frontend logs are sanitized on cleanup. The
private JWT key, installation credential, access token, refresh token,
authorization code and PKCE verifier must never appear in committed evidence.

Classify failures as one of:

- `missing_http_capability`
- `oauth_discovery_not_started`
- `no_user_authorization_surface`
- `cimd_incompatible`
- `unsupported_client_credentials`
- `tool_call_not_observed`
- `token_refresh_failed`
- `restart_recovery_failed`
- `revocation_not_enforced`
- `agent_model_auth_unavailable`
- `harness_environment_failure`

An Agent passes only when both its interactive and client-credentials cases
complete the full sequence. Establishing an HTTP connection or successfully
running `session/new` alone is not a pass.

## Current observations

- The harness unit tests pass for redaction, command pinning, dry-run isolation
  and refusal to inject undocumented credentials.
- Real ACP `initialize` on macOS passed `mcpCapabilities.http=true` for all four
  pinned versions: Codex 1.2.0, Claude 0.66.0, Gemini 0.55.1, and OpenCode
  1.18.18. This clears only the capability gate; none of the eight OAuth rows is
  marked passed until its complete lifecycle succeeds. The redacted structured
  snapshot is in
  [`evidence/MCP_DIRECT_OAUTH_CAPABILITIES_2026-08-13.json`](evidence/MCP_DIRECT_OAUTH_CAPABILITIES_2026-08-13.json).
- A real isolated Codex 1.2.0 `session/new` accepted the headerless Cheers HTTP
  `McpServerHttp` and returned a session ID. No OAuth discovery occurred during
  session creation; that is expected to be evaluated by the full prompt/tool
  phase and is not an OAuth pass.
- A sandboxed Codex ACP 1.1.9 capability attempt could not initialize its SQLite
  state under `~/.codex`; this is classified as `harness_environment_failure`,
  not an OAuth compatibility result. The real matrix needs normal access to each
  Agent's existing local configuration directory.
- No default Connector transport has changed. `inject_cheers=true` remains the
  production behavior until the complete matrix passes.

## Decision

If all eight cases pass, open a separate implementation change for mandatory
HTTP Cheers MCP, trusted canonical endpoint advertisement, remote
`read_workspace`, and removal of `inbox_stage`/the stdio sidecar. If any case
fails, keep stdio as default and decide from the evidence whether to add a public
OAuth lifecycle to that ACP adapter or design a Connector-owned OAuth proxy.
