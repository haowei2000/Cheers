# Task Delivery and Completion

This document describes the current Rust gateway and Rust ACP connector. The
implementation is authoritative: `server/src/domain/{task_claims,sessions}.rs`,
`server/src/gateway/{dispatch_intents,dispatcher,registry,stream,reclaimer}.rs`
and `packages/cheers-acp-connector-rs/src/bridge_runtime/`.

## Dispatch

A human send commits its message, mentions, admitted bot targets, chosen sessions,
task chain, partial placeholders and `bot_runs` intents in one transaction. Any
failure rolls back the entire target set and message sequence. Interactive request
receipts share that transaction, so an idempotent retry cannot mint more tasks.
Session selection honors the targeted or promoted primary session; newly created
sessions remain idle while their work waits for delivery.

An explicit bot request still fails before persistence if its target is offline
or unready. Automatic/default targets that are unavailable at admission are
skipped, preserving ordinary human chat without creating an offline backlog.
Once a ready target is admitted, a later disconnect cannot lose its intent.

Each intent fixes its original author, trigger text, attachment IDs, sanitized
context references, bot, session/key and chain. A deterministic placeholder ID
identifies the trigger/bot pair; the unique run record keeps its task identity
even after placeholder cleanup. Recovery never re-resolves mentions, defaults or
a newly promoted primary session.

The request's immediate delivery path and the startup/periodic recovery worker
use the same database lease. Preparation loads media and current session settings
outside the message transaction, then freezes the first complete task envelope in
the existing run row. Offers retry that exact envelope while the run remains
unaccepted. They recheck current author membership, prompt policy, consent, bot
authority, selected session and chain; a permanent denial cancels the intent.
Source deletion cancels work; a source edit does not replace the accepted input.

The worker registers streams idempotently and sends through the current control
connection. The locator waits up to 500 ms for room in its bounded queue. A
successful enqueue is **not** a connector receipt or proof that execution started;
a failed enqueue retains its recoverable intent. The run progresses from
`pending` to `prepared` and then to `accepted` only when the execution grant
commits. Accepted executions are never recovered as new tasks.

An execution-owned `Done` also registers its admitted downstream bot targets in
the transaction that finalizes the parent message and terminal receipt. The
children inherit the active chain and next depth, fix their primary sessions and
handoff references, and use the same run ledger, leases and execution grants as
human dispatch. No media or locator calls occur inside that transaction.

Proactive bridge `send` and resource `channel.messages.create` use one message
creation command. Resource dispatch requires the live bot locator so readiness
is captured before the write transaction. The source message, mentions, inherited
chain, child intents and optional idempotency receipt then commit together.
Publication only broadcasts the committed DTO and accelerates delivery of those
existing intents; it never chooses targets or creates another dispatch.

A bridge `client_msg_id` maps to the shared receipt key
`bridge.send:<client_msg_id>`. During the existing 24-hour resource receipt
retention, retries return the original message without repeating broadcasts or
notifications. Legacy sends without that ID remain
non-idempotent. Resource retries retain their existing caller-supplied keys.
The process-local admission memo uses the stable receipt request identity for
rollback retries; message and task IDs keep their normal creation semantics.

Proactive intents prove that their source is a finalized, unowned bot message
with no execution ledger entry. Execution-owned sources retain the stronger
parent task, execution and committed Done receipt proof. One source kind cannot
be substituted for the other during recovery or execution acceptance.

Admission excludes self mentions, depth beyond five, unavailable targets,
read-only or disabled bots, inactive chains and denied `DISPATCH` grants. Each
policy decision is audited in the same transaction. The existing process-local
channel budget recognizes deterministic child identities within its window: a
rolled-back attempt keeps one conservative slot, while a retry of that same child
reuses it. Recovery and receipt replay consume no new admission slots or audits.
Offers and grants recheck bot-specific authority rather than human prompt policy.

Task-claim approval uses a dedicated `task_claim` actor in that same worker. The
requester must still be allowed to prompt the selected bot, and the bot must be
ready with a live primary session before approval can consume `pending`. Offline,
policy, session or database failures leave the approval available for retry.
The confirmation update, secret approval trigger, task chain, run, placeholder
and claim's `executing` state plus execution-message ID share one commit. No
offer can race ahead of that state, and no later dispatch callback rewrites it.

The secret trigger retains a NULL channel sequence; its task-frame sequence is
zero. Its real claim ID and requester prove this distinct source. It cannot be
decoded as an ordinary published human message. Recovery freezes its original
session/key and instructions and checks the approved claim, including expiry
after row-lock waits. The placeholder also retains the real claim ID after
acceptance clears the large dispatch input.

