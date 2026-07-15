# Bot-to-bot dispatch under the grant matrix — design

> Status: 📝 **Design accepted, not yet implemented** (2026-07)
> Roadmap: multi-agent governance track, the "moat" feature
> ([ROADMAP.md](../ROADMAP.md) → Strategic Direction).

## The one-sentence pitch

An agent can `@` another agent to hand off a subtask — but **every such
dispatch passes the same `user ▸ group ▸ role ▸ *` grant matrix humans do, under
a first-class `Dispatch` capability, and every decision (allow *and* deny) is
audited.** Bridges (OpenAB et al.) have bot-to-bot messaging; none can say
"agent A may command agent B, here's who allowed it, here's the trail." That is
the governance edge, and it exists only because Cheers owns the identity model.

## What already exists (and why this is hardening, not greenfield)

Bot@bot triggering already works and is already gated — see
[DECENTRALIZED_MESH.md §8](../arch/DECENTRALIZED_MESH.md) for the cascade spec.
The current gate lives in
[`domain/chains.rs:98-120`](../../server/src/domain/chains.rs) inside
`trigger_bot_replies`:

```rust
// chains.rs — today
let may_prompt = acp_policy::allows(
    db, &bot_id.to_string(),        // rules loaded for the TARGET bot
    &channel_id.to_string(),
    &author_bot_id.to_string(),     // triggering bot shoved into the user_id slot
    BOT_INITIATOR_ROLE,             // role = "bot"
    "session/prompt", Capability::Initiate,
).await.unwrap_or(true);            // fail-OPEN
```

Three cascade guards already bound loops and are **out of scope** here — we build
on them, not replace them:

- depth cap `MAX_BOT_REPLY_DEPTH = 5` (`chains.rs:52`),
- per-channel dispatch rate limiter (30/60s, `ratelimit.rs:169`),
- chain cancel gate `task_chains::is_active` (`chains.rs:58`).

The problem is not that bot@bot is ungoverned — it's that the governance is
**invisible, unauditable, and fail-open**:

1. **No first-class bot subject.** To deny bot A → bot B today, an owner overloads
   `subject_kind='role', subject_id='bot'` (all bots) or the `user` tier with a
   bot UUID. These rows are storable but invisible to `effective_matrix` /
   `MATRIX_ROLES` (`bot_event_policy.rs:363`) and the owner UI. You cannot *see*
   or *author* "who may command whom".
2. **Denials aren't audited.** A denied dispatch only `tracing::info!`-logs
   (`chains.rs:112-119`); no DB row. The core promise — a permanent trail of
   every dispatch decision — is currently false.
3. **Fail-open on error.** `unwrap_or(true)` + `task_chains::is_active` fail-open:
   a DB hiccup lets a denied dispatch through. A governance gate that opens on
   error is worthless.

This design fixes exactly those three, plus surfaces the result.

## Decisions (settled)

- **A first-class `Dispatch` capability** — a 4th column in the matrix, distinct
  from human `Initiate·prompt`. Rationale: "a human may prompt bot B" and "bot A
  may dispatch bot B" are genuinely different authorizations an owner wants to
  control independently (let humans prompt freely, restrict which *bots* can
  chain in — or vice versa). Reusing `Initiate` would fuse them.
- **Default allow (backward compatible).** Bots may dispatch each other by
  default; an owner writes an explicit `deny` to restrict. No seed rules, no
  breakage of existing cascades. We ship *auditable + surfaced restriction* first;
  tightening the default to owner-only is a separate, later decision.

## Model

### The `Dispatch` capability

Add `Capability::Dispatch` alongside `Initiate | See | Respond`
(`bot_event_policy.rs:73`). It gates exactly one thing: **one bot causing another
bot's turn to start.** Its event class is the existing `prompt` class, but
evaluated on the **`Dispatch` capability** rather than `Initiate`, so
`events_for(Dispatch)` returns `{prompt}` (`bot_event_policy.rs:41`).

The gate call in `chains.rs` becomes:

```rust
let may_dispatch = acp_policy::allows_bot_subject(
    db,
    /* target   */ bot_id,
    channel_id,
    /* initiator*/ author_bot_id,   // a BOT subject, not a user
    "session/prompt",
    Capability::Dispatch,
).await;                            // fail-CLOSED on error (see below)
```

### Bot as a first-class grant subject

Add `subject_kind = 'bot'` to `bot_event_access`
([migration 0029](../../server/migrations/0029_bot_event_access.sql) CHECK,
widened again in 0032). A dispatch rule reads:

| target bot | subject_kind | subject_id | capability | access |
|---|---|---|---|---|
| `B` | `bot` | `A` (a bot_id) | `dispatch` | `deny` — "A may not command B" |
| `B` | `bot` | `*` | `dispatch` | `deny` — "no bot may command B" |
| `B` | `bot` | `A` | `dispatch` | `allow` — carve A back in |

`subject_kind='bot'` slots into `resolve_access` precedence
(`bot_event_policy.rs:146`) at **user-tier specificity** (a specific bot is as
specific as a specific user), with `subject_id='*'` as its catch-all:

```
(chan, bot:A) ▸ (chan, bot:*) ▸ (bot-wide, bot:A) ▸ (bot-wide, bot:*) ▸ default(allow)
```

