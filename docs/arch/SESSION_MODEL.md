# Session model (per-channel, primary + other)

> Status: Phases 1–4 backend complete. See also [BOT_CONFIG_GOVERNANCE.md](BOT_CONFIG_GOVERNANCE.md)
> and [ACP_EVENT_TAXONOMY.md](ACP_EVENT_TAXONOMY.md).

## Concepts (decoupled)

A **session** is a first-class entity (`cheers_sessions`, keyed by `session_id`) — one
live ACP context with a bot. It is *bound* to where it's used via `cheers_session_bindings`;
it is **not identified by** that scope. Three separate ideas:

| Idea | What | Where |
|---|---|---|
| Session | one live ACP context; holds its own `provider_session_key` + per-session config override | `cheers_sessions` |
| Binding | "this session is surfaced here" — `(scope_type, scope_id, role)` | `cheers_session_bindings` |
| Channel | a place; binds to **one `role='primary'`** session per bot, plus any number of "other" sessions | `channels` |

There is **no "topic"/thread label** — extra sessions are addressed by their `session_id`.

## Keying & resume

- **Primary** session: `provider_session_key = cheers:channel:{channel_id}:bot:{bot_id}` —
  scope-derived so it's stable across turns (bindings are detached on `finalize_session`;
  resume dedups on this key via `ON CONFLICT`).
- **Other** sessions: `provider_session_key = cheers:session:{session_id}` — addressed by id.
- A channel allows multiple sessions via a **primary-only partial unique** on the binding
  (`uq_cheers_session_binding_primary WHERE role='primary'`): exactly one primary + N others.

## Routing

`POST /channels/:id/messages` with no `session_id` → the channel's primary session.
With `session_id` → that "other" session (verified bound to the channel; it determines the bot).

## Config layering (mode / config options)

`L0 connector ceiling (allowed_modes / allowed_config_options)` ▸ `bot default (owner, seeds new
sessions)` ▸ `session override (per-session)`.

- **Owner, bot-level** (`PUT /bots/:id/permissions/posture` · `/config-option`): owner-gated;
  applied by the connector on every `session/new`.
- **Delegated, session-level** (`POST /channels/:ch/bots/:bot/sessions/:sid/mode` ·
  `/config-option`): a channel member with an explicit INITIATE grant on `set_mode` /
  `set_config_option` may change *that session's* mode/config. Gated FAIL-CLOSED via
  `acp_policy`, with FATAL value pre-validation. `set_mode`/`set_config_option` are
  **owner-default but grantable** (`OWNER_DEFAULT_INITIATE`): deny-by-default, widened only by
  an explicit allow rule.
- **Mode value-clamp**: a session-targeted mode change travels the connector's dedicated
  `mode_set` frame (ACP `session/set_mode`), which validates the value against `allowed_modes`.
  It must NOT travel `config_option_set` (that checks only the config *id*, not the value).

## Known v1 limitation

A delegated session override is persisted (`cheers_sessions.metadata.session_config`) and pushed
to the **live** session, but the connector re-applies the **bot default** on a fresh `session/new`
(reconnect / agent restart). So a per-session override is durable only for the life of the live
session; on recreation it reverts to the owner default. Re-applying the stored override on resume
is a planned follow-up. (Authorization is unaffected — only the applied value can revert.)
