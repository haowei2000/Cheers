# Task Delivery and Completion

This document describes the current Rust gateway and Rust ACP connector. The
implementation is authoritative: `server/src/gateway/{dispatcher,registry,stream,reclaimer}.rs`
and `packages/cheers-acp-connector-rs/src/bridge_runtime/`.

## Dispatch

A human message is committed before the gateway dispatches any bot turns. Each
turn has a deterministic placeholder message ID derived from the trigger message
and bot IDs. `INSERT ... ON CONFLICT DO NOTHING` elects one dispatcher; duplicate
calls do not execute the same placeholder twice.

The dispatcher registers the placeholder in `StreamRegistry`, broadcasts it, and
sends the task through the bot's control connection. The locator waits up to
500 ms for room in its bounded queue. A successful enqueue is **not** a connector
receipt or proof that agent execution started. A failed enqueue removes the
partial placeholder and emits `bot_unavailable`.

The task carries its trigger, placeholder and task IDs, session key, trigger
context, attachments, pinned context and desired session configuration. Bot
responses arrive on the separate data connection. The browser's realtime
connection is independent of these two agent connections.

## Terminal commits

The message row is the durable completion authority. A terminal update allocates
a channel sequence and changes `is_partial` from true to false in one transaction,
including card metadata and mentions. A conditional update prevents duplicate
completion and preserves the channel sequence on rollback.

For a registered turn, a short-lived memory claim fences concurrent terminal and
stream frames while the transaction runs. Database failure or cancellation drops
the claim and permits a later terminal attempt. After a successful commit, the
claim removes its matching task from memory immediately, before attachment loads
or browser fan-out can suspend. An old claim cannot reopen or remove a replacement
task with the same message ID.

A terminal result can also finalize an existing partial row after a gateway
restart, when no memory entry remains. The gateway returns a terminal ACK only
after successful persistence and delivery handling. The current connector retains
its ACK waiter in memory; it does not persist or automatically resend failed
terminal results.

## Abandoned placeholders

The periodic reclaimer deletes old partial rows without registered streams after
`orphan_reclaim_threshold_secs` (15 minutes by default). A registered stream
protects a slow active turn from that age-based sweep.

A closed control connection also schedules a recovery attempt after a 60-second
grace period. Its control connection ID is retained as a generation fence. The
recovery checks that this is still the latest control generation and that the bot
is unavailable before scanning and again before deleting each placeholder.
Reconnecting changes the generation, so an older timer cannot reclaim a later
connection's work. A kick uses the same recovery path as a close; setup failure
also removes its own binding. Guarded unbind operations cannot remove a newer
connection.

This offline recovery can claim abandoned registered streams. It shares the
terminal claim with completion handling, deletes only still-partial database
rows, and removes memory state only after database success. A busy terminal
transaction or temporary database failure is retried after another grace period.
Already committed messages remain intact. Transient `bot_unavailable` frames
remove reclaimed bubbles from connected browsers; no synthetic bot reply is added
to history.

Data-only cleanup removes its own binding. Offline recovery requires an actual
control close or kick; stopping an ACP runtime does not itself prove that its
sibling control socket closed. Data-only loss with a surviving control connection
remains outside this recovery path. The parked Redis locator does not expose a
safe control generation, so this recovery capability fails closed there; the
deployed runtime uses the in-process locator.

## Recovery limits

There is no durable dispatch intent, task acceptance ACK, or execution deduplication
ledger. A crash between message commit and task delivery can therefore lose work.
The `resume` capability is explicitly `ack_only`; it replays no task or event log.
A quick connector restart also changes the generation and protects old registered
turns from offline recovery. Recovering those turns requires explicit execution
ownership and a receipt contract.

Automatic task replay is not enabled. Re-executing an ambiguously delivered task
can repeat external tool side effects. A future durable-delivery change must
resolve acceptance, execution identity and terminal replay together. The existing
unused `bot_runs` table should be evaluated before adding another record store.

## Verification

With `DATABASE_URL` pointing at a disposable PostgreSQL database that permits
creating test databases:

```bash
cd server
cargo test --locked --features integration --lib --test terminal_recovery --test reclaimer_recovery
cargo fmt --check
```

The tests inject real UPDATE/COMMIT failures, transaction cancellation and delayed
fan-out; verify concurrent and restart completion; and exercise offline recovery,
reconnection generation fences, busy claims and delete retries.