This *replaces* the `role='bot'` / `user=<botid>` overloading hack — those rows
migrate to `subject_kind='bot'` (one-shot data migration; the hack was
undocumented so blast radius is small).

### Default resolution

`default_access_for(Dispatch, …)` returns **allow** (decision above). `prompt` is
**not** added to `OWNER_DEFAULT_INITIATE` for the `Dispatch` capability. So:
absent any rule → allow; explicit `deny` rule → deny.

### Fail-closed on error (the one behavioral flip)

Unlike the fail-open human INITIATE gate, the dispatch gate is **fail-closed on
evaluation error**: if `load_rules` errors, deny the dispatch *and write a deny
audit row* (reason `policy_unavailable`). "No rule found" still means allow;
"couldn't evaluate the rules" means deny. A moat feature cannot silently open
when its own policy store is unreachable. (This diverges from `chains.rs:111`
`unwrap_or(true)` — intentional and documented.)

## Audit — the actual product

Every dispatch **decision** writes one append-only row: allowed and denied alike.
This is what makes the feature real; the gate without the trail is just a filter.

Reuse the generic ACP substrate
[`acp_event_log`](../../server/migrations/0031_acp_event_log.sql) — it already
keys on `(bot_id, channel_id, session_id, name, home, payload)` and every ACP
event flows through it. A dispatch decision is a `name='dispatch'`, `home='cheers'`
row whose `payload` carries:

```jsonc
{
  "initiator_bot_id": "A", "target_bot_id": "B",
  "channel_id": "…", "chain_id": "…", "depth": 2,
  "decision": "allow" | "deny",
  "reason": "default_allow" | "rule" | "policy_unavailable",
  "matched_rule_id": "…"          // when decision came from a stored rule
}
```

Surfacing (later phases, not the gateway change):

- **Viewboard → Audit tab** gains dispatch rows next to approval rows (the panel
  already renders `approval_audit`; add an `acp_event_log` dispatch source).
- **Fleet** can show a per-bot "dispatched by / dispatches to" edge list — the raw
  material for a future "who commands whom" graph.

## What this touches (implementation surface)

Grounded in the [permission-matrix map](#) from exploration:

| Area | Files |
|---|---|
| Capability enum + mappings | `domain/bot_event_policy.rs`: `Capability` (`:73`), `as_str`/`parse` (`:81`/`:89`), `events_for` match (`:44`), `default_access_for` (`:122`), `effective_matrix` cap loop (`:389`) |
| Bot subject | `bot_event_policy.rs` `resolve_access` (`:146`) + `matched_groups` neighbourhood; **migration**: relax `chk_bea_capability` (add `dispatch`) and the `subject_kind` CHECK (add `bot`) in a new `00xx_dispatch_capability.sql` |
| The gate | `domain/chains.rs:98-120` → new `acp_policy::allows_bot_subject` (fail-closed) |
| Audit | `domain/acp_event_log` writer (new `record_dispatch_decision`), called from the gate on both branches |
| Matrix REST + UI | `api/bot_permission.rs:311+` (event-access endpoints) gain a `dispatch` column and `bot`-subject rows; `frontend/.../BotPermissionGrantsSection.tsx` renders the 4th column and a bot-subject picker |
| Data migration | one-shot: existing `role='bot'` / `user=<botid>` INITIATE·prompt rows → `subject_kind='bot'`, capability `dispatch` |

## Phasing

| Phase | Scope | Verifiable outcome |
|---|---|---|
| **D1 — gateway** | `Dispatch` capability, `subject_kind='bot'`, fail-closed gate in `chains.rs`, audit row on every decision, data migration | A `deny` rule blocks A→B and writes a deny audit row; default still allows; `cargo test` |
| **D2 — surface** | matrix UI 4th column + bot-subject picker; Viewboard Audit shows dispatch rows | Owner authors "A may not command B" in the UI; the block + its audit row are visible |
| **D3 — Fleet graph** | per-bot dispatch edges in Fleet ("dispatches to / dispatched by") | Fleet shows the command graph of the fleet |

## Explicitly out of scope

- Changing the depth cap / rate limiter / chain-cancel (existing loop guards stand).
- Tightening the default to owner-only (a later, separate decision — this ships
  default-allow).
- Reconciling the doc/code divergences noted in
  [DECENTRALIZED_MESH.md §8](../arch/DECENTRALIZED_MESH.md) (no-depth-cap wording,
  `bot_runs.chain_id` vs `messages.chain_id`) — tracked separately.
- Approval-card-on-dispatch (a bot dispatch raising a human approval): a natural
  future compose with [ACP_APPROVAL_FLOW.md](../arch/ACP_APPROVAL_FLOW.md), not D1.

## Open questions

1. **Owner-of-bot as subject?** Should a dispatch rule be able to target "any bot
   owned by user U" (`subject_kind='bot_owner'`)? Deferred — `bot` + `*` covers
   the near-term stories.
2. **Chain attribution on proactive paths.** `chain_for_proactive_send`
   (`stream.rs:688`) infers the chain by "latest partial placeholder", which can
   misattribute concurrent same-bot turns. The dispatch audit inherits that
   imperfection; acceptable for D1, worth a note in the row.
