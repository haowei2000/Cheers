# Built-in Agent: one generic runtime, identities as data

> **Status**: Design (v1) · **Decided**: 2026-05-31 · **Language**: English default
>
> This document records the decision to **delete all hand-written built-in bot
> classes** (`HttpBot`, `Coordinator`, `Helper`, `HelpBot`) and replace them with
> **one generic ACP Agent runtime** that connects at startup. It extends
> [context-and-environment.md](./context-and-environment.md) (behavior = Environment
> template) and [DECENTRALIZED_MESH.md](./DECENTRALIZED_MESH.md) (routing = `@mention`,
> no Coordinator). It supersedes the per-adapter built-in bot model still described in
> [ACP_INTEGRATION §3.2](./ACP_INTEGRATION.md) and the four-bot topology boxes in
> [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) and [REFACTOR_PLAN](./REFACTOR_PLAN.md).
>
> This is a **clean rebuild**, not a migration. There is no legacy code to preserve
> and (pre-launch) no production data to migrate — the old `bot_runtime/adapters/`
> tree is deleted outright, not ported.

---

## 1. The decision

A "built-in bot" used to be a Python class with hardcoded prompt, memory layers, and
(for `Coordinator`) routing logic. That is gone. A built-in bot now decomposes into
**three orthogonal axes**, and only one of them is code:

| Axis | Count | What it is | Form |
|---|---|---|---|
| **Runtime** | **exactly 1** | the generic agent loop: receive task → pull context via `resource_req`/MCP → call LLM → stream `delta`/`done` | **code, written once, no per-bot branches** |
| **Identity** | **≥1, data-driven** | a `bot_account` (token, `trust_level=system`, name/avatar); one `(control, data)` WS pair per identity | **seeded rows + config, not code** |
| **Behavior** | **N, per channel** | mention etiquette, reply format, scenario rules, initial files | **Environment template** (`seed` + convention prompt), see [context-and-environment §2.3](./context-and-environment.md) |

> **"A built-in ACP Agent that connects at startup" = 1 runtime + ≥1 seeded identity.**
> The runtime is the only thing you write. Identities are data. Per-scenario behavior
> is an Environment template. Adding a built-in persona is *seeding a row + binding a
> template*, never writing a class.

---

## 2. Burn list (deleted, not ported)

Clean rebuild — these carry no value and the new runtime inherits none of them:

- `Coordinator` and any LLM-routing / `AutoTakeoverStage` logic — replaced by the
  mesh's deterministic `@mention → bot_id` lookup ([DECENTRALIZED_MESH §1–2](./DECENTRALIZED_MESH.md)).
- `Helper`, `HelpBot`, and every other per-bot adapter class with a hardcoded prompt
  — collapse into the generic runtime + an Environment template.
- The `bot_runtime/adapters/` tree and the per-adapter `pipeline/` scaffolding.
- Hardcoded memory layers (`ANCHOR` / `DECISIONS` / `PROGRESS`) — now files the
  default Environment **seeds** (policy moved from code to data).

Because this is pre-launch, deletion is a **hard delete**: drop the code, reset the
schema. No tombstones. (The one thing that would change this: if real user history
already references old built-in `bot_account` IDs, those rows must be tombstoned —
not hard-deleted — to keep Class-1 message history readable. Absent that data, ignore.)

---

## 3. Deterministic actors are NOT bots

Some old "bots" (e.g. `HttpBot`-style webhook/automation logic) are **deterministic**:
"on event X, do Y." These do **not** belong in an LLM runtime.

- Do not fold deterministic logic into the generic agent loop — that makes it
  non-deterministic and burns tokens for nothing.
- If the new system needs deterministic behavior, model it as a **domain action /
  Environment `tool`** ([DECENTRALIZED_MESH §7](./DECENTRALIZED_MESH.md)) or a system
  actor, designed fresh as part of the capability layer — not as a "bot".
- The judge: **does it need to reason?** No → it is a tool, not an agent.

---

## 4. The runtime invariant

> **No per-bot branch in the runtime.** If the agent loop ever contains
> `if bot_name == "coordinator"` (or any per-identity special case), the old burden
> is resurrecting. Everything that differs between built-in personas lives in **data**:
> different behavior → Environment template; different capability → a `tool` + Grant;
> different identity → a `bot_account` row.

