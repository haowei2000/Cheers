# Task Delivery and Completion

This document describes the current Rust gateway and Rust ACP connector. The
implementation is authoritative: `server/src/gateway/{dispatcher,registry,stream,reclaimer}.rs`
and `packages/cheers-acp-connector-rs/src/bridge_runtime/`.

## Dispatch

A human message is committed before the gateway dispatches any bot turns. Each
turn has a deterministic placeholder message ID derived from the trigger message
and bot IDs. The placeholder and its existing `bot_runs` record are created in
one transaction. The run's unique placeholder ID elects one dispatcher and keeps
the original task identity even after placeholder cleanup. Duplicate dispatch
does not create another execution identity.

The dispatcher registers the placeholder in `StreamRegistry`, broadcasts it, and
sends the task through the bot's control connection. The locator waits up to
500 ms for room in its bounded queue. A successful enqueue is **not** a connector
receipt or proof that agent execution started. A failed enqueue removes the
partial placeholder and emits `bot_unavailable`.

Standard tasks require negotiated `task_acceptance` on the current control
connection. The dispatcher checks it before preparing a turn and again atomically
with capturing the destination sender. A replaced or legacy connector cannot
bypass the grant requirement by ignoring the task's `acceptance_required` field.

The task carries its trigger, placeholder and task IDs, session key, trigger
context, attachments, pinned context and desired session configuration. Bot
responses arrive on the separate data connection. The browser's realtime
connection is independent of these two agent connections.

## Execution grants

The Connector reserves an in-flight task locally before asynchronously
sending `task_accept` with its task, placeholder, channel and fresh execution IDs.
The gateway locks the matching message and run, revalidates bot enablement,
writable membership and active task chain, then commits the first execution ID
and authenticated control connection ID to `bot_runs` before replying.

`task_acceptance.status` has three values:

- `granted`: this execution owns the task on this control connection.
- `owned`: another execution or control connection already owns it.
- `rejected`: the identity, active placeholder, authorization or persistence check
  failed. This never permits execution.

The same execution on the same live connection can reconfirm a committed grant.
Another connection receives `owned` even if it reuses that execution ID. A
completed, deleted or missing placeholder cannot acquire a grant. Claims are
never released on timeout, disconnect, process restart or execution failure.

The Connector begins ACP work only after an exactly correlated `granted` response.
It fails closed when either peer lacks the capability, the task omits the explicit
requirement, the response mismatches, or the 30-second acceptance budget expires.
Concurrent duplicate task frames share one local reservation. Reservations end
with the local attempt; any later frame gets a fresh execution ID and consults
the durable gateway fence again. Denied or timed-out attempts send no terminal
message that could overwrite the granted owner's result.

Standard task authentication recovery prepares future work without automatically
re-prompting that task. Private evaluations and suggestion requests retain their
separate behavior. This contract prevents a second permitted execution; it does
not promise that every grant leads to an execution or a committed result.

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
restart, when no memory entry remains. Standard task results carry the original
`execution` tuple (task, execution and channel IDs), plus their placeholder and
stable UUID `client_msg_id`. Delivery on another connection does not transfer execution
ownership or obtain another execution grant.

The gateway records the terminal receipt and a fingerprint of the unsigned result
in `bot_runs` in the same transaction as message finalization. Only the capability
signature envelope is excluded from that fingerprint. An exact committed retry
returns the same successful ACK, including after a gateway restart or subsequent
message deletion. A changed result, receipt ID, execution or bot is rejected.
The receipt is retained with the execution tombstone.

Receipt replay is a read-only operation on the authenticated bot connection. It
runs before active-session authorization because a successful completion already
made that session idle. It does not touch session state, allocate a sequence,
publish another event, notify humans or dispatch another bot turn. A result with
no matching committed receipt must still pass current execution and authorization
checks before it can finalize an active placeholder.

The receipt confirms database persistence. Browser fan-out, push notifications and
downstream bot dispatch remain best-effort effects after that commit. A crash in
that gap can lose those effects; replay does not run them a second time.

## Connector result outbox

Connector 0.1.55 requires `terminal_replay` on both authenticated connections,
committed ACK support on the data connection and execution acceptance. Before
sending a standard task's Done or Error, it persists the
unsigned result in an immutable file beside its configured state file. Atomic
publication and file synchronization protect completed appends across process
interruption. The scope binds the account, gateway endpoints and authenticated
bot/host identity, so retargeting an account cannot send its old results to another
bot or gateway. This outbox contains results, not executable tasks.

A continuous result-only worker drains pending entries while the account runtime
is active and after the daemon starts again. It retries the same payload and
receipt ID with a fresh capability signature. It never creates or loads an ACP
session or invokes a prompt. A matching successful v1 ACK for the exact message,
with no queued job, removes the stored entry. A timeout, malformed or negative
ACK preserves it. Permanent rejections also remain on disk for inspection;
they are not silently discarded or retried again until the daemon starts again.

Socket closure still stops the account runtime and ACP adapter. This slice does
not add an in-process reconnect loop: the supervisor or a later daemon start
reconnects and drains its stored results. Durability starts after the append
completes; interruption between ACP completion and that append can still lose a
result.

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

The human message and bot dispatch intent are still separate transactions. A
crash between message commit and preparing its bot runs can therefore lose work.
The `resume` capability is explicitly `ack_only`; it replays no task or event log.
A quick connector restart also changes the generation and protects old registered
turns from offline recovery. Their execution ownership is retained, but there is
no protocol to resume delivery or replace that owner.

Automatic task replay is not enabled. A committed grant whose reply was lost may
remain unexecuted; a crashed owner is not replaced. The run ledger retains
execution tombstones after placeholder cleanup.

Result replay cannot recreate a missing, deleted or reclaimed partial placeholder
that never committed a terminal receipt. Offline and orphan reclamation therefore
bound the delivery window for an uncommitted result. Such a result receives a
negative ACK and remains in the Connector outbox. A result that already committed
can still obtain its receipt after message cleanup. Durable dispatch intent and
safe recovery beyond the placeholder retention window remain separate work.

## Rollout

Connector and shared protocol crate versions are 0.1.55. Gateway downloads and
installers require at least that version. Both peers must support execution
grants before standard tasks can run; older peers are refused rather than running
an unguarded task. Follow the connector release order in `AGENTS.md`: validate,
release/install the Rust binary, restart its daemon and deploy the compatible
gateway. The release pin moves only after the signed release manifest exists.

## Verification

With `DATABASE_URL` pointing at a disposable PostgreSQL database that permits
creating test databases:

```bash
cd server
cargo test --locked --features integration
cargo fmt --check
```

The tests inject real UPDATE/COMMIT failures, transaction cancellation and delayed
fan-out; verify concurrent and restart completion; and exercise offline recovery,
reconnection generation fences, busy claims and delete retries.
Acceptance tests cover concurrent owners, real WebSocket grants, commit failure,
capability replacement, authorization revocation and restart ownership. Receipt
tests cover lost ACKs, restart, changed payloads, execution isolation and rollback.
Connector tests cover durable append/reload, ACK correlation and result-only
retry, and prove that duplicate, denied, stale and timed-out grants never start ACP.