All current standard task producers share this preparation and offer path.
Historical runs without a dispatch input are not replayable. Private claim
evaluations and suggestion requests remain separate from executable tasks.

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
For recoverable intents, it also checks their source authority and selected
session. Approved claims must remain executable both for a first grant and for
same-owner reconfirmation. Acceptance clears the stored dispatch input and large task envelope in
that transaction, retaining the execution identity and later terminal receipt.

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
restart, when no memory entry remains. All `done` and task `error` results require the original
`execution` tuple (task, execution and channel IDs), plus their placeholder and
stable UUID `client_msg_id`. Delivery on another connection does not transfer execution
ownership or obtain another execution grant.

Missing or malformed execution identities are rejected before claiming a stream
or writing a message. A partial message alone, including a historical/manual row,
does not authorize completion. The retired `reply` alias is rejected; producers
must use `done` or `error`, and publish proactive messages through `send` or MCP.

The gateway records the terminal receipt and a fingerprint of the unsigned result
in `bot_runs` in the same transaction as message finalization. Only the capability
signature envelope is excluded from that fingerprint. An exact committed retry
returns the same successful ACK, including after a gateway restart or subsequent
message deletion. A changed result, receipt ID, execution or bot is rejected.
The receipt is retained with the execution tombstone.

An approved claim settles in that same transaction: `done` changes `executing`
to `completed`, while task `error` changes it to `failed`. A cancelled, expired,
superseded or mismatched claim cannot publish a fresh result. Database failure
rolls back the receipt, message and claim together. Claim updates are broadcast
after commit; receipt replay does not repeat them.

Session bookkeeping also commits with the result, using the session identity on
the stored placeholder. Caller-supplied session fields cannot redirect it. The
session becomes idle and its binding detaches only when no other active partial
turn remains; closed session states remain closed. Selection, offering and
finalization lock the session before its binding, and selection revalidates the
exact binding after a lock wait.

Receipt replay is a read-only operation on the authenticated bot connection. It
runs before active-session authorization because a successful completion already
made that session idle. It does not touch session state, allocate a sequence,
publish another event, notify humans or dispatch another bot turn. A result with
no matching committed receipt must still pass current execution and authorization
checks before it can finalize an active placeholder.

The receipt confirms database persistence, including admitted child intents for
an execution-owned `Done`. A crash before fan-out or immediate delivery leaves
those children recoverable; receipt replay never creates another child. `Error`
results do not create downstream work. Browser fan-out and push notifications
remain best-effort effects after commit and are not repeated by receipt replay.

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
protects a slow active turn from that age-based sweep. Recoverable, unaccepted
intents are also excluded from both age-based and disconnect sweeps. Their
durable worker owns recovery until acceptance, cancellation or an authorization
denial; startup order cannot make the reclaimer erase queued work.

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

Human-message and approved task-claim intents, plus children admitted by execution-owned `Done`,
proactive bridge sends and resource-created bot messages, recover automatically
until execution acceptance. Human producers include REST, scheduled sends,
integration delivery and other callers of the shared human-message command.
Completions without an execution grant are rejected, so there is no separate
postcommit mention-dispatch path. Cancellation or expiry of an approved claim
prevents further offers and grants, including reconfirmation of an existing
grant, and rejects any fresh result. The worker retires unaccepted intents when
their authority is withdrawn; accepted executions are never offered again.

The `resume` capability remains `ack_only`; it replays no socket event log. Task
offers come from the run ledger, not this capability. A committed execution grant
whose reply was lost may remain unexecuted; a crashed owner is not replaced.
Already queued frames can arrive after acceptance, but cannot obtain another
execution owner. The run ledger retains execution tombstones after cleanup.

Result replay cannot recreate a missing, deleted or reclaimed partial placeholder
that never committed a terminal receipt. Offline and orphan reclamation therefore
bound the delivery window for an uncommitted result. Such a result receives a
negative ACK and remains in the Connector outbox. A result that already committed
can still obtain its receipt after message cleanup. Safe recovery of an accepted
execution beyond the placeholder retention window remains separate work.

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
Dispatch tests cover multi-target transaction rollback, postcommit cancellation,
real-process startup recovery, frozen envelopes, lease recovery, session selection
and the exclusion of accepted executions from further offers.
Bot-child tests cover atomic parent/receipt/child rollback, interrupted delivery,
receipt replay, bot policy revocation, depth and loop limits, and shared recovery.
Proactive tests exercise both creation adapters, resource and bridge receipt
replay, chain inheritance, scoped attachments, cross-transport retries and recovery
after interruption before publication.