The runtime is a pure function of `(task, resources, prompt)`. It does not know which
persona it is serving beyond the token it authenticated with.

---

## 5. Identity count is a deliberate choice (mesh peers)

The number of built-in identities is **not** an implementation default to drift into —
it is a design decision tied to the decentralized mesh:

- The mesh ([DECENTRALIZED_MESH](./DECENTRALIZED_MESH.md)) exists so bots can `@` each
  other (`@researcher` → `@writer`; `A@B@A` chains). **With only one built-in identity,
  built-in Bot@Bot never triggers** — `task_chains`, the dispatch gate, and chain-cancel
  spin idle for built-in scenarios (they still serve external bots).
- Therefore: **one runtime, identity count data-driven.** Seed one default identity for
  v1; seed more (researcher / writer / domain assistants) as rows + bound templates,
  with **zero new code**. This keeps the mesh's multi-peer capability without
  reintroducing bot classes.
- `channel.default_bot_id` ([DECENTRALIZED_MESH §2](./DECENTRALIZED_MESH.md)) is the
  *role* "who answers when no `@`" — a **binding** to some identity, distinct from any
  runtime implementation.

---

## 6. Scaling consequence (inherent to the protocol, not legacy)

The topology rule "a bot has exactly one `(control, data)` WS pair; a second connection
with the same token is superseded (close 4402)" ([context-and-environment §1](./context-and-environment.md))
means a single identity is **inherently single-connection, single-process**.

- You **cannot** scale one built-in identity by running two replicas — the second
  supersedes the first.
- Horizontal scaling of built-in compute is therefore done by **sharding channels
  across multiple identities**, not by replicating one identity. This is another reason
  identity count is data-driven (§5).
- Consistent with single-instance Phase 1; the trait seams (`Fanout` / `BotLocator`)
  and per-identity sharding carry it forward without protocol change.

---

## 7. Target shape

```
┌─ ACP Agent Runtime (one loop, no subclasses, no per-bot branch) ─┐
│   task → resource_req/MCP (pull context) → LLM → delta/done       │
└───────────────────────────────────────────────────────────────────┘
        ▲ one (control,data) WS pair per identity; all boot-connected
        │
   ┌────┴──────────────────────────────────────────────────┐
   │  Identity   = data  (bot_accounts, trust=system, token) │  ← seed
   │  Behavior   = data  (Environment: seed + convention)    │  ← per channel
   │  Capability = Resource API + tools (incl. deterministic │  ← capability layer
   │               actors as domain actions, never as bots)  │
   │  Routing    = mesh @mention, no Coordinator             │  ← protocol rule
   └─────────────────────────────────────────────────────────┘
```

---

## 8. Impact on existing docs

| Doc | Change |
|---|---|
| [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) | topology box "内置 bot（HttpBot, Coordinator, Helper, HelpBot）" → "generic ACP Agent runtime; identities seeded as data" |
| [ACP_INTEGRATION §3.2](./ACP_INTEGRATION.md) | `adapters/` (coordinator/helper/help_bot) deleted; Agent Service = one generic runtime |
| [ACP_INTEGRATION §7](./ACP_INTEGRATION.md) | "搬到 Agent Service" → "deleted; rewritten as one generic runtime"; deterministic logic → tools |
| [REFACTOR_PLAN](./REFACTOR_PLAN.md) | same four-bot box; same correction |
| [DECENTRALIZED_MESH §1](./DECENTRALIZED_MESH.md) | already aligned (Coordinator removed); this doc is the runtime-side companion |
| [BOT_PERMISSION §7](./BOT_PERMISSION.md) | `system` trust default still applies — to the seeded built-in identities |

---

## 9. Open / not in scope

- How many default identities ships v1 (§5) — product call; the mechanism is data-driven
  regardless.
- The generic runtime's minimal skeleton (connection mgmt + task loop + `resource_req`
  client + data-driven identity) — to be written fresh, no reference to old `bot_runtime/`.
- Deterministic-actor catalog (which §3 tools the default Environment ships) — defined
  with the Environment template work, not here.
