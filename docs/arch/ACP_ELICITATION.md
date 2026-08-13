# ACP v1 Elicitation in Cheers

Cheers advertises ACP stable wire v1 `clientCapabilities.elicitation.form` and
`.url`. The Rust SDK currently exposes those v1 types behind its
`unstable_elicitation` compile-time feature; enabling that feature does not
change the negotiated `ProtocolVersion::V1` or enable ACP v2.

## Data flow

1. The agent sends `elicitation/create` to the connector.
2. The official or rollback runtime validates the typed ACP request and emits a
   transport-neutral `RuntimeEvent::ElicitationRequest`.
3. The connector binds a session-scoped request to its active Cheers
   channel/task and retains the verified human origin when the turn came from a
   user. For request scope, the transport maps the actual outbound ACP
   JSON-RPC ID to a human-originated `session/new`, `session/load`, or
   `authenticate` operation and removes that route when the request ends.
4. Gateway persists a `msg_type=elicitation` message and renders either a form
   or URL card in Web/Desktop.
5. An authenticated authorized channel member submits `accept`, `decline`, or
   `cancel`. Whenever a verified initiating user exists—including MCP OAuth in
   session scope—only that user may respond. Gateway atomically finalizes the
   card and routes the response to the same connector.
6. `elicitation/complete` finalizes an accepted URL card after the agent reports
   external completion.

## Security posture

- Form schemas that appear to request passwords, tokens, private keys, recovery
  codes, or payment credentials are cancelled before they reach the UI.
- URL mode requires HTTPS (loopback HTTP is permitted for local development),
  displays the full destination URL, performs no prefetch, and navigates only
  after explicit user consent.
- Resolution is authorized by bearer identity, current channel membership, and
  the existing permission-request approver/`RESPOND` policy; the Bridge frame
  records `resolved_by` and `resolved_at`.
- The existing Agent Bridge `permission_request` capability grant authorizes
  signed `elicitation_request` frames, avoiding a silent expansion of deployed
  delegation policy.
- Gateway persists both IDs: Cheers' card `request_id` is the Web API
  correlation key, while `acp_request_id` is diagnostic/audit data and never an
  authorization credential.
- Request-scoped responses are restricted to the initiating user. Gateway
  verifies that identity against the persisted origin message before creating
  the card. Unmatched, expired, bot/system-originated, and startup-initialize
  scopes fail closed.
- URL elicitations targeting the configured Cheers OAuth issuer are presented
  as a dedicated “Connect Cheers MCP” card. They require a verified initiating
  user, compare the complete URL origin (not a hostname suffix), and remain in
  an accepted/waiting state until the Agent sends `elicitation/complete` on the
  same ACP connection. The URL never carries credentials and Cheers never
  receives the resulting OAuth tokens over ACP.
- Agents that do not emit ACP `elicitation/create` are not impersonated by the
  Connector. Their native CLI login requirement remains an `auth_required`
  diagnostic card with explicit retry/cancel controls.

## Web interaction and MCP connection state

The Web client renders both `elicitation` and `auth_required` through the
single `AgentInteractionCard` boundary. Their wire DTOs and resolution APIs stay
separate: elicitation is a resolvable ACP request, while `auth_required` is a
runtime diagnostic. This keeps one visual integration point without pretending
the protocols are interchangeable.

Native HTTP MCP connectivity belongs to `terminal_installations`, not to a chat
card. Its state progresses through `unconfigured`, `action_required`,
`authorizing`, `connected`, `refresh_failed`, or `revoked`. An accepted card or
issued token can reach only `authorizing`; only a recognized MCP method handled
by Gateway after installation-bound token validation establishes `connected`.
Gateway records first connection and last successful request timestamps.

Agent profiles are presentation metadata only. They may provide a native login
hint and, once the lifecycle matrix is complete, a verified version range. They
are returned to Web surfaces but never select Connector or `BridgeRuntime`
behavior. Unknown and not-yet-verified versions therefore remain explicit
instead of acquiring an optimistic compatibility claim.

## Agent-provider authentication

Provider authentication and Cheers MCP authentication remain separate security
domains. When a task hits an Agent provider-auth error, the Connector forwards
every advertised ACP auth method to Web. The bot owner explicitly selects one;
Gateway validates that choice against the persisted list and Connector validates
it again before invoking ACP `authenticate` with the verified human request
route. An Agent may then issue request-scoped URL elicitation while that call is
pending. Provider authorization codes and tokens never pass through Gateway or
enter model context.

Agent-specific convenience is isolated behind two extension interfaces.
`AuthMethodPolicy` only orders methods and marks a recommendation; it cannot
choose or execute authentication. `PresentationDecoder` converts optional
vendor metadata (currently Codex params and Claude tool names) into the additive,
vendor-neutral `normalized_presentation` DTO. Gateway presentation code consumes
only canonical fields and that DTO—it has no Codex metadata fallback. For Codex,
device code is recommended unless a configured Codex/OpenAI API key makes the
API-key method more convenient, but Web remains the final decision point.
Human-waiting authenticate calls use the interaction timeout, not the shorter
ordinary session-request timeout.

Reference: [ACP v1 Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation).
