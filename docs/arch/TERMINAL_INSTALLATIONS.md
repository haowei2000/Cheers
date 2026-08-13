# Terminal installations

Cheers separates the durable channel identity from the machine that runs it:

- `bot_accounts` owns channel membership, roles, messages, MCP scopes and approvals.
- `terminal_installations` identifies one ACP connector host and stores only the
  SHA-256 of its `agbi_…` credential.
- Enrollment codes are single-use, short-lived and bound to a pending
  `installation_id` when minted. Redemption activates that installation and
  returns its credential once.

## v1 active/passive rule

A Bot may retain multiple installations, but a partial unique index permits one
non-revoked active installation. Enrolling or explicitly activating another
installation demotes the old active installation to standby and closes the
Bot's current bridge session. Standby credentials remain device-specific but
cannot authenticate until the owner activates them.

## Security invariants

- Agent Bridge accepts installation credentials only; a Bot token cannot bypass
  installation revocation or active/standby state.
- Credentials are never stored in plaintext and are returned only on redemption
  or rotation.
- Rotation and revocation affect only their installation. An active installation
  is disconnected immediately; changing a standby installation does not disturb
  the active connector.
- Authentication joins the installation to its Bot, then all channel/resource
  authorization continues to use the Bot's memberships, roles and approval
  policy. A terminal never expands the Bot's authority.
- Control and data hello frames include the resolved `installation_id`; the
  connector rejects a pair whose Bot or installation differs.

## Management API

- `GET /api/v1/bots/{bot_id}/installations`
- `POST /api/v1/bots/{bot_id}/installations/{installation_id}/activate`
- `POST /api/v1/bots/{bot_id}/installations/{installation_id}/credential`
- `POST /api/v1/bots/{bot_id}/installations/{installation_id}/reconnect`
- `DELETE /api/v1/bots/{bot_id}/installations/{installation_id}`

All management endpoints require the Bot owner or a platform administrator.
