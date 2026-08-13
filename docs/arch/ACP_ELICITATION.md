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
   channel/task. For request scope, the transport maps the actual outbound ACP
   JSON-RPC ID to a human-originated `session/new`, `session/load`, or
   `authenticate` operation and removes that route when the request ends.
4. Gateway persists a `msg_type=elicitation` message and renders either a form
   or URL card in Web/Desktop.
5. For session scope, an authenticated authorized channel member submits
   `accept`, `decline`, or `cancel`; for request scope, only the verified
   initiating user may do so. Gateway atomically finalizes the card and routes
   the response to the same connector.
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

Reference: [ACP v1 Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation).
