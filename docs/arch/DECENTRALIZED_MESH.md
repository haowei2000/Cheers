# Decentralized Bot Mesh

> **Status**: Design (v1) · **Decided**: 2026-05-30 · **Language**: English default ([中文](./DECENTRALIZED_MESH.zh-CN.md))
>
> This document records the agreed design for replacing the central coordinator
> with a decentralized bot mesh, the per-channel event clock (`channel_seq`), the
> two-class Resource API consistency model, the channel operations log, Bot@Bot
> task chains with cancel, and the opt-in runaway budget.
>
> This is **design intent ahead of code**. It extends
> [context-and-environment.md](./context-and-environment.md) (the two-class file
> model is the foundation here) and [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md).
> Verify against `gateway/src/` before implementing — most of this is net-new or
> fills in explicit Phase-1 stubs (see §10).

---

## 1. Why: no coordinator

The current built-in `Coordinator` uses an LLM agent to *guess* which bot should
answer a message. That routing is non-deterministic and hard to test. The mesh
replaces it with a deterministic protocol rule: **the channel only forwards `@`**.

- No scheduler. The channel does `@entity → forward to that user/bot`.
- All bots are equal peers; built-in == external, same Agent Bridge path. The
  `Coordinator` routing privilege and `AutoTakeoverStage` are removed.
- `trust_level` still differs (built-in `system` vs external) but only affects
  *write Grants*, not routing.

This makes Bot@Bot composition transparent (every hop is a visible channel
message) and routing a deterministic `@mention → bot_id` table lookup.

---

## 2. Dispatch model

```
message arrives
  ├─ contains @bot → dispatch to that bot   (a bare @user is only a notification)
  └─ no @bot       → look up channel.default_bot_id
                       ├─ set   → dispatch
                       └─ unset → silent (message persists, no bot triggered)

bot reply (containing @botB) → persists as a normal message → triggers botB
```

The gateway dispatch logic degrades to an O(1) lookup with no AI in the path.

**Decisions:**
- No `@` and no default bot → **silent** (the message is still recorded).
- All `@` messages are **visible** in the channel.
- Bot@Bot has **no depth cap** (see §8 for chains + cancel + §9 for the budget).
- **Mention source (decided 2026-05-31):** `@` is carried in content as a flat token
  `<@bot:id>` / `<@user:id>` ([MESSAGE_CONTENT_FORMAT](./MESSAGE_CONTENT_FORMAT.md)) and
  written at message-write time into a `message_mentions(msg_id, member_id, member_type)`
  join table (see [context-and-environment §5.2](./context-and-environment.md)), inside
  the same transaction that allocates `channel_seq`. Only `<@bot:…>` triggers dispatch;
  `<@user:…>` is notification only and `<#file|chan:…>` are inert. `resolve_bot_triggers`
  uses the parse result already in memory (no re-read); `@me` notifications reverse-look-up
  the table by `member_id`. The legacy `mention_bot_ids` / `mention_user_ids` JSONB columns
  are dropped. `channel.default_bot_id` overrides `workspaces.default_bot_id`.

---

## 3. The channel clock: `channel_seq`

A single per-channel monotonic, **gap-free, contiguous** sequence is the backbone
of ordering and recovery.

```sql
ALTER TABLE channels ADD COLUMN next_seq BIGINT NOT NULL DEFAULT 0;   -- per-channel counter
ALTER TABLE messages ADD COLUMN channel_seq BIGINT;                   -- NULL while partial
CREATE UNIQUE INDEX idx_messages_channel_seq
  ON messages(channel_id, channel_seq) WHERE channel_seq IS NOT NULL;
```

**Allocation (correctness core)** — inside the event's commit transaction, under a
row lock, so `seq order == commit order`:

```sql
UPDATE channels SET next_seq = next_seq + 1 WHERE channel_id = $c RETURNING next_seq;
-- then write the returned seq onto the row
```

