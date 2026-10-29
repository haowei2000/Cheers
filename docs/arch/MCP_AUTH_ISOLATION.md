# MCP Authorization and Channel Isolation

Status: **plan agreed 2026-10-29; M1 (credential gateway) in progress**
Scope: the HTTP MCP endpoint (`POST /mcp`), its OAuth surface, and the
connector path that hands MCP credentials to ACP Agents.
Related: [MCP_HTTP_OAUTH_TOOL_SCOPE](./MCP_HTTP_OAUTH_TOOL_SCOPE.md) ·
[MCP_DIRECT_OAUTH_SPIKE](./MCP_DIRECT_OAUTH_SPIKE.md) ·
[ACP_ELICITATION](./ACP_ELICITATION.md) ·
[MCP_AGENT_SECURITY](./MCP_AGENT_SECURITY.md) (⚠️ its §1 stdio-sidecar topology is superseded by this document)

## 1. Principles

1. **Stateless MCP, per-request authorization.** The endpoint keeps no
   session. Every POST carries a bearer token, and the Gateway re-validates it
   — signature, live host status, scope, channel — on each request.
2. **We compute authority before the task; Agents do not ask for it.** Most
   ACP Agents cannot run MCP OAuth themselves and none re-authorize on a
   mid-call `insufficient_scope`. Authority is minted on our side and injected.
3. **Authority is an intersection and only narrows.**
   `bot role ∩ sender role ∩ token scope ∩ token channel ∩ live task`.
   Acting on behalf of someone can only remove access, never add it.
4. **Isolation is per boundary, not per token.** MCP, Agent memory, host
   filesystem and bot-global state each need their own channel boundary; a
   narrowed token protects only the first.

## 2. Architecture

```text
 User U posts in channel C, mentioning the bot
          │
          ▼
 ┌──────────── Cheers Gateway (OAuth AS + MCP resource server) ───────────────┐
 │ dispatcher ── task_dispatch(task T, channel C, sender U, [task_grant]) ──► │ Bridge
 │                                                                            │
 │ POST /oauth/token                                                          │
 │   client_credentials (today)        → token{bot, chan=C}                   │
 │   token-exchange + task_grant (P2/3) → token{sub=U, act=bot, chan=C, task=T}│
 │                                                                            │
 │ POST /mcp (stateless), every request:                                      │
 │   1 JWT signature / audience   2 host status (live lookup, revocable)      │
 │   3 protocol headers + _meta   4 tool scope (registry.rs)                  │
 │   5 chan == call channel_id    6 task still running (P2)                   │
 │   7 bot ∩ U role (P3)                                                      │
 │   → resource_req → resource/ (channel-role authz) → Postgres / S3          │
 │   ✗ → actionable tool error (P1)                                           │
 │                                                                            │
 │ request_approval (P4) → approval card to U → one-time approval_id          │
 └────────────────────────────────────────────────────────────────────────────┘
          ▲ Bridge (WS)                                    ▲ HTTP MCP + Bearer
          ▼                                                │
 ┌────────── host ─────────────────────────────────────────┼─────────────────┐
 │ connector                                                │                 │
 │   holds the long-lived host credential (never given      │                 │
 │   to the Agent); mints short-lived tokens per channel    │                 │
 │   (P2: per task)                                         │                 │
 │   credential gateway (M1): Agent gets 127.0.0.1 + local  │                 │
 │   secret; connector swaps in the real token per request  │                 │
 │   relays ACP elicitation / permission → asks only U      │                 │
 │        │ ACP (stdio)                                     │                 │
 │        ▼                                                 │                 │
 │   ACP Agent (Claude / Codex / Gemini / OpenCode) ──► gateway ──┘           │
 │   ACP session keyed by (channel, bot)                                      │
 └────────────────────────────────────────────────────────────────────────────┘
```

Code anchors:

| Concern | Location |
|---|---|
| MCP endpoint, auth, channel narrowing | `server/src/api/mcp.rs` (`mcp_http`, `authenticate_mcp`, `enforce_channel_scope`) |
| Tool ↔ scope registry | `packages/cheers-mcp-server/src/registry.rs` |
| Channel-scope mode | `MCP_CHANNEL_SCOPE` = `off` \| `warn` \| `enforce` (`server/src/config.rs`) |
| Token minting and cache | `packages/cheers-acp-connector-rs/src/mcp_token.rs` |
| Per-turn credential injection | `bridge_runtime/mod.rs` `ensure_acp_session`, `bridge_runtime/prompt.rs` |
| ACP session key | `server/src/domain/sessions.rs` (`cheers:channel:{channel}:bot:{bot}`) |
| Elicitation relay | `bridge_runtime/elicitation.rs` |

