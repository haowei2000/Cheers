# Remote MCP OAuth and Tool Scope Contract

Status: **FROZEN for MCP 2026-07-28 v1**  
Frozen on: 2026-08-13

This document is the compatibility contract for the Cheers stateless HTTP MCP
endpoint. Changes to public scope names, tool-to-scope mappings, token audience,
or challenge semantics require a new protocol contract revision. The legacy
stdio MCP process is not an authorization authority.

## 1. Security principals and decision order

The remote endpoint has four distinct identities. They must never be collapsed:

1. The MCP OAuth client identifies the application/runtime requesting access.
2. A connector host identifies one enrolled device of a Cheers Bot.
3. The Bot is the Cheers member principal used for channel authorization.
4. A human resource owner grants or revokes the OAuth scopes.

Every call is authorized in this order:

1. Validate the access token signature, expiry, issuer, token use and canonical
   MCP resource audience.
2. Resolve the active host and Bot; rejected, revoked or disabled
   hosts and Bots fail closed.
3. Check the operation's required OAuth scope set.
4. Bind the request to `Principal::bot(bot_id)` on the server. Client arguments
   can never select the principal.
5. Apply the existing Cheers channel membership, channel role, resource grant,
   approval and audit policy to the requested arguments.

OAuth scopes are an upper bound, not a replacement for Cheers authorization. A
token with `cheers:messages:write` cannot write to a channel where its Bot is not
a writable member.

## 2. OAuth 2.1 protected-resource contract

The canonical resource identifier is the externally visible absolute MCP URL,
for example `https://cheers.example/mcp`. Tokens for an origin, path, API or
audience other than this exact resource are rejected.

The MCP resource server publishes RFC 9728 metadata at the well-known protected
resource URL and advertises the Cheers authorization server. The authorization
server publishes RFC 8414 metadata and supports:

- Authorization Code with PKCE S256 for public interactive MCP clients.
- Pre-registered clients and Client ID Metadata Documents.
- Host-bound client credentials for unattended enrolled Agent
  terminals. These credentials are device-specific, rotatable and revocable.
- RFC 8707 `resource` in authorization and token requests.
- Refresh tokens only when the authorization server elects to issue them.

Client ID Metadata Documents are the public-client registration mechanism.
Authorization codes are single-use and PKCE S256-bound; refresh tokens rotate
on every use. Unattended connector clients authenticate only as an enrolled
host. The former Bot-credential token exchange has been removed.

Cheers serves metadata at both the host-level path requested by MCP clients and
the RFC 9728 path-derived alias:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`

`MCP_CHANNEL_SCOPE` (`off` | `warn` | `enforce`, default `warn`) decides how
strictly a call must stay inside the channel its token was minted for. The
`client_credentials` grant accepts an optional `cheers_channel` parameter; the
Gateway refuses to mint a token naming a channel the bot is not a member of, and
records the channel as the token's `chan` claim. The claim only ever **narrows**
— the bot's channel role is still checked for every operation — so a token that
reaches the wrong channel's connection costs its holder access and can never buy
any. Connectors that predate the parameter send no channel and are classified
`unnarrowed`: allowed under `warn`, refused under `enforce`. Move a deployment to
`enforce` only once every connector reaching it mints channel-scoped tokens.

`MCP_PUBLIC_URL` is the sole production source of the returned `resource`, token
audience, and challenge metadata URL. It must be an externally visible HTTPS URL
ending in `/mcp`; request `Host` and forwarded headers are never trusted for this
security decision. Without an explicit authorization issuer, the MCP origin is
the canonical Cheers issuer.

Requests without a valid token return HTTP 401 with a Bearer challenge containing
`resource_metadata`. A valid token lacking an operation scope returns HTTP 403:

```http
WWW-Authenticate: Bearer error="insufficient_scope",
  scope="cheers:messages:write",
  resource_metadata="https://cheers.example/.well-known/oauth-protected-resource/mcp"