> **Requires `create_message` to become transactional.** The current Rust
> `domain/messages.rs::create_message` is a standalone `INSERT` followed by fanout
> (no transaction). Gap-free allocation needs `BEGIN; UPDATE channels … RETURNING;
> INSERT messages (… channel_seq …); COMMIT;` **before** the fanout — the seq must be
> on the row and in the wire frame. This is a structural change, not a column add.

**Two allocation paths — by message origin:**
- **User messages are born final** (`is_partial = FALSE` at INSERT, see
  `messages.rs`) → allocate `channel_seq` **at INSERT**, in the same transaction.
- **Bot placeholders are born partial** → allocate `channel_seq` **at finalize**
  (`is_partial` TRUE→FALSE), so abandoned streaming placeholders never consume a seq.

- Rollback releases the increment → **no gaps**.
- A global `BIGSERIAL` is **wrong**: its value order can differ from commit order,
  so an incremental `> cursor` read could permanently skip a late-committing lower
  seq. The per-channel row lock serializes writes and prevents this.
- **Greenfield: no backfill.** Empty tables satisfy gap-free trivially; `next_seq`
  starts at 0 and no existing rows need `channel_seq` assigned. The active-recovery /
  high-water reconcile machinery (§4) is a multi-instance / live-fan-out concern, not
  a v1 migration step.

> **Three distinct seqs — do not conflate:**
> - WIRE `seq` — per-`msg_id`, 0-based, streaming delta dedup (frame layer).
> - `agent_bridge_events.seq` — per-`(bot, stream)`, bridge replay (transport layer).
> - `channel_seq` — per-channel, domain event timeline + recovery index (**new**).

`channel_seq` is allocated for **every** channel event (message *and* operation,
see §6), so the channel has one total-ordered event stream.

---

## 4. Consistency: two file classes, relaxed

Consistency is **split by file class** (per
[context-and-environment.md §2.2](./context-and-environment.md)). The earlier
"how to version memory" confusion came from not splitting them.

| | **Class 1 — self-maintained** | **Class 2 — agent-edited** |
|---|---|---|
| Examples | message history, operations, file index, members | progress.md, anchor.md, scenario files |
| Truth lives | elsewhere (messages / operations / file_records / membership) | in the file itself (the memory tree) |
| Consistency primitive | `channel_seq` (append-only) | per-path `version` (optimistic lock) |
| Read | read-current + incremental cursor + index recovery | read-current |
| Change | **no fs.write** — only domain actions | `fs.write`/`fs.edit` with `if_version` |
| Recovery | `messages.index` high-water reconcile | `version` mismatch → re-read |

**Invariant: one write authority per path.** A path is either system-written
(Class 1) or agent-written (Class 2), never both.

### Relaxed consistency (the key simplification)

ACP agent output is inherently non-deterministic, so we **do not** freeze a
snapshot per task. The guarantee is weaker but sufficient:

> **Monotonic completeness**: any committed event is never permanently invisible to
> a bot; the next time it is `@`-ed it can read the complete picture via the
> Resource API.

This is satisfied for free by **read-current + Write-Before-Deliver** (the
`is_partial = FALSE` filter means a bot never reads a torn/half-streamed message;
once finalized it is visible to every later read). There is **no snapshot pinning
and no connector seq injection** — both were considered and dropped.

What we knowingly give up: cross-resource point-in-time consistency (messages vs
memory may be read microseconds apart). Acceptable given ACP non-determinism and
re-read on next trigger.

### Incremental cursor + active recovery

- Incremental read: a bot stores `last_seq` and reads `channel_seq > last_seq`.
  Gap-free commit-ordered allocation guarantees `> cursor` never skips.