## 3. Credential delivery

### 3.1 Why the connector mints the token

The MCP specification's machine-to-machine path is the OAuth
`client_credentials` grant (SEP-1046). The spec assumes the MCP client is the
OAuth client. In ACP the two roles are split:

- the **Agent** speaks MCP but is a third-party binary we cannot change;
- the **connector** is the enrolled OAuth client (host id = `client_id`, host
  credential = `client_secret`) and is the only party that knows which channel
  and task each turn belongs to.

So the connector mints and the Agent spends. The long-lived secret never leaves
the connector, and each token is narrowed to one channel, which an Agent doing
its own OAuth could not achieve.

### 3.2 When the token is injected

ACP offers exactly one channel for MCP configuration: `mcpServers` on
`session/new` and `session/load`. `session/prompt` has no such field.

- The connector calls `session/load` with freshly minted `mcpServers`
  immediately before every `session/prompt`, so each turn carries a current
  token. This is the per-prompt injection point and the hook for task-bound
  tokens (P2).
- The token must **never** be placed in prompt content: that puts it in the LLM
  context, where any prompt injection in the channel can exfiltrate it.
- `session/prompt` `_meta` is not a standard credential carrier; Agents ignore
  it.
- **Verified 2026-10-29 (§3.4.4): not every Agent re-reads headers.** Codex
  (codex-acp 2.3.0) keeps the first header for a live session, so after the
  connector rotates the token Codex keeps sending the old one and starts
  failing once it expires. Header injection is therefore not a correct
  long-running design; the credential gateway (§3.4.2) replaces it.

### 3.3 Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Agent runs MCP OAuth itself | Spike result: unreachable for most Agents (needs a public CIMD and a consent round-trip); also yields one bot-wide token, not one per channel |
| URL-mode elicitation to authorize access to Cheers | The MCP spec forbids it ("MUST NOT rely on URL mode elicitation to authorize users for themselves"); the loopback `redirect_uri` on the host is unreachable from the user's browser; Agent support is sparse |
| Token in prompt content | Leaks into LLM context |
| SDK `agent-client-protocol-polyfill` as the universal path | It re-exports over loopback HTTP but speaks only MCP 2026-07-28 with no fallback; Codex and OpenCode use older MCP revisions, so it covers only Claude today |
| A Cheers-specific ACP extension for credential callbacks | Unnecessary once MCP-over-ACP lands; per-session `serverId` already scopes authority without new wire fields |

Residual risk of header injection: the bearer is visible to the Agent process
(not the LLM context), and Agents that ignore refreshed headers break after
expiry. §3.4 removes both.

### 3.4 Client-held credentials

General principle, not specific to Cheers: **the Agent decides what to call;
the ACP client decides whether, and with which credential.** Credentials
for tool execution live with the client; the Agent is an untrusted executor.

Delivery strength, strongest first:

| Level | Mechanism | Agent sees a credential? |
|---|---|---|
| L0 execute at client | Tool calls return to the client over ACP; the client attaches its credential and forwards, or executes locally | Never |
| L1 sign at client | Client signs each request (e.g. DPoP) | One signed request at a time |
| L2 lend short-lived | Agent asks the client for a short-lived token | Yes, briefly |
| L3 static injection | `mcpServers[].headers` (today) | Yes, for the token lifetime |

Two mechanisms deliver this, chosen per Agent (§3.5):

#### 3.4.1 Selection

| Agent advertises (ACP `initialize`) | Mechanism |
|---|---|
| `mcpCapabilities.acp == true` | Native MCP-over-ACP (§3.4.3) |
| `mcpCapabilities.http == true` | Credential gateway pass-through (§3.4.2) |
| neither | Cheers MCP not offered; the host profile and MCP check show why |

The ACP `protocolVersion` (1 for every Agent tested) says nothing about the
Agent's MCP revision; ACP and MCP negotiate independently. The gateway does not
need to know it, because it does not parse MCP.

#### 3.4.2 Credential gateway (current universal path, M1)

A loopback HTTP endpoint inside the connector:

```text
Agent ──HTTP, any MCP revision──► 127.0.0.1:<port>/mcp   (connector)
        Authorization: Bearer <local per-session secret>
                                   │ secret → session → channel
                                   │ swap in the real Cheers token (rotated freely)
                                   ▼
                              POST https://<gateway>/mcp
```

