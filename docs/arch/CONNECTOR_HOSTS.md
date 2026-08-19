# Connector hosts

Cheers separates the durable channel identity from the machine that runs it:

- `bot_accounts` owns channel membership, roles, messages, MCP scopes and approvals.
- `connector_hosts` identifies one ACP connector host and stores only the
  SHA-256 of its `agbi_…` credential.
- Pairing codes are single-use, short-lived and bound to a pending
  `host_id` when minted. Redemption activates that host and
  returns its credential once.

## v1 active/passive rule

A Bot may retain multiple hosts, but a partial unique index permits one
non-revoked active host. Enrolling or explicitly activating another
host demotes the old active host to standby and closes the
Bot's current bridge session. Standby credentials remain device-specific but
cannot authenticate until the owner activates them.

## Security invariants

- Agent Bridge accepts host credentials only; a Bot token cannot bypass
  host revocation or active/standby state.
- Credentials are never stored in plaintext and are returned only on redemption
  or rotation.
- Rotation and revocation affect only their host. An active host
  is disconnected immediately; changing a standby host does not disturb
  the active connector.
- Authentication joins the host to its Bot, then all channel/resource
  authorization continues to use the Bot's memberships, roles and approval
  policy. A terminal never expands the Bot's authority.
- Control and data hello frames include the resolved `host_id`; the
  connector rejects a pair whose Bot or host differs.

## Management API

- `GET /api/v1/bots/{bot_id}/hosts`
- `POST /api/v1/bots/{bot_id}/hosts/{host_id}/activate`
- `POST /api/v1/bots/{bot_id}/hosts/{host_id}/credential`
- `POST /api/v1/bots/{bot_id}/hosts/{host_id}/reconnect`
- `DELETE /api/v1/bots/{bot_id}/hosts/{host_id}`

All management endpoints require the Bot owner or a platform administrator.
