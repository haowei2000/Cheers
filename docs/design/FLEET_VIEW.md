# Fleet View — design

> Status: 📝 **Design accepted, P1 in progress** (2026-07)
> Owner surface: multi-agent governance. Roadmap phase-1 item
> ("make governance undeniable" — see [ROADMAP.md](../ROADMAP.md)).

## Problem

Once a workspace runs more than 2–3 agents, the channel message stream stops
answering the two questions a team actually has:

1. **"Who is waiting on me?"** — approval requests are ordinary channel messages;
   with several bots across several channels, humans have to scroll to find them.
2. **"What is my fleet doing right now?"** — working / idle / stuck-on-approval,
   and what it costs, are invisible unless you open each channel's Viewboard.

The Fleet view is one surface that answers both: a workspace-level **mission
control** — pending approvals you can act on at the top, the bot roster with live
status below.

This is the first deliverable of the multi-agent UX track (entry points #1
approval inbox + #3 agent presence, merged into one surface).

## Product shape (P1)

- A **Fleet** button on the WorkspaceRail (with a pending-approvals badge from P2)
  → a full page at `/fleet`. Full page, not a work-lane drawer: it is
  workspace-scoped, not channel-scoped, and should not compete for lane space.
- **Zone A — approvals inbox**: pending permission requests across all channels
  the user is a member of, most recent first. Each card shows the requesting bot,
  channel, the concrete ask (command / paths / cwd — same extraction as the Audit
  panel), and Approve / Deny when the user is authorized to answer.
- **Zone B — bot roster**, grouped by channel: per bot a status chip
  (`online/offline` from presence, `working/idle` from session status), the bot's
  self-status line (`status_emoji status_text`), busy/idle session counts, and
  today's cost.

Team-first requirements (these drove the design):

- **Per-user inbox.** Each member sees only approvals they may *see* (SEE gate),
  and Approve/Deny only where they may *answer* (`actionable` flag). Visible but
  not actionable cards render disabled with a **Request access** action, reusing
  the existing `request_access` flow. This is the team story: juniors see the
  queue, seniors clear it.
- **Attribution.** Resolved items show who answered (already recorded as
  `approval_audit.actor_id`).
- **Concurrent answers.** Two members answering the same card race on the
  existing atomic CAS finalize (`domain/approval.rs::patch_content_data_if_unresolved`);
  the loser gets the standard conflict and the broadcast collapses the card
  everywhere. No claiming mechanism in P1.

## API

One new REST endpoint. **Not** a WS resource verb: `resource/mod.rs` dispatch
authorizes on channel membership only and is channel-scoped by design; a
cross-channel aggregation does not belong there.

```
GET /workspaces/:workspace_id/fleet
```

```jsonc
{
  "approvals": [
    {
      // the permission message's content_data, verbatim (kind, request_id,
      // tool, options, resolved, source_msg_id, session_id, ...)
      "channel_id": "…", "channel_name": "dev-infra",
      "message_id": "…", "bot_id": "…", "created_at": "…",
      "actionable": true          // this caller may answer it
    }
  ],
  "bots": [
    {
      "bot_id": "…", "channel_id": "…", "channel_name": "…",
      "online": true,             // connector control+data WS bound
      "busy_sessions": 2, "idle_sessions": 1,
      "status_text": "refactoring gateway", "status_emoji": "🔧",
      "cost_today_usd": 1.42,     // UTC day, sum over bot's sessions in channel
      "pending_count": 1
    }
  ]
}
```

Answering an approval reuses the existing
`POST /channels/:cid/permissions/:request_id/resolve` unchanged.

### Data sources (no new tables, no migrations)

| Field | Source |
|---|---|
| pending approvals | `messages` rows with `msg_type='permission'`, unresolved — cross-channel variant of `domain/approval.rs::find_pending` |
| `actionable` | the same 3-way authorization used by `api/approval.rs::resolve_permission`: bot owner ∪ per-kind `approval_delegations` ∪ RESPOND grant in `bot_event_access` |
| SEE gate | `bot_event_policy::resolve_access` per (bot, channel, caller) |
| `online` | `bot_locator.is_online` (same signal as `gateway/presence.rs`) |
| `busy/idle_sessions` | `cheers_sessions.status` counts per bot+channel |
| `status_text/emoji` | bot self-status columns (migration 0040) |
| `cost_today_usd` | `bot_usage_events`, per-bot rollup for the current UTC day (sibling of the per-session aggregation in `resource/usage.rs`) |

Implementation pattern for `actionable`/SEE: fetch candidate rows in SQL, then
evaluate policy per row in Rust — the same shape as
`api/approval.rs::filter_traces_by_see`. Pending-approval volume is small;
pushing policy resolution into SQL is not worth it.

### Security decision: fail-closed

`agent_bridge.rs::allowed_seers` deliberately fails **open** on a rules-query
error (live in-channel fanout degrades to visible). The Fleet endpoint must do
the opposite: **on any policy-resolution error, drop the item** (and log). An
aggregation surface multiplies the blast radius of a fail-open default — a DB
hiccup must not reveal every pending approval in the workspace to every member.

## Live updates

- **P1** — fetch on mount + refetch when relevant frames arrive on the existing
  WS (`presence`; `message` frames carrying `msg_type='permission'`; `message_done`).
  No gateway changes.
- **P2** — start emitting the currently dead `bot_processing` frame (the frontend
  handler already exists at `useChatRealtime.ts` but no gateway site emits it):
  `working` when a prompt is dispatched, `idle` on turn completion
  (`gateway/stream.rs` terminal path). Drives the status chips live and the rail
  badge.

## Phasing

| Phase | Scope | Notes |
|---|---|---|
| **P1** | `GET /workspaces/:id/fleet` (domain queries + handler + route), `/fleet` page, WorkspaceRail button; approvals reuse `PermissionCard` with a channel-context prop | no schema changes |
| **P2** | emit `bot_processing`, cost-today rollup polish, rail badge with pending count | fixes the half-wired WS type |
| **P3** | per-channel fleet mini-strip in the work lane; inbox filters (by bot/channel/kind); shortcut from a card to delegation management | |

## Out of scope (deliberately)

- Chain budgets / pause-on-overrun (Cost governance) — separate roadmap item;
  `CostPanel.tsx` already notes the pause-gate as unbuilt.
- Bot-to-bot dispatch under the grant matrix — the second wedge, needs its own
  design doc.
- A "claim" mechanism for approvals — CAS + broadcast collapse is enough until
  proven otherwise.

## Cross-cutting cleanups this touches

- If Fleet ever emits a `board_signal`, first extract the board-name string
  contract ("plan" / "cost" / "commands" / "files" / "workspace" / "activity")
  into shared constants — it is currently a bare-string contract across slices.
