# MCP Authorization and Channel Isolation

Status: **plan agreed 2026-10-29, revised the same day to three delivery modes; M1 and M3 in review**
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
| MCP delivery mode | `policy.mcp.delivery` (`packages/cheers-acp-connector-rs/src/config.rs`), `credential_gateway.rs` |
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
| L3 static injection | `mcpServers[].headers` (`direct` mode) | Yes, for the token lifetime |

Three delivery modes exist, and the connector picks one per Agent process
(§3.5). Setting: `policy.mcp.delivery` (`direct` | `gateway`, later `auto`).

#### 3.4.1 Modes and selection

| Mode | Path | The Agent holds | Requires |
|---|---|---|---|
| `acp` | `mcp/message` over ACP → connector → `/mcp` (§3.4.3) | nothing | `mcpCapabilities.acp`, and an MCP revision our provider implements |
| `direct` | Agent → Gateway `/mcp`, bearer in `mcpServers[].headers` | the real token (one channel, host-revocable) | `mcpCapabilities.http`, and an Agent that re-reads headers on `session/load` |
| `gateway` | Agent → `127.0.0.1` → `/mcp` (§3.4.2) | a local secret useless off-host | `mcpCapabilities.http` |

`auto` order: **`acp` → `direct` → `gateway`**, restricted by the
deployment's `MCP_ALLOWED_DELIVERY_MODES` (a deployment that will not let
Agents hold a real token sets `gateway`, later `acp,gateway`). Neither `acp` nor `http` → Cheers MCP is not
offered, and the host profile says why.

The decision uses two reports, never a guess:

- **Agent report** (ACP `initialize`, declared): `mcpCapabilities`, `agentInfo`
  name and version. Decides which modes are possible.
- **MCP report** (traffic `/mcp` sees, observed): protocol revision,
  `clientInfo`, and which token generation the Agent presents. Decides whether
  `direct` works.

No field in either protocol says "re-reads headers", and the MCP revision does
not predict it, so `direct` is confirmed by observation (§3.5). The ACP
`protocolVersion` (1 for every Agent tested) says nothing about the Agent's MCP
revision; ACP and MCP negotiate independently. `direct` and `gateway` do not
need the revision either, because `/mcp` serves every era; it only gates
`acp`.

#### 3.4.2 Credential gateway (current universal path, M1)

A loopback HTTP endpoint inside the connector:

```text
Agent ──HTTP, any MCP revision──► 127.0.0.1:<port>/mcp   (connector)
        Authorization: Bearer <local per-channel secret>
                                   │ secret digest → channel
                                   │ swap in the real Cheers token (rotated freely)
                                   ▼
                              POST https://<gateway>/mcp
```

