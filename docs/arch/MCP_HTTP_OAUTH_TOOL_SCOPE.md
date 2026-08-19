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
  the existing resource handler. Idempotency keys will be added before exposing
  retryable non-idempotent writes to general third-party clients.

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
