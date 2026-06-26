# Trace Persistence & Approve-as-Trace

> Status: implemented on `feat/acp-approval`. Durable agent-trace timeline for
> audit + (optional) display, with **approve folded in as a kind of trace**.

## Goal

Bot **trace** (agent progress: prompt lifecycle, tool calls, plans, approvals)
was ephemeral — `bot_trace` frames were logged + fanned out to browsers and then
dropped. Make trace **durable** so it can be audited and (later) displayed, and
make **approval a kind of trace event** so the requested → resolved/expired
lifecycle interleaves inline with the tool_call/plan traces of the same turn.

## Design (chosen after a 3-proposal design pass)

A new append-only **`message_traces`** table, **anchored to the bot-turn
`msg_id`** (the placeholder reply id = `ActiveRun.msg_id` = the permission
card's `content_data.source_msg_id`). The gateway persists trace events into it;
approvals are written as `kind='approval'` rows anchored to that **same bot
turn**, so they interleave with `tool_call`/`plan`/`prompt_*` rows.

**Coexistence, not subsumption.** The three live approval pillars are untouched:
1. the mutable `messages` permission card (`msg_type='permission'`),
2. `approval_audit` + `record_audit` + `list_audit` — the **immutable legal log**,
3. the connector control-frame resolve roundtrip.

`message_traces` is an **additive sibling write** placed next to each existing
`record_audit` call. No `ALTER` to `messages`/`approval_audit`, no signature
changes, every caller compiles unchanged. `approval_audit` stays the source of
truth (written first, synchronously); `message_traces` is the queryable
in-context timeline (best-effort, fire-and-forget).

### Why not the alternatives
- **Generalize `approval_audit`** — its premise ("query traces + approval by
  `msg_id`") is false here: the permission card uses `Uuid::new_v4()` while trace
  frames carry the bot-reply placeholder id, so they never share `msg_id`.
- **One unified log via a `record_audit` shim** — merges the high-frequency
  trace stream and the approval flow into one failure domain and moves the audit
  write into the card transaction. Rejected for blast radius.

## Schema (`server/migrations/0020_message_traces.sql`)

`message_traces`: `id` VARCHAR(36) PK, `msg_id` (anchor), `channel_id`, `bot_id`,
`task_id`, `run_id`, server-stamped `trace_seq` BIGINT with
`UNIQUE(msg_id, trace_seq)`, `stream`, `kind` (`trace`|`approval`), `phase`,
`status`, `title`, `message`, `data` JSONB, and first-class approval columns
(`request_id`, `approval_kind`, `decision`, `option_id`, `actor_id`),
`created_at`. No FKs (audit must outlive deleted rows). Indexes: per-turn read
`(msg_id, trace_seq)`, channel audit `(channel_id, kind, created_at)`, request
lookup `(request_id) WHERE request_id IS NOT NULL`, prune `(created_at) WHERE
kind='trace'`.

## Retention (two tiers)

- **Write-time allowlist** (`domain::trace::should_persist`): always persist
  `kind='approval'`; persist run-skeleton phases (`tool_call`,
  `tool_call_update`, `plan`, `prompt_started`, `prompt_finished`,
  `prompt_failed`, `terminal_ack_failed`). Drop per-token `agent_thought_chunk`
  by default (env `CHEERS_TRACE_PERSIST_THOUGHTS=1` to keep). Bounds rows to
  ~tool-call count per turn, not token count.
- **Prune job** (future): `DELETE … WHERE kind='trace' AND created_at < window`
  (partial `idx_traces_prune`); **never** prune `kind='approval'`.

## Hot-path discipline

The trace INSERT in `handle_trace_frame` is **spawned/fire-and-forget** (never
awaited before the live fan-out) so a slow DB cannot backpressure the connector
frame loop. Approval sibling-writes are low-frequency and ordered **after** the
`record_audit` write (the legal log is never the one missing).

## Phases

- **P0** — migration `0020` (additive; no-op until written).
- **P1** — gateway `domain/trace.rs` + persist hook in `handle_trace_frame` +
  approval sibling-writes next to each `record_audit`
  (requested / resolved / timeout).
- **P2** — connector: persist `auto_allowed`/`rejected` (those return early so the
  gateway never sees them) by normalizing two `trace()` calls to `phase='approval'`.
- **P3** — read API `GET /channels/:cid/messages/:msg_id/trace` (+ optional
  channel timeline). `…/permissions/audit` unchanged.
- **P4** — frontend (optional/deferred): render the persisted per-turn timeline;
  approval rows reuse the resolved card styling.