- **Pass-through, not an MCP implementation.** Body and MCP headers
  (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Accept`,
  `Content-Type`) are forwarded unchanged; only `Authorization` is replaced.
  2025-06-18, 2025-11-25 and 2026-07-28 clients all work, because `/mcp` serves
  every era statelessly. JSON and SSE responses stream back unchanged.
- **The Agent's credential never changes for the Agent process's lifetime**,
  so Agents that ignore refreshed headers (Codex) keep working. The gateway
  lives as long as the connector's account runtime, which stops the Agent when
  it exits, so an Agent never outlives its gateway's port or secrets. Token rotation happens inside
  the connector, which also allows a TTL of minutes.
- **The local secret is worthless off-host**: 32 random bytes, one per
  channel (ACP sessions are keyed by channel and bot, so this is one per
  session too), header-only (never in the URL), and resolved by its SHA-256
  digest so the lookup never compares the secret itself. The listener binds
  loopback only, rejects a non-loopback `Host` (DNS rebinding) or `Origin`,
  caps the body at the gateway's limit, and answers `GET`/`DELETE` with 405
  itself.
- **Upstream 401** invalidates the cached token for that channel (only if it
  is still the rejected one, so concurrent 401s cannot evict a fresh re-mint),
  re-mints once and retries; a second 401 is returned to the Agent.
- **Observation point**: every MCP request passes through, so the gateway can
  record the revisions and behaviours each Agent actually uses (§3.5, M2).
- Selected with `policy.mcp.delivery = "gateway"` (PR #806); `auto` picks it
  when `direct` is ruled out (§3.5). If the listener cannot start, the
  connector falls back to `direct` for that run.

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
| Declared (handshake, overwritten each connect) | connector version; Agent name/version (`runtime`); `mcp_{acp,http,sse}`, `load_session` (`agent_capabilities`); delivery `{modes, mode, reason}` (`mcp_delivery`) | connector `ready` frame | `connector_hosts.capabilities` (existing) |
| Observed | MCP revision and client (since 0099); re-reads headers on load, with the Agent build it applies to | `/mcp` | `connector_hosts.mcp_protocol_version`, `mcp_client_*`; `mcp_header_refresh`, `mcp_header_refresh_agent`, `mcp_header_refresh_at` (0118) |

- The profile is per **host**, not per bot: it describes one machine's connector
  and Agent, and a re-paired host starts fresh. A bot reads its active host's
  profile. ("Installation" is reserved for provider installs; see migration
  0088.)
- `McpDeliveryMode` and `McpDeliveryReport` live in `bridge-protocol` so
  server and connector share one definition. The rest of the declared profile
  already travels in `ready` (`runtime`, `agent_capabilities`), so no separate
  profile struct is added.
- **Policy is separate from facts**: allowed delivery modes are deployment
  policy (`MCP_ALLOWED_DELIVERY_MODES`, Helm `gateway.mcpAllowedDeliveryModes`),
  sent in the hello as `server_capabilities.mcp_allowed_modes`. It always wins
  over the connector's local `policy.mcp.delivery`. A per-bot setting can be
  layered on later; the security switch belongs to whoever runs the Gateway.

**Decision, on every Agent process start:**

```text
possible = hello mcp_allowed_modes ∩ modes the Agent report allows
           ∩ modes this connector serves (gateway only if its port bound)
cached verdict for agentInfo name@version (connector state file):
  header_refresh == false → drop direct
  MCP revision our acp provider lacks → drop acp (M6)
pick the first of acp → direct → gateway
unknown Agent version → start direct; the generation test below decides
```

**Generation test (confirms `direct` without a probe session).** JWTs already
carry `iat`, so a newer token is a newer generation; no new claim is needed.

1. In `direct` mode with no cached fact, the connector renews the channel's
   token at that channel's second prompt and delivers it with the usual
   `session/load`.
2. `/mcp` keeps the newest `iat` minted per `(host, chan)`. A request from a
   host reporting `direct` that presents an older `iat` more than 30 s after a
   newer one was minted means the Agent kept the old header.
   One presenting the newer `iat` re-read it.
3. The server records the verdict on the host (`mcp_header_refresh`, 0118) and
   sends `mcp_delivery_observed {channel_id, agent, header_refresh}` over the
   Bridge, once per Agent process. For a stale Agent nothing has failed yet:
   the old token is still valid.
4. The connector caches the verdict per `name@version`. A stale verdict under
   `auto` schedules the restart below; a confirmed one keeps `direct` on every
   later start of that build without testing again.

**Switching modes means restarting the Agent.** Agents such as Codex ignore a
changed `mcpServers` on `session/load`, so a mode cannot change inside a live
process. After a downgrade signal the connector waits until no turn is
running, restarts the Agent, and restores sessions with `session/load`; the
`ready` frame then reports the new mode and reason. **Upgrades** come from the
same re-evaluation: a new Agent version has no cached facts and is tested
again, and an Agent that starts advertising `acp` moves to `acp`.

**Token lifetime per mode.** `direct` cannot renew within a turn, so its TTL
must be at least the longest turn (`policy.prompt.max_duration_ms`);
`gateway` and `acp` renew inside the connector and can use minutes.
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

**Task binding (M5a, PR #815, as built).** The run ledger is the grant; no
separate signed `task_grant` is issued. The connector already holds the
task's `execution_id` from task acceptance, and sends it as
`cheers_execution` with its host credential and `cheers_channel`. The Gateway
mints only for an execution of this bot, in that channel, accepted and without
a terminal result (`bot_runs`), and adds a `task` claim. Every request with a
`task` claim re-checks that the execution still runs and is refused with 403
once it ends. The connector binds only where each new token reaches the Agent
(`gateway` delivery, or `direct` for an Agent judged to re-read headers);
otherwise an Agent keeping an ended task's token would be refused at once.

**Delegated narrowing (M5b, PR #816, as built).**

1. On the task-bound mint above, the Gateway takes the human U from the run
   record, never from the request: the trigger message's sender, or for a bot
   message in a task chain, the sender of the chain's root message.
2. The JWT keeps `sub = bot` and adds `obo = U` (with `chan = C`, `task = T`).
   A malformed `obo` rejects the token: dropping it would widen it.
3. `Principal` gains `on_behalf_of`. The shared channel checks
   (`authorize_channel_read` / `_write`, behind every resource handler) use the
   lower of the bot's and U's role and refuse when U is not a member. A
   prompt-injected Agent working for an admin still has no more than the bot's
   own rights, and the bot cannot reach what U cannot.
4. Each request re-checks that the task is running (M5a); U's membership and
   role are read on every channel check.
5. **No per-user consent.** Narrowing only removes access, so requiring consent
   first would leave non-consenting users' tasks with the bot's full role. The
   bot's owner can opt a bot out (`bot_accounts.mcp_narrow_to_sender`, `PUT
   /api/v1/bots/:id/mcp-policy`) for automation that read-only members must
   drive.

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
| `CHANNEL_SCOPE_REQUIRED` | The connector sent a channel-less token; the bot owner must upgrade it | no |
| `NOT_MEMBER` | Not a member of that channel; ask a member to invite you | no |
| `PERMISSION_DENIED` / `FORBIDDEN` | Your channel role is insufficient; ask a channel admin | no |
| `APPROVAL_REQUIRED` | Call `request_approval`, then retry with `approval_id` | yes |
| `SCOPE_REQUIRED` | The connector's token lacks a scope the Gateway gained after it started; the bot owner restarts the connector | no |
| `NOT_FOUND` | Stay opaque; never disclose whether a resource exists elsewhere | no |

Rules: the text is advisory and grants nothing (the server re-checks every
call); never echo other channels' names or ids; never interpolate user-supplied
text; mark non-recoverable errors `retryable: false` to prevent loops.

**Scope errors.** Authorization-code clients keep the spec's HTTP 403 +
`WWW-Authenticate: insufficient_scope` step-up challenge. Connector-minted
`client_credentials` tokens cannot step up, so for them the refusal becomes an
actionable tool error instead: a `tools/call` returns `isError` with
`structuredContent {code: "SCOPE_REQUIRED", retryable: false, requiredScopes}`
and a `Next:` line. Such tokens carry a `gty: "client_credentials"` claim; a
token without it keeps the 403 challenge. This is a deliberate deviation from a
SHOULD, signed off 2026-10-30 (M4c).

**`request_approval` (M5c, as built).** Scope: the registry's destructive
resources (`fs.rm`, `fs.mv`) on a person's task, i.e. a token with `task` and
`obo`. These are the platform's own resources, so the platform enforces the
ask, unlike ACP permission requests, which an agent can skip
([ACP_APPROVAL_FLOW](./ACP_APPROVAL_FLOW.md) keeps deciding those).

1. The gated call without a valid `approval_id` is refused with
   `APPROVAL_REQUIRED` and told to call `request_approval`.
2. `request_approval {channel_id, tool, arguments_json, reason?}` posts a
   `permission` card of kind `mcp_approval`, bound in its `content_data` to
   task, person, resource and a SHA-256 of the exact arguments (`approval_id`
   excluded). It waits up to 10 minutes and returns `approved`, `denied` or
   `expired`; expiry finalizes the card so a late click cannot approve.
3. Only the bound person can answer it through the existing resolve endpoint:
   not the bot owner, not a delegate. Nothing is sent to the connector.
4. The retried call passes `approval_id`; the gate checks the binding and
   consumes the card with a compare-and-set, so one approval allows one call.

No migration and no new token: the approval lives in the card, and MCP stays
stateless. Channel-only tokens and tasks without a person are not gated.

## 7. Status

| Item | Status |
|---|---|
| 2026-07-28 stateless protocol, legacy eras served statelessly, mirrored headers | ✅ (spec fixes in PR #799) |
| Host-bound tokens, host re-validated per request | ✅ |
| Channel-narrowed tokens, `enforce` default | ✅ |
| ACP session per channel | ✅ |
| Fresh token before every prompt via `session/load` (`direct`) | ⚠️ ignored by Codex (§3.4.4); `auto` moves such Agents to `gateway` (M2) |
| Credential gateway pass-through, `policy.mcp.delivery` | 🚧 M1, PR #806 |
| Host profile, `auto` negotiation, generation test | ❌ M2 |
| Native MCP-over-ACP | ❌ M6 (no Agent advertises `acp: true`; SDK 3.6 upgrade in PR #805) |
| Domain errors as `isError` tool results with `Next:` guidance and `{code, retryable}` | 🚧 M4a, PR #813 |
| Per-channel host working directory | 🚧 M3, PR #810 |
| Channel-safe `set_status` (owner↔bot DM only) | 🚧 M3, PR #809 |
| `off` / `warn` removed; scope always enforced | 🚧 M3, PR #809 |
| Token lifetime per mode (10 min for `gateway`, 24h for `direct`) | 🚧 M4b, PR #814 |
| Task-bound tokens (`cheers_execution` → `task` claim, per-request running check) | 🚧 M5a, PR #815 |
| Delegated narrowing (bot ∩ sender, owner opt-out) | 🚧 M5b, PR #816 |
| `request_approval` for destructive calls on a person's task | 🚧 M5c |

## 8. Roadmap

Each step is one PR. Order: M1 > M3 > M2 > M4 > M5 > M6; M3 and M4.1 can run
alongside M1.

| Milestone | Work | Touches |
|---|---|---|
| **M1 credential gateway** | Loopback pass-through (§3.4.2) with per-channel secrets, Host/Origin/body limits, 401 re-mint, SSE streaming, `NO_PROXY` for loopback; selected by `policy.mcp.delivery = "gateway"` (default stays `direct`); unit tests plus the Agent matrix end-to-end, including Codex across a token rotation; connector release | connector |
| **M2 host profile and negotiation** | M2a: `McpDeliveryMode` and `McpDeliveryReport` in `bridge-protocol`; `ready` reports the mode; migration 0118 adds `mcp_header_refresh{,_agent,_at}`; `/mcp` tracks the newest `iat` per `(host, chan)`, records the verdict and sends `mcp_delivery_observed` (PR #811). M2b: `MCP_ALLOWED_DELIVERY_MODES` via hello; `delivery = "auto"` as default; verdict cache by Agent build; generation test; restart-when-idle to switch (PR #812). Later: Fleet shows mode and reason | connector, server, migration, frontend |
| **M3 isolation** | Per-channel cwd under `default_cwd` (opt-out `shared_cwd`), #810; `set_status` only from the owner↔bot DM and `MCP_CHANNEL_SCOPE` off/warn removed, #809 | connector, server, mcp-server |
| **M4 guidance and tightening** | M4a (#813): `Next:` guidance and `{code, retryable}` on refused tool calls; `OUT_OF_CHANNEL` / `CHANNEL_SCOPE_REQUIRED` codes. M4b (#814): `MCP_GATEWAY_ACCESS_TOKEN_TTL_SECS` (600 s) for `gateway`/`acp` hosts, 24h for `direct`. M4c: tool-error scope refusals for `client_credentials` tokens (§9.4) | server |
| **M5 task, delegation, approval** | M5a (#815): `cheers_execution` → `task` claim with per-request running-task check, bound only where each token reaches the Agent. M5b: RFC 8693 exchange with `sub=U, act=bot` and role intersection; `request_approval` with one-time `approval_id`; optional DPoP upstream | server, connector, frontend, migration |
| **M6 native MCP-over-ACP** | Enable `unstable_mcp_over_acp` after #805; provider with one `serverId` per session, declared on `session/load` too; switch per Agent via M2 negotiation; help `claude-agent-acp` advertise `mcpCapabilities.acp` | connector, upstream |

Upstream, in parallel: share the §3.4.4 matrix on discussion #2584 after M1's
end-to-end run; send the Security-note PR if the RFD champion agrees.

## 9. Open decisions

1. ~~Delegation consent~~ Decided 2026-10-29: always narrow, no per-user
   consent (it would be backwards for a narrowing), owner opt-out per bot (#816).
2. ~~Bot-to-bot chains~~ Decided: narrow to the chain's originating human; the
   chain engine's existing depth limit bounds the chain (#816).
3. ~~Revoke on end~~ Decided: yes, by the per-request running-task check (#815).
4. ~~Scope refusals as tool errors~~ Decided 2026-10-30: yes for
   `client_credentials` tokens, as a documented deviation (M4c).

Decided 2026-10-29: native MCP-over-ACP is the future path. Revised the same
day: header injection is kept as `direct` mode rather than deleted; `auto`
prefers `acp` → `direct` → `gateway`, decided from the Agent's ACP report and
the MCP traffic `/mcp` observes (generation test), with
`MCP_ALLOWED_DELIVERY_MODES` as the security switch. The Codex header-refresh bug is handled by `auto` moving it
to `gateway`.