- The task frame carries `trigger_seq` (the trigger message's `channel_seq`) as a
  reference point; the bot owns its cursor (e.g. in its `channel.memory`). The
  gateway stays stateless about per-bot cursors.
- Active recovery: `channel.messages.index` returns `{ min_seq, max_seq, count }`
  (+ optional headers without content). Because the stream is contiguous, a bot
  can compute exactly what it is missing and fetch it by range/seq. This is the
  self-heal path for crashes and the best-effort live fan-out — consistent with the
  existing `message_done` self-heal philosophy.
- Known limit: a pure `> cursor` does not re-surface edits/deletes of
  already-seen messages (seq unchanged); the header index (`edited_at`/`is_deleted`)
  covers that if needed. Out of scope for v1.

### Memory write fix

The only change needed on the existing memory path before it is replaced by
`fs.*`: wrap the `replace` mode (`DELETE` + loop `INSERT`) in a **transaction** to
remove the torn-read window.

---

## 5. Resource API structure

```
Class 1 — self-maintained (agent read-only; change = domain action; system stamps channel_seq + records an operation)
  channel.messages.{read, index, by-seq}          ← channel_seq model (§3)
  channel.activity.read(since_seq)                 ← unified event stream (messages + operations interleaved)
  channel.files            read; change = upload/delete domain action
  channel.members          read; change = invite/remove domain action

Class 2 — agent workspace (uniform fs.*; per-path version optimistic lock)
  fs.{ls, read, write(if_version), edit(old→new, if_version), append, rm, mv}
  ← backed by a NEW memory_files tree (materialized path); replaces the old memory_entries layer model
  ← every write also emits a Class 1 operation event (system-written, different resource → no invariant violation)

Environment layer (sits ABOVE the Resource API)
  seed  → bulk-write memory_files + inject convention prompt
  lens  → file → UI render rules (frontend; not a resource)
  tools? → scenario-specific domain actions (require dynamic per-channel resource registration)
```

`memory_files` storage: materialized `path` (subtree via `WHERE path LIKE 'a/b/%'`),
per-node `version` for optimistic locking, partial edit via string-replace, multi-file
edits wrapped in a DB transaction. Binary/large files stay in `file_records`.

---

## 6. Channel operations log

File changes (and other non-conversational happenings) **do not drive dispatch**
but **must be recorded** in the channel.

- **Decision: an independent `channel_operations` table** (carries its own payload),
  not a thin pointer index.

```sql
-- NOTE: VARCHAR(36) throughout to match the baseline schema (channels.channel_id,
-- bot/user ids are all VARCHAR(36), not UUID). Using UUID here would break the FK.
CREATE TABLE channel_operations (
    id           VARCHAR(36) PRIMARY KEY,
    channel_id   VARCHAR(36) NOT NULL REFERENCES channels(channel_id),
    channel_seq  BIGINT NOT NULL,        -- from the same channels.next_seq counter
    op_type      TEXT NOT NULL,          -- fs.write | fs.rm | file.upload | member.join | chain.cancelled ...
    actor_type   VARCHAR(16) NOT NULL,   -- bot | user | system
    actor_id     VARCHAR(36),
    target_ref   TEXT,                   -- path / file_id / member_id
    payload      JSONB,
    created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_chan_ops_seq ON channel_operations(channel_id, channel_seq);
```

`channel.activity.read(since_seq)` = `messages UNION channel_operations` ordered by
the shared `channel_seq`. The contiguous global stream reassembles into one ordered
activity feed; a bot's cursor reads over it and sees messages + operations interleaved.

- Only **message-type events with `@mention`** trigger bots. Operations are recorded,
  visible, and replayable but **inert for control flow**. Files are the blackboard;
  `@` is the signal.
- **Decision: operations are NOT fan-out** to browsers. The realtime layer
  (`realtime::Fanout`) stays purely conversational (message finals + streaming
  deltas). Operations and workspace files are discovered via pull
  (`channel.activity.read`, `fs.read` + Lens), not push.

---

## 7. Environment / workspace template plugin

Per [context-and-environment.md §2.3](./context-and-environment.md). `progress.md` /
`anchor.md` are **not engine constants** — they are template-seeded data.

```
Environment plugin = {
  seed:     initial file tree + convention prompt   // poured once at channel creation
  lens:     file → operable UI render rules          // frontend (View)
  bindings: path → lens
  tools?:   scenario-specific domain actions         // optional Controller extension
}
```

The Resource API stays generic (Class 1 reads + Class 2 `fs.*`); the template only
pours content and may add optional domain actions. The one new mechanism: `tools?`
require the resource dispatcher to move from the static `match` in
`gateway/src/acp_bridge/resource/mod.rs` to **per-channel dynamic registration**.

---

## 8. Bot@Bot chains: tracking + cancel

Bot@Bot has no depth cap; cascades are tracked as **chains** and stopped by user
cancel.

```sql
CREATE TABLE task_chains (
    chain_id      VARCHAR(36) PRIMARY KEY,
    channel_id    VARCHAR(36) NOT NULL,
    root_task_id  VARCHAR(36) NOT NULL,
    root_msg_id   VARCHAR(36) NOT NULL,        -- the user's triggering message
    status        VARCHAR(16) NOT NULL DEFAULT 'active',  -- active | paused | cancelled | done
    cancelled_by  VARCHAR(36),
    cancelled_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agent_tasks ADD COLUMN chain_id       VARCHAR(36);
ALTER TABLE agent_tasks ADD COLUMN parent_task_id VARCHAR(36);  -- task whose reply triggered this; NULL for root
ALTER TABLE agent_tasks ADD COLUMN depth          INTEGER DEFAULT 0;  -- observability only, not a cap
ALTER TABLE bot_runs    ADD COLUMN chain_id       VARCHAR(36);
CREATE INDEX ix_bot_runs_chain_status ON bot_runs(chain_id, status);
```

The root (user-triggered) task starts a chain; every Bot@Bot descendant inherits
`chain_id`, sets `parent_task_id`, and increments `depth`.

### Stopping is two parts — the dispatch gate is authoritative

Broadcasting cancel to in-flight bots is necessary but **not sufficient**: a bot may
have already emitted a reply whose `@mention` is queued for the next hop.

**(a) Dispatch gate — authoritative, blocks future hops.** Before launching any next
hop, check `task_chains.status`; if `!= active`, drop (no placeholder, no dispatch).
This is the real stop, and it holds even if the broadcast fails (an offline bot's run
just times out).

**(b) Cancel broadcast — best-effort, stops in-flight compute.** Enumerate the
chain's non-terminal `bot_runs` and send the **existing per-`msg_id` `cancel` frame**
(`{type:cancel, msg_id:<placeholder>, reason:chain_cancelled}`) to each bot's control
WS. **The connector needs zero change** — its `onCancel(msgId)` already stops deltas
and aborts the LLM run. Chain-cancel is a gateway-side fan-out over the existing
single-bot primitive.

### Cancel flow

```
1. user clicks ⏹ on a reply → resolve msg_id → chain_id (via bot_runs/agent_tasks)
2. UPDATE task_chains SET status='cancelled', cancelled_by=$u, cancelled_at=now()
     WHERE chain_id=$c AND status='active';     -- atomic + idempotent
3. SELECT placeholder_msg_id, bot_id FROM bot_runs
     WHERE chain_id=$c AND status NOT IN ('done','failed','cancelled');
4. for each → BotLocator → control WS → per-msg_id cancel  (best-effort)
5. in-flight partials finalized by existing logic
6. (optional) record op_type='chain.cancelled' in channel_operations
```

### Immutability

Completed replies stay (Class 1 facts, never retracted); in-flight replies are
finalized as partial; un-dispatched hops are blocked by the gate. Cancel means
"no further", not "erase what happened".

Multi-instance later: cancel routes via the `Fanout` / `BotLocator` traits; the
protocol is unchanged.

---

## 9. Runaway protection: opt-in budget

No depth cap + decentralized = a potential exponential A@B / B@A loop.

- **Decision: chain budget is opt-in, default NONE (unbounded).** The product
  default relies only on the user ⏹ to stop. The budget is a configurable safety
  valve, **not** a hard depth cap.
- **Placement: channel-level, NOT per-bot `effective_config`.** A chain crosses
  multiple bots, so it cannot live in `build_effective_bot_config` /
  `ChannelMembership.bot_override_config`. It lives in a channel-level settings JSONB
  (`chain_budget`, default NULL); an Environment template may seed a default.
  Multi-layer merge = take-the-minimum (per the
  [BOT_CONFIG_LAYERING](./BOT_CONFIG_LAYERING.md) limits rule). Unit is configurable:
  task-count (recommended default), token, or cost.
- **Mechanism reuses the dispatch gate.** It adds the `paused` status (resumable,
  unlike terminal `cancelled`); the gate's `status != active` blocks both. On budget
  breach: set `paused` + post a system message with continue/stop; user continues →
  status back to `active` + re-dispatch the held hop. No new control path.
- Optional extras: cycle observability via `parent_task_id`; same-node dedup (same
  bot + same `trigger_msg_id` more than N times → abort that node only).

---

## 10. Impact on the current Rust gateway

Most of this is net-new or fills in explicit Phase-1 stubs; the architectural seams
already exist.

**Already aligned (foundation, no change):** `Fanout` / `BotLocator` traits;
Write-Before-Deliver in `create_message`; the `resource_req` static dispatcher;
deterministic placeholder id (UUID v5) idempotency; the permission/Grant engine.

**Conflicts (existing behavior to change):**
- `domain/messages.rs::resolve_bot_triggers` currently triggers **all online bots**
  in the channel (its own TODO notes "@mention / coordinator routing" is unbuilt).
  This is the opposite of the mesh and is the biggest behavioral reversal.
- `resource/memory.rs::handle_update` `replace` is not wrapped in a transaction
  (torn-read).
- Message reads order by `created_at`; the cursor model needs `channel_seq`.

**Missing (net-new):** `channel_seq` (+ allocation), `channels.default_bot_id`,
Bot@Bot re-entry on finalize (absent in Rust — it lived in the Python
`trigger_sub_bots_from_mentions`), `task_chains` + chain columns, the dispatch gate,
`cancel_chain`, `channel_operations` + `channel.activity.read`, `memory_files` +
`fs.*`, `messages.handle_read` `since_seq`/index, dynamic Environment tool registration.

---

## 11. Implementation sequence

Each step is independently testable. Ordered so the **behavioral reversal lands
first** (fewest dependencies, highest value) and pure infra follows.

1. **Migrations first — lock the schema.** Add: `channels.next_seq` +
   `channels.default_bot_id`; `messages.channel_seq`; `message_mentions` (the @mention
   join table, §2 / [context-and-environment §5.2](./context-and-environment.md));
   `task_chains` + chain columns; `channel_operations`; `memory_files`. **DROP**:
   `memory_entries` (the old layer model — clean rebuild, not coexistence) and the
   legacy `mention_bot_ids` / `mention_user_ids` columns. All ids `VARCHAR(36)` to
   match baseline.
2. **Rewrite `resolve_bot_triggers`** — all-online-bots → parse `@` into
   `message_mentions` at write time + read it / fall back to `channels.default_bot_id`
   (overrides `workspaces.default_bot_id`). **This is the key behavioral reversal and
   needs no `channel_seq`** — it flips the system to the decentralized mesh on its own.
3. **`channel_seq` allocation** — make `create_message` transactional (see §3: it is
   currently a standalone INSERT) and allocate on the two paths (user message at
   INSERT, bot placeholder at finalize). The coordinate everything below builds on.
4. **Bot@Bot re-entry + chain propagation + dispatch gate** — on reply finalize,
   re-run `@`-resolution → dispatch next hops with `chain_id` and status gate.
5. **`cancel_chain`** — flip status + fan-out the existing cancel frame.
6. **Resource layer** — `since_seq`/index, `channel.activity.read`, `fs.*` +
   `memory_files` (old `memory.*` retires).
7. **Environment dynamic tools** — upgrade the resource static `match` to a registry.

Steps 1–2 already make the system decentralized (routing is the reversal; it does not
depend on `channel_seq`). Step 3 lays the ordering/recovery coordinate that 4 and 6
build on. 4–7 complete the capability set.

---

## Open / not in scope

- E2EE (per SECURITY / E2EE_NOTES — out for this period).
- Multi-instance fan-out (trait seams reserved; protocol unchanged when added).
- Edit/delete recovery beyond the cursor model (header index if later needed).