- **Pass-through, not an MCP implementation.** Body and MCP headers
  (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Accept`,
  `Content-Type`) are forwarded unchanged; only `Authorization` is replaced.
  2025-06-18, 2025-11-25 and 2026-07-28 clients all work, because `/mcp` serves
  every era statelessly. JSON and SSE responses stream back unchanged.
- **The Agent's credential never changes during a session**, so Agents that
  ignore refreshed headers (Codex) keep working. Token rotation happens inside
  the connector, which also allows a TTL of minutes.
- **The local secret is worthless off-host**: 32 random bytes, per ACP
  session, header-only (never in the URL), compared in constant time, and
  bound to one channel. The listener binds loopback only, rejects a
  non-loopback `Origin`, caps the body at the gateway's limit, and answers
  `GET`/`DELETE` with 405 itself.
- **Upstream 401** invalidates the cached token for that channel, re-mints once
  and retries; a second 401 is returned to the Agent.
- **Observation point**: every MCP request passes through, so the gateway records
  the revisions and behaviours each Agent actually uses (§3.5).
- Rollout: config flag, default off in the first release; default on once the
  Agent matrix passes; then header injection is deleted (M4).

#### 3.4.3 Native MCP-over-ACP (future path, M6)

The ACP [MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp)
(Active since 2026-10) is the standard L0 binding:

- The Agent advertises `agentCapabilities.mcpCapabilities.acp`; the client
  declares `{ "type": "acp", "name": "cheers", "serverId": … }` in
  `session/new`.
- Calls arrive at the client as `mcp/message` (`serverId`, `requestId`, inner
  MCP `method`/`params`), request-scoped and session-less like MCP 2026-07-28.
- SDK 3.6 provides the types and `SessionBuilder::with_mcp_server` for
  `session/new`; v1 `session/load` has no per-session attachment helper, so the
  connector declares `{type:"acp", serverId}` on load itself.

Cheers design on top of it:

- **One `serverId` per ACP session** (the RFD: "distinct offerings use distinct
  server IDs"). The registration is bound to the session's channel, so the
  connector knows which channel a call belongs to without any new wire field.
- **Turn binding is Cheers-internal.** ACP runs one prompt per session at a
  time, so the connector attributes a call to the session's active prompt
  (task) and rejects calls that arrive after the turn ends. This is a Cheers
  need — per-turn senders in multi-user channels — not a protocol gap.
- The connector forwards to `POST /mcp` with a token it never hands out. That
  allows a TTL of minutes instead of 24h, DPoP later, and approvals (§6) at the
  connector.
- The RFD schema is still unstable ("must be released … before publication"),
  and no tested Agent advertises `acp: true` yet; this path switches on per
  Agent through negotiation (§3.5) when one does.

Upstream engagement:
[discussion #2584](https://github.com/orgs/agentclientprotocol/discussions/2584)
asks to confirm per-session `serverId` as the intended way to scope authority,
and offers a non-normative "credential-holding providers" Security note, Rust
SDK help and adapter support for `mcpCapabilities.acp`.

#### 3.4.4 Agent interop matrix (2026-10-29)

Probed locally without any model call: `initialize`, `session/new` with an HTTP
MCP server, then `session/load` with a changed `Authorization` header.

| Agent | `mcpCapabilities` | MCP client revision | Re-reads headers on `session/load` |
|---|---|---|---|
| Claude (claude-agent-acp 0.99.0, Claude Code 2.1.312) | `http`, `sse` | tries 2026-07-28 (`server/discover`), falls back to 2025-11-25 | yes |
| Codex (codex-acp 2.3.0, codex-mcp-client 0.164.0) | `http`, `acp: false` | 2025-06-18 only | **no** |
| OpenCode 1.19.4 | `http`, `sse` | 2025-11-25 only | yes |
| Gemini CLI 0.65.0 | `http`, `sse` | not reached: `session/new` refused by the provider ("no longer supported for Gemini Code Assist for individuals") | — |

### 3.5 Host profile and mode negotiation

Facts about a host's connector and Agent are recorded so the mechanism can be
chosen, explained and upgraded. **They choose a compatibility mode; they never
grant authority** — `agentInfo` and MCP `clientInfo` are self-reported.

| Kind | Examples | Written by | Stored in |
|---|---|---|---|
| Declared (handshake, overwritten each connect) | host kind (desktop/daemon/container), OS/arch, headless; connector version and supported delivery modes; Agent name/version, ACP version, `mcp{acp,http,sse}`, `loadSession`, `authMethods` | connector `ready` frame | `connector_hosts.capabilities.profile` (`schema: 1`) |
| Observed (accumulated) | MCP revisions seen, tries `server/discover`, re-reads headers on load | `/mcp` and the credential gateway | `connector_hosts.observed_profile` (new JSONB) |
| Chosen mode | `acp` \| `gateway` \| `header` | connector | `connector_hosts.mcp_delivery_mode` (new column) |

- The profile is per **host**, not per bot: it describes one machine's connector
  and Agent, and a re-paired host starts fresh. A bot reads its active host's
  profile. ("Installation" is reserved for provider installs; see migration
  0088.)
- The `HostProfile` struct lives in `bridge-protocol` so server and connector
  share one definition (`#[serde(default)]` fields, explicit `schema`).
- **Policy is separate from facts**: allowed delivery modes are bot
  configuration, sent in the hello `server_capabilities`. The connector picks
  the strongest mode allowed by policy and supported by the Agent, re-evaluated
  on every connect.
- Record only versions, capabilities and modes — no paths, environment or
  credentials.

## 4. Channel isolation (cross-channel leakage)

One bot often serves many channels at once. Each boundary below must hold
independently.

| Boundary | Status |
|---|---|
| MCP tools and resources | ✅ every channel-bearing call is compared with the token's `chan`; `resources/read` is checked too; `enforce` is the default |
| Agent conversation memory | ✅ ACP session per (channel, bot) |
| Host filesystem | ❌ `default_cwd` / `allowed_roots` are per host, not per channel; an Agent can write a file in channel A and read it in channel B without touching MCP |
| Bot-global state | ❌ `set_status` is channel-less and visible in every channel, so it can carry channel A content into channel B |
| `open_direct_message` | ⚠️ channel-less, but posting into the new DM is refused by narrowing; low risk |
| Deployment mode | ⚠️ `MCP_CHANNEL_SCOPE=off\|warn` disables narrowing entirely |

## 5. Delegated identity (acting for the sender)

Goal: a token that means "bot acting for user U in channel C during task T".

1. On dispatch the Gateway issues a one-time, short-lived, signed `task_grant`
   bound to task, sender, channel and host.
2. The connector exchanges it at `/oauth/token` with RFC 8693 token exchange,
   authenticating with its host credential. Either piece alone is useless.
3. The resulting JWT carries `sub = U`, `act = {sub: bot}`, `chan = C`,
   `task = T`, scope ⊆ the bot's scope, short TTL.
4. Resource authorization gains a delegated principal and checks **both**
   memberships, taking the intersection. A prompt-injected Agent acting for an
   admin still has no more than the bot's own rights, and the bot cannot reach
   what U cannot.
5. Each request also checks that the task is running, U is still a channel
   member, and U has not revoked the bot's standing delegation.

Tasks with no human sender (scheduled, autonomous) keep the plain bot identity.

## 6. Runtime approval and actionable errors

Agents do not obtain new authority mid-run, so the server must both refuse
clearly and offer a legitimate next step.

**Actionable errors.** Refusals are returned as `tools/call` results with
`isError: true` — never only as protocol errors, which most clients hide from
the model:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "[APPROVAL_REQUIRED] Writing desk/report.md needs the requesting user's approval.\nNext: call request_approval with {\"action\":\"desk_write\",\"path\":\"desk/report.md\"}, then retry with the returned approval_id.\nDo not retry without approval." }],
  "structuredContent": {
    "code": "APPROVAL_REQUIRED",
    "retryable": true,
    "next": { "tool": "request_approval", "arguments": { "action": "desk_write", "path": "desk/report.md" } }
  }
}
```

| code | Guidance to the model | retryable |
|---|---|---|
| `OUT_OF_CHANNEL` | This task can access only its own channel; ask the user to mention you there | no |
| `ROLE_REQUIRED` | Your channel role is insufficient; ask a channel admin | no |
| `APPROVAL_REQUIRED` | Call `request_approval`, then retry with `approval_id` | yes |
| `SCOPE_REQUIRED` | See below | no |
| `NOT_FOUND` | Stay opaque; never disclose whether a resource exists elsewhere | no |

Rules: the text is advisory and grants nothing (the server re-checks every
call); never echo other channels' names or ids; never interpolate user-supplied
text; mark non-recoverable errors `retryable: false` to prevent loops.

**Scope errors.** Authorization-code clients keep the spec's HTTP 403 +
`WWW-Authenticate: insufficient_scope` step-up challenge. Connector-minted
`client_credentials` tokens cannot step up, so for them the refusal becomes an
actionable tool error instead. This is a deliberate deviation from a SHOULD and
needs sign-off.

**`request_approval`.** It sends an approval card to the initiating user over
the existing Bridge/WS path and returns a pending `approval_id`. On approval the
Agent retries the original call with that id; the server checks it is bound to
the same task, action and arguments, and consumes it once. No new token is
issued, so MCP stays stateless — the approval lives in the database, bound to
user and task.

## 7. Status

| Item | Status |
|---|---|
| 2026-07-28 stateless protocol, legacy eras served statelessly, mirrored headers | ✅ (spec fixes in PR #799) |
| Host-bound tokens, host re-validated per request | ✅ |
| Channel-narrowed tokens, `enforce` default | ✅ |
| ACP session per channel | ✅ |
| Fresh token before every prompt via `session/load` | ⚠️ ignored by Codex (§3.4.4) |
| Credential gateway pass-through | 🚧 M1 |
| Host profile and mode negotiation | ❌ M2 |
| Native MCP-over-ACP | ❌ M6 (no Agent advertises `acp: true`; SDK 3.6 upgrade in PR #805) |
| Domain errors as `isError` tool results | ✅ (no next-step guidance) |
| Per-channel host working directory | ❌ |
| Channel-safe `set_status` | ❌ |
| `off` / `warn` locked out of production | ❌ |
| Task-bound tokens | ❌ (24h TTL only) |
| Delegated identity | ❌ |
| Actionable errors, `request_approval` | ❌ |

## 8. Roadmap

Each step is one PR. Order: M1 > M3 > M2 > M4 > M5 > M6; M3 and M4.1 can run
alongside M1.

| Milestone | Work | Touches |
|---|---|---|
| **M1 credential gateway** | Loopback pass-through (§3.4.2) with per-session secrets, Origin/body limits, 401 re-mint, SSE streaming; `native_cheers_mcp_server` hands out the local URL and secret behind a flag; unit tests plus the Agent matrix end-to-end, including Codex across a token rotation; connector release, then default on | connector |
| **M2 host profile** | `HostProfile` in `bridge-protocol`; `ready` reports profile, `mcp_acp` and `mcp_delivery_mode`; migration adds `observed_profile` and `mcp_delivery_mode`; `/mcp` and the gateway record observations; bot policy for allowed modes via hello; MCP check and Fleet show mode and warnings | connector, server, migration, frontend |
| **M3 isolation** | Per-channel cwd and `allowed_roots`; channel-scoped `set_status` or drop it from the default scope; refuse `MCP_CHANNEL_SCOPE=off\|warn` outside development | connector, server, mcp-server |
| **M4 guidance and tightening** | Actionable error shape (`code`, `retryable`, `next`) and tool-error scope refusals for `client_credentials` tokens; delete header injection; cut token TTL from 24h to minutes | server, connector |
| **M5 task, delegation, approval** | `task_grant` and `task` claim with per-request running-task check and turn attribution in the gateway; RFC 8693 exchange with `sub=U, act=bot` and role intersection; `request_approval` with one-time `approval_id`; optional DPoP upstream | server, connector, frontend, migration |
| **M6 native MCP-over-ACP** | Enable `unstable_mcp_over_acp` after #805; provider with one `serverId` per session, declared on `session/load` too; switch per Agent via M2 negotiation; help `claude-agent-acp` advertise `mcpCapabilities.acp` | connector, upstream |

Upstream, in parallel: share the §3.4.4 matrix on discussion #2584 after M1's
end-to-end run; send the Security-note PR if the RFD champion agrees.

## 9. Open decisions

1. Delegation consent: implicit (mentioning the bot) or explicit standing
   permission per bot? Recommended: explicit.
2. Bot-to-bot chains: delegate from the originating human with a depth limit,
   or fall back to bot identity? Recommended: originating human, bounded depth.
3. Revoke task-bound tokens the moment the task ends, or let them expire?
   Recommended: revoke on end via the per-request task check.
4. Return scope refusals for `client_credentials` tokens as tool errors instead
   of HTTP 403? Recommended: yes, documented as a deliberate deviation.

Decided 2026-10-29: the credential gateway is the universal path now and
native MCP-over-ACP the future path; the Codex header-refresh bug is fixed by
M1 rather than separately.
