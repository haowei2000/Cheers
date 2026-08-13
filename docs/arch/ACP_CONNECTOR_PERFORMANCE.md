# ACP Connector Performance Architecture

## Goals

The connector prioritizes bounded resource use and interactive latency over raw
unbounded throughput. Permission, elicitation, authentication, cancellation,
and terminal state must stay responsive while an agent emits dense text
streams or several sessions prompt concurrently.

## Bridge data lanes

Outbound data uses two bounded channels:

- priority lane (64 frames): interaction, terminal, trace, resource, and other
  non-Delta frames;
- streaming lane (256 frames): text Delta only.

Separating the lanes prevents a full streaming queue from blocking a permission
or elicitation producer. The socket writer consumes both lanes fairly, so
inbound ACK and resolution frames cannot be starved by sustained output.

Permission, elicitation, and authentication frames may overtake a pending text
batch because the user is blocking the agent. Other priority frames are ordering
barriers: queued Delta is flushed before done/error/trace is written.

## Delta coalescing

Adjacent compatible Delta frames are combined until either:

- the stream is quiet for 12 ms;
- the combined UTF-8 payload reaches 8 KiB;
- the message/session identity changes; or
- an ordering barrier is written.

The merged frame retains the newest connector diagnostic sequence number. The
Gateway continues to assign its own authoritative sequence, so coalescing does
not weaken stream ordering or trust boundaries.

## Runtime lock domains

`SharedRuntimeState` is a container rather than one global mutex. Its independent
lock domains are:

- active-run multi-index registry;
- pending human interactions;
- pending loopback resources;
- per-provider session locks;
- read-heavy channel-name map;
- workspace watcher lifecycle.

The three active-run indexes intentionally share one mutex so insertion and
removal remain atomic. Splitting unrelated state removes cross-session lock
contention without introducing inconsistent indexes.

## JSON ownership

High-frequency official-runtime `session/update` messages move the `update`
subtree out of the owned JSON envelope instead of deep-cloning it. Non-streaming
updates are analyzed by reference before the original payload is moved into the
Bridge frame. Elicitation waiters retain only the parsed mode instead of a second
copy of the raw request. Raw payloads remain lossless at protocol boundaries.

Some low-frequency clones remain deliberately: permission tool-call snapshots
must outlive their update and are capped at 32 entries per run.

## Bounded official-runtime concurrency

The official runtime has separate work classes:

- prompts: 16 in flight, 32 queued;
- lifecycle/control requests: 32 in flight, 64 queued.

Saturated queues fail the new request explicitly instead of spawning an
unbounded Tokio waiter. Separate classes reserve control capacity so prompt
pressure cannot consume all runtime request slots.

These are connector-side safety bounds, not agent capability claims. Agent and
Bridge timeouts still apply normally.

## Verification

Contract tests cover Delta compatibility, size caps, latest-sequence retention,
and interactive classification. Full connector tests, locked checks, and release
builds remain required before release. Production tuning should use observed
Delta rate/size, channel saturation, ACK RTT, lock wait time, in-flight request
count, CPU, and RSS rather than increasing queue capacities blindly.
