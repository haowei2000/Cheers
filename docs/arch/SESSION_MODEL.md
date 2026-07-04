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
  **owner-default but grantable** (`OWNER_DEFAULT_INITIATE`): the **bot owner / platform admin
  are allowed by default** (they own the bot-level default too), and **every other subject is
  deny-by-default**, widened only by an explicit allow rule. (The owner/admin short-circuit lives
  in the session-control endpoints — `ensure_bot_owner_or_admin` — so the in-channel control is
  visible/usable to the owner without self-granting.)
- **Mode value-clamp**: a session-targeted mode change travels the connector's dedicated
  `mode_set` frame (ACP `session/set_mode`), which validates the value against `allowed_modes`.
  It must NOT travel `config_option_set` (that checks only the config *id*, not the value).

## Session operations × permission (current state)

Which ACP/Cheers session operations are governed, and how. Principle: **action before
permission** — only operations that are actually exposed get a grant class; we don't add
decorative rows for unimplemented actions.

| Operation | Governed by | Endpoint | Status |
|---|---|---|---|
| **prompt** | `acp_policy` INITIATE `prompt` (matrix) | `POST …/messages` | ✅ |
| **cancel** | `acp_policy` INITIATE `cancel` (matrix) | `…/messages/:id/cancel` | ✅ |
| **set_mode** | INITIATE `set_mode` — owner-default, grantable; owner/admin bypass | `…/sessions/:id/mode` | ✅ |
| **set_config_option** | INITIATE `set_config_option` — owner-default, grantable; owner/admin bypass | `…/sessions/:id/config-option` | ✅ |
| **create** (extra session) | INITIATE `session_create` — owner-default, grantable; owner/admin bypass | `POST …/sessions` | ✅ |
| **close / terminate** (≈ soft delete) | INITIATE `session_close` — owner-default, grantable; owner/admin bypass | `DELETE …/sessions/:id` | ✅ |
| **list** | **channel membership** (not a per-subject grant) | `GET …/sessions` | ⚠️ membership-gated, **not** in matrix |
| **resume** | — | — | ❌ not exposed (auto-resumes by `provider_session_key` on next message) |
| **fork** | — | — | ❌ not exposed (ACP advanced; no connector support / UX yet) |
| **hard delete** (purge row + history) | — | — | ❌ not separate (`close` covers stop-using; no destructive purge) |
| `request_permission` | RESPOND (matrix) + owner/approvers | approval card | ✅ |
| agent→user `output/thought/tool_call/plan` | SEE (matrix) | live broadcast / trace read | ✅ |
| `current_mode/config_option/usage/available_commands _update` | SEE vocabulary (grantable); **enforcement = logged to `acp_event_log`/Activity**, not live per-subscriber filtered | Activity timeline | ⚠️ telemetry; control is `set_*` above |
| `session/new·load·resume·list·close·fork·delete` (raw ACP) | **Connector** (host firewall / plumbing) | — | host-managed, not per-subject |

**Deferred (decided 2026-06-30, not built):**
- **`list` → SEE grant** — possible if "who can see this channel's sessions" needs per-subject
  control; today membership-gated (a benign read), which is usually enough.
- **`resume` / `fork` / hard `delete`** — need a real UX + endpoint (and connector support for
  fork) before adding a grant class; not built to avoid decorative permission rows.

## ⚠️ Breaking changes vs. prior behavior

This refactor changes behavior/data in ways that are **not** backwards-compatible with
the pre-2026-06-30 model. Ordered by impact:

1. **Session scope: workspace → channel (behavioral break).** Previously one ACP session
   per `(workspace, bot)` — keyed `cheers:workspace:{ws}:bot:{bot}` — was **shared by all
   channels** of that workspace. Now it's per `(channel, bot)` (`cheers:channel:{ch}:bot`).
   Consequences:
   - **Cross-channel shared context is gone.** A bot no longer carries one conversation across
     every channel in a workspace; each channel has its own context.
   - **Existing workspace sessions are orphaned, not migrated.** They simply go idle; the first
     message in each channel after deploy creates a *fresh* channel session (new agent context).
   - Anything that assumed "one session per workspace per bot" (dashboards, external tooling,
     manual queries) must switch to the channel grain.

2. **`set_mode` / `set_config_option` are now grantable + deny-default (model/contract change).**
   They were *excluded from the INITIATE matrix* (owner-only by construction, not in the
   vocabulary). Now they're in `initiate_events()`, **deny-by-default but grantable**
   (`OWNER_DEFAULT_INITIATE`). Runtime effect with **no** rule is unchanged (still owner-only),
   so existing deployments don't silently widen — but the **contract changed**: they now appear
   in the Grants UI, `GET /event-access.initiate_events` now lists them, and new session-scoped
   endpoints exist. Any doc/test asserting "excluded from the matrix" is now wrong
   (`ACP_EVENT_TAXONOMY.md` updated).

3. **Binding uniqueness changed (schema, migration `0033`).** Dropped the constraint
   `uq_cheers_session_binding_scope` (one binding per `(bot, scope)`) and replaced it with a
   **primary-only** partial unique `uq_cheers_session_binding_primary WHERE role='primary'`.
   Applied automatically by sqlx migrations on gateway startup; any code doing
   `ON CONFLICT ON CONSTRAINT uq_cheers_session_binding_scope` would break (the gateway's
   `upsert_session_binding` was updated to the partial-index conflict target).

4. **Connector bridge protocol additions — requires connector rebuild.** New inbound frame
   `mode_set` (session-targeted `session/set_mode`, value-clamped by `allowed_modes`) and a
   `configOptions` field on `config_update.settings`. An **un-rebuilt old connector** will
   `serde`-fold `mode_set` into its `Unknown` variant and **silently ignore it** — so delegated
   *mode* changes are no-ops until the host connector is rebuilt (`cargo build --release` +
   `launchctl kickstart -k`). Config-option changes ride the pre-existing `config_option_set`
   frame and work without a rebuild.

5. **Message API (additive, non-breaking).** `SendMessageRequest`/`CreateMessageParams` gained
   an optional `session_id` (default = the channel's primary session). `GET /permissions` gained
   `config_options`. These are additive — old clients keep working.

## Known v1 limitation

A delegated session override is persisted (`cheers_sessions.metadata.session_config`) and pushed
to the **live** session, but the connector re-applies the **bot default** on a fresh `session/new`
(reconnect / agent restart). So a per-session override is durable only for the life of the live
session; on recreation it reverts to the owner default. Re-applying the stored override on resume
is a planned follow-up. (Authorization is unaffected — only the applied value can revert.)