```

The challenge contains the complete minimum scope set for that operation so an
interactive client can perform one bounded step-up authorization.

## 3. Frozen public scopes

| Scope | Meaning |
|---|---|
| `cheers:read` | Discover the server and tools; list/read channel resources and read-only tools. |
| `cheers:messages:write` | Post or reply to channel messages. |
| `cheers:files:write` | Deliver an attachment into a channel. |
| `cheers:workspace:write` | Create, edit, append, move or remove Cheers Desk files. |
| `cheers:profile:write` | Update the calling Bot's own status/profile card. |
| `cheers:membership:write` | Open an eligible DM or make the Bot leave a channel. |
| `cheers:task-claims:write` | Submit a decision for a task-claim evaluation assigned to this Bot. |

Scopes do not imply one another except that a future documented aggregate scope
may explicitly expand to this frozen set. There is no generic `tools:call` scope.

`server/discover`, Resources, Prompts, Completion, and `tools/list` require
`cheers:read`. Tool catalog entries
include `io.cheers/requiredScopes` so clients can request step-up before a call.

## 4. Frozen Tool scope mapping

| Scope | Tools |
|---|---|
| `cheers:read` | `get_channel_info`, `list_members`, `read_messages`, `messages_index`, `messages_by_seq`, `search_messages`, `read_activity`, `get_context`, `read_plan`, `read_sessions`, `read_cost`, `inbox_list`, `inbox_open`, `desk_list`, `desk_read`, `read_workspace`, `list_task_claims` |
| `cheers:messages:write` | `post_message` |
| `cheers:files:write` | `inbox_deliver` |
| `cheers:workspace:write` | `desk_write`, `desk_edit`, `desk_append`, `desk_rm`, `desk_mv` |
| `cheers:profile:write` | `set_status` |
| `cheers:membership:write` | `leave_channel`, `open_direct_message` |
| `cheers:task-claims:write` | `respond_to_task_claim_evaluation` |

`inbox_stage` is intentionally absent from the remote v1 catalog. It names a
file on a particular terminal and therefore requires host routing plus
an explicit local-file approval contract; a stateless gateway request cannot
safely infer that host.

`read_workspace` remains read-scoped. Its live owner-host routing is
transport-neutral: both Agent Bridge and HTTP MCP dispatch through the owner
Connector. It never falls back to the gateway's filesystem.

## 5. Stateless Tools behavior

- `server/discover` advertises Resources, Tools, Prompts, and Completions.
- `tools/list` is unpaginated in v1 and returns `resultType=complete`, a private
  cache scope, and a bounded catalog TTL.
- `tools/call` requires `Mcp-Name` to equal `params.name`.
- A successful call returns MCP content blocks plus `resultType`, `ttlMs=0`,
  `cacheScope=private`, and server metadata.
- Domain denials are successful MCP tool results with `isError=true`; transport,
  protocol and OAuth failures use HTTP/JSON-RPC errors.
- Writes use the transport-neutral dispatch path with effects, so persistence,
  channel sequence allocation, fan-out, Agent triggering and audit behavior are
  identical to Agent Bridge writes.
- Request arguments are size-limited and validated by both the MCP adapter and
  the existing resource handler.
- `post_message`, `inbox_deliver` and `desk_append` accept an optional
  `idempotency_key`. 2026-07-28 clients must re-issue a call whose response
  stream broke. A retry that reuses the key gets the first result back with
  `idempotent_replay: true`, and nothing is written or triggered again. A key is
  scoped to the calling principal and tool, and bound to the call's arguments:
  reusing it with different arguments fails with `E_IDEMPOTENCY_KEY_REUSED`.
  Keys are retained for 24 hours. `desk_write` and `desk_edit` are already
  retry-safe through `if_version`.

## 6. Approval boundary

OAuth consent grants a class of Cheers platform operation; it does not approve
arbitrary local shell commands. ACP/local runtime command and edit approvals stay
separate. Cheers resource handlers continue to apply existing role and approval
rules. No OAuth scope grants host filesystem, process execution, environment or
network access.

## 7. Migration gates

The stdio process may be removed only after all of these are true:

1. Protected Resource Metadata and authorization-server discovery interoperate
   with the official conformance client.
2. Host credentials replace shared long-lived Bot credentials. ✅
3. Every remotely exposed Tool has parity tests against its stdio mapping.
4. Scope challenge, revoked host, removed membership and role downgrade
   tests pass.
5. Connector uses the remote endpoint by default and retains no hidden
   privileged resource path.

The official `@modelcontextprotocol/conformance@0.2.0-alpha.11` server command
is a required CI gate with `--suite all --spec-version 2026-07-28`. It
bootstraps a real connector host, obtains its OAuth token, executes the
full suite, revokes the host, and verifies the already-issued access
token immediately returns HTTP 401.

## 8. Initialization-based clients

Agent runtimes still ship MCP clients that predate 2026-07-28. As of
2026-09-15, Codex CLI 0.145 (used by codex-acp 1.1.9) sends `initialize` at
2025-06-18, and opencode 1.18 sends it at 2025-11-25. The endpoint therefore
also serves the 2025-06-18 and 2025-11-25 revisions, **without sessions**. Any
gateway replica can serve any request, so no session affinity is required.

The era is selected per request:

1. `params._meta["io.modelcontextprotocol/protocolVersion"]` is present →
   2026-07-28 rules (sections 2–5).
2. `initialize` → legacy lifecycle. A supported requested version is echoed;
   any other version is answered with 2025-11-25.
3. `MCP-Protocol-Version: 2025-06-18` or `2025-11-25` without modern `_meta` →
   legacy request. Both revisions send this header after initialization.
4. Anything else is validated, and rejected, as 2026-07-28.

Legacy behavior:

- No `Mcp-Session-Id` is minted or read. GET and DELETE on `/mcp` return 405.
- Notifications such as `notifications/initialized` return 202 and are ignored.
- `ping` is answered. `server/discover` is 2026-07-28 only.
- Results omit `resultType`, `ttlMs`, `cacheScope` and the `_meta` server
  identity. `structuredContent` is sent only when it is a JSON object; the text
  content block always carries the full JSON.
- JSON-RPC errors raised by method handling use HTTP 200, and
  resource-not-found uses `-32002`. OAuth challenges (401/403), scopes, the tool
  catalog and Cheers authorization are identical to 2026-07-28.
- `Mcp-Method`/`Mcp-Name` are optional, but must match the body when sent.
- Not supported: server-initiated requests (sampling, elicitation, roots),
  subscriptions, SSE resumability, 2025-03-26 and earlier (no version header;
  JSON-RPC batching), and the HTTP+SSE transport.

This is a compatibility window, not a second contract. Remove the legacy era
once the supported agent runtimes ship 2026-07-28 clients, together with the
legacy smoke check in `scripts/run-mcp-conformance.sh`.
