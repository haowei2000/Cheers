# Platform-resource permissions (non-ACP operations)

> Status: **adopted (interim)** — 2026-07-03. Companion to
> [BOT_PERMISSION_MODEL.md](./BOT_PERMISSION_MODEL.md) (the ACP-keyed model) and
> [BOT_CONFIG_GOVERNANCE.md](./BOT_CONFIG_GOVERNANCE.md) (the L0/L1/L2 sovereignty axis).
> First citizen: `workspace/write` (safe remote file writes).

## The question

`BOT_PERMISSION_MODEL.md` states **"the ACP operation is the unit of permission… we never
invent an operation taxonomy."** But Cheers has grown operations that ACP does not model at
all — the human reaching into a bot's machine over Cheers' own `workspace_req` protocol
(browse / read / **write** / git / future watch). ACP's fs is *agent→client*; these are
*human→connector*. So: where should authorization for **non-ACP** operations live?

## Three permission planes

Keep these conceptually distinct even though the lower two share the same resolver
(`server/src/domain/bot_event_policy.rs`).

| Plane | Governs | Home | Enforcement |
|---|---|---|---|
| **L0 — host firewall** | which capabilities the machine owner permits at all: `allowed_roots`, `git_ops`, fs/terminal locks | connector TOML (`policy.*`) | connector, user-independent, the hard floor |
| **ACP-event grants** | the agent conversation: `prompt`, `tool_call`, `permission_request`, `set_mode`, `cancel`, `output`, `plan`, `trace` | ACP (`Home::Agent`) | `(subject × event-class × capability)` matrices |
| **Platform-resource grants** | Cheers-native operations on a bot's resources: `workspace/write`, (future `workspace/watch`, `workspace/rm`) | Cheers (`Home::Cheers`) | same resolver + grant UI, distinct namespace |

The key invariant: **the ACP-event vocabulary stays pure** — only real agent events go in
it. Platform-resource operations are marked `Home::Cheers` in the event registry
(`server/src/domain/acp_events.rs`) so they are never confused with agent ACP events, even
while they reuse the grant *engine* (owner-default + grantable, per-user overrides, the
`BotPermissionGrantsSection` UI, and the `channel_operations` audit loop).

## What belongs where

- **Mutation / destructive / sensitive resource ops → a platform-resource grant.**
  `workspace/write` is owner + admin by default, grantable to other members by the bot
  owner. Enforced *after* channel-membership (`ensure_access`), fail-closed
  (`server/src/api/workspace.rs::gate_write` → `resolve_can_write`).
- **Resource reads → channel membership + the L0 host toggle.** `ls`/`read`/`git_*` stay
  membership-gated; the connector's `allowed_roots` (+ `git_ops`) is the owner's floor. Add
  a `workspace/read` grant only if a resource is sensitive enough to warrant it — do not add
  one reflexively.
- **Signal / fanout events → membership, no new grant.** `board_signal` / (future)
  `workspace_signal` are data-free; clients refetch through an already-authorized read, so
  authorization lives on the read, not the notification. Gate an event only if it must carry
  a payload, and then under that resource's `*/read` permission.
- **Audit → the resource plane feeds the same closed loop.** Every platform-resource
  mutation records a `channel_operations` row (see
  [BOT_PERMISSION_CLOSED_LOOP.md](./BOT_PERMISSION_CLOSED_LOOP.md)), exactly as ACP
  operations do — `workspace.write` rows now appear on the activity board.

## Guardrail: don't over-model

Every grant class is governance UI + cognitive load + (potentially) a migration. Only add a
platform-resource class when a real operation needs owner-governed delegation. Do **not**
mirror all of ACP into the resource plane.

## Interim vs target

**Interim (adopted):** `workspace/write` lives in the existing engine as an
`OWNER_DEFAULT_INITIATE` class, tagged `Home::Cheers`. This ships write-safety now, reuses
the tested grant machinery and UI, and the `Home` axis already gives real separation.

**Target (open, deferred):** if the resource plane grows several classes
(`workspace/{read,write,watch}`, `git/read`), promote it to its own namespace / `Plane` axis
so `INITIATE` no longer doubles as "may cause a resource op." Migrating a `Home::Cheers`
class to a dedicated plane is a contained refactor — nothing about the interim choice blocks
it. Revisit when the second or third resource class lands.
