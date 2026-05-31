# Context & Environment Architecture

> **Status**: Design (v1) · **Decided**: 2026-05-30 · **Language**: English default
>
> This document records the agreed architecture for how AgentNexus builds context
> for bots, how channel memory is modeled, and how per-scenario "Environments"
> are packaged as registrable plugins. It is design intent — verify against code
> (`gateway/src/acp_bridge/resource/`, `backend/app/features/memory/`,
> `backend/app/features/bot_runtime/pipeline/`) before implementing.

## 1. The problem this solves

External agents (ACP bots reverse-connected through the connector, and third-party
MCP hosts) need to **read and operate** AgentNexus. Two layers were separated early:

- **Capability layer (HOW)** — what an agent can actually execute: read messages,
  list members, edit memory. Strongly typed, discoverable, authenticated,
  enforceable. → MCP **Tools** + the gateway `resource_req` protocol.
- **Semantic layer (WHEN/WHY)** — how an agent should *behave* in a given channel:
  mention etiquette, reply format, scenario rules. Soft, prompt-delivered,
  cannot be enforced. → injected into the bot **system prompt**.

The capability layer is the substrate. The semantic layer never carries real
operations — a prompt convention must not be the only gate on "can this bot delete
that channel's messages."

### MCP exposure split (already prototyped)

- **Local stdio MCP** (`packages/agentnexus-mcp-server/`) — for the project's own
  reverse-connected ACP bot. Co-located with the agent, gets the bound channel via
  env injection. **This is the primary channel.** Most mature MCP transport.
- **Remote HTTP MCP** (`backend/app/api/v1/mcp/`) — for third-party MCP hosts
  (Claude Desktop, Cursor) that do not go through the connector. REST-backed,
  bot-token / OAuth scoped. Second phase.

Topology constraint: a bot has exactly one `(control, data)` WebSocket pair; a
second connection with the same token is superseded (close 4402). The MCP server
therefore **cannot open its own bridge WS** — it forwards each call over local IPC
to the connector, which emits `resource_req` on its existing data WS and relays the
matching `resource_res`.

## 2. The three substrates

The system reduces to three orthogonal things. **Every boundary between them is
one-directional** — this is what keeps the model from collapsing into grey areas.

| | Session | Memory | Environment template |
|---|---|---|---|
| Essence | what happened (event stream) | what was distilled (state) | what scenario this channel is (blueprint) |
| Time | append-only, immutable | mutable, current value | initial condition at creation |
| Who writes | users + bots posting | bots/users via memory tools | humans authoring the template |
| Lifecycle | permanent, accumulating | evolves with the channel | used once at creation (Seed) + resident render (Lens) |
| Substrate | graph | file tree | configuration (outputs land in Session/Memory + View) |

### 2.1 Session = message graph

Sender, thread, @mentions, per-channel membership/Grant. Immutable: a sent message
is a historical fact. The single source of truth is the messages table. You do not
"edit history" — you post a new message.

> Rejected: making files the substrate of conversation ("everything is a file").
> It would erase the structural semantics messages carry. Files are a substrate for
> *memory*, not for the conversation.

### 2.2 Memory = per-channel virtual filesystem

Each channel owns one **tree** of small text files. **Logical model is a tree;
physical storage is a DB table; access surface is filesystem-like.** These three
are independent — logically-a-tree does NOT imply stored-on-a-real-filesystem.

> Rejected: a real local filesystem as source of truth. Memory is *shared* (push
> assembly, the Rust gateway, and multiple connector instances all read it) and the
> connector runs on developer workstations — a real FS lives on one machine and
> breaks the shared model. It also gives you no MVCC / optimistic lock / multi-file
> atomicity, which you would then re-implement (a worse git). A real FS may later
> return as an optional **working copy** (materialize the DB tree into a temp dir,
> let bash run, sync back with version checks) — not v1.

#### Two file classes (the core v1 simplification)

The dividing judge is **where the source of truth lives**:

| | Class 1: self-maintained | Class 2: agent-edited |
|---|---|---|
| Examples | conversation history, file index, member roster | progress.md, anchor.md, any scenario file |
| Truth | **elsewhere** (messages / file_records / membership) | **the file itself** (the memory tree) |
| The "file" is | a projection/render of other data | first-class content |
| Read | per-purpose tool / Resource (heterogeneous) | uniform `fs.read` |
| Change | **no "edit the file"** — only domain actions | uniform `fs.write` / `fs.edit` |
| Tool shape | one-interface-per-thing | one `fs.*` set for all |

Class 1 has no "edit this file" operation. You change the file index by
uploading/deleting a file; you change members by inviting/removing; you change
history by posting. "Reading" goes through a dedicated read interface; "changing"
triggers a domain action that is **not** a file operation.

Class 2 is the real CRUD filesystem: `fs.ls / read / write / edit / rm / mv`.

#### The invariant that holds it together

> **One write authority per path.** A path is either system-written (class 1) or
> agent-written (class 2) — never both.

If something is "auto-updated by the system AND fs-editable by the agent," it is
both classes and the model collapses.守住 single-writer and it stays clean.
Corollary: if later you want the system to auto-maintain `progress.md`, that file
*becomes class 1* — the agent then only reads it and changes go through a
`request_progress_update` domain action, not `fs.write`. (v1: `progress.md` /
`anchor.md` are **pure class 2**; the system never touches them. Both agent and
user write them through the same versioned `fs` path — "system doesn't write" is
the invariant, not "only the agent writes.")

#### Storage

- **New table** (e.g. `memory_files`), do not overload the existing
  `memory_entries` (its ANCHOR/DECISIONS/PROGRESS layer model would clash).
- **Materialized path** (`path = 'notes/2026-05-30.md'`); list a subtree with
  `WHERE path LIKE 'a/b/%'`. Folders are virtual (derived from path prefixes)
  unless empty folders must persist. Move/rename of a folder rewrites descendant
  paths — acceptable for read-mostly small text. Switch to closure-table / `ltree`
  only if frequent large-subtree moves appear.
- **Version field** per node for optimistic locking. Writes carry `if_version`;
  mismatch → conflict, agent re-reads and retries. No pessimistic locks.
- **Partial edit** = string-replace (`old_string → new_string`), most reliable for
  agents; plus `fs.append`. Multi-file changes wrapped in a DB transaction
  (atomicity DB gives for free, a real FS would not).
- Binary/large files stay in `file_records` / object storage; the tree only holds
  their index entries.

### 2.3 Environment template = registrable scenario plugin

A template is a **blueprint** that splits into two parts with different lifecycles:

| | Seed | Lens |
|---|---|---|
| Content | initial file structure + scenario convention (prompt) | render templates: file → operable UI |
| Lifecycle | used once at channel creation, then退场 | resident; used on every render |
| Direction | template→channel (one-way, no回流) | file→UI→(user action)→fs write-back |
| MVC role | Model initial value | View |

Lens does not break "no回流": the render template is a pure function
`file → view`; user actions in the UI change the **file** (via fs tools), never the
template. Model = files, View = Lens, Controller = fs tools → standard MVC.

This makes a **channel scenario = one MVC plugin**:

```
Environment plugin = {
  seed:     initial file tree + convention prompt   // poured at creation (Model init)
  lens:     file → operable page render rules        // runtime (View)
  bindings: which path uses which lens               // how View attaches to Model
  tools?:   scenario-specific domain actions         // optional Controller extension
}
```

This also retires the old hardcoded built-in memory layers: `anchor`/`progress`
are no longer code-level layers but **files the default Environment seeds** — policy
moved from code to data. Scenario variety (medical / project / support) = different
Environment plugins over the **same** engine.

## 3. Delivery: push floor + pull extension

Context reaches the model two ways. Neither substrate is "pure tool" or "pure file."

- **Push (pre-assembled base bundle)** — the quality floor: zero round-trips to
  answer. Always-needed, bounded, cheap: recent messages, current thread, memory
  *index/overview*, attachment *metadata*, the memory tree *outline*.
- **Pull (MCP tools / Resources)** — what push can't hold: out-of-window history,
  other channels, file *bodies* (object storage), large memory, leaf file content,
  and **all writes**.

Rule of thumb: **push the index, pull the leaves.** (This is why `read_file`
currently returns metadata with `content: null` — the body is a pull concern.)

### MCP primitives mapping

- **Reads → Resources** (URI-addressable), plus a tool version as fallback where
  the host can't let the model self-fetch resources:
  - `agentnexus://channel/{cid}/memory` → whole tree outline (also pushed)
  - `agentnexus://channel/{cid}/memory/{path}` → one file (ResourceTemplate)
  - `agentnexus://channel/{cid}/members`, `/history?page=N`, `/file/{id}`
- **Writes → Tools** (Grant-gated): `fs.write / edit / rm / mv` for class 2;
  `post_message`, `upload_file`, `invite_member` (domain actions) for class 1.
- **Conventions → Prompt** (MCP Prompts or direct system-prompt injection) —
  **not** a Resource (the model is not guaranteed to read resources) and **not** a
  memory file (the agent must not edit its own rules).

### Consistency risk to manage

Push assembly (Python `context_load`) and pull (Rust gateway `resource/*`) read the
**same** primitives through **two** implementations. Treat the gateway resources as
the single source of truth and have push take a snapshot from / share DTOs with the
same layer, or "what the bot was shown" and "what the tool fetches" will drift.

## 4. Lens rendering: v1 = declarative (A), upgrade path to code (B)

| | A. Declarative schema (v1) | B. Code-shipping plugin (future) |
|---|---|---|
| Form | `file → view-type + field mapping` (JSON) | plugin ships JS/React bundle |
| Render | built-in renderers (markdown/kanban/table/timeline) chosen by schema | plugin draws arbitrary UI |
| Expressiveness | bounded by the component library | arbitrary |
| Safety | no code execution, safe by construction | needs sandbox/CSP/version compat |
| Registration cost | submit a schema | build/distribute/load third-party code |

**Decision: v1 ships A.** Built-in view types for v1: `markdown / kanban / table /
timeline` (`form`, `tree` later). Structured views need structured files, so their
backing files are `md + frontmatter + convention blocks` or `.json/.yaml`.

**Constraint carried forward (the one cost we pay now for B):** design the
**Model↔View boundary** — the `file → view` contract and the binding manifest — to
look like a **future public plugin API**: public-facing, stable, minimal surface.
Binding is declared in the plugin **manifest** (path → view), not by parsing every
file header, so the frontend can build the page skeleton without reading content.

Why not B now: B means running untrusted third-party code, which forces a sandbox +
permission model, a **frozen** public plugin API, build/distribution/loading, and
review/trust — and freezing a public API while the core memory/Environment model is
still iterating would set the foundation in concrete before it cures. A is a subset
of B plus a safety moat, and building A validates the very API B will need.

**Safety valve before full B:** an intermediate `view: "custom-html"` (sandboxed,
declarative HTML/template, no JS) absorbs most "built-in components aren't enough"
needs without executing arbitrary code. Promote to B only when: built-in views are
repeatedly outgrown by genuinely custom interactions; real third parties (not just
us) want to publish; the core model has been stable for months; and we are ready to
invest in untrusted-code security.

## 5. Membership & Principal model (bot as first-class member)

Decided 2026-05-30. The system is already a **hybrid**: bots are first-class at the
*relation* layer but second-class at the *identity* layer. The schema shows this:

- **Relation/message layer — already polymorphic (bot is first-class):**
  `channel_memberships(member_id, member_type, role, ...)` and
  `messages(sender_id, sender_type, ...)`. Bots and users share one membership
  table, one message table, one role column. The gateway `check_bot_in_channel`
  reads this table with `member_type='bot'`. **This is the source of truth for
  "who is in a channel / who said what" — keep it.**
- **Identity layer — split (bot is second-class):** separate `users`
  (email/password/role/soft-delete) and `bot_accounts`
  (model/template/token/binding/`created_by`). Fields barely overlap.

So the real question is not "should a bot be a first-class member" (it already is at
the relation layer) but "should the identity split be healed." **Decision: do not
heal it; formalize the member abstraction above it instead.**

### The four decisions

1. **Do NOT merge `users` / `bot_accounts`.** The split is correct and reflects a
   real *responsibility* difference: a user logs in and is an accountable subject; a
   bot is owned/created by a user (`created_by`), authenticates by token, and is a
   tool. Merging would force half-NULL columns (classic polymorphic-merge
   anti-pattern), make constraints (unique email, token hash) ungainly, and — worst
   — blur who is accountable for a bot's actions (audit, quota, abuse).

2. **Relation layer is already first-class — keep it; fix the gaps above it.**
   - **Unified Principal resolution (auth exit):** whether a request arrives by user
     session or by bot token, resolve it to one `Principal{id, type, role}`.
     Everything downstream consumes Principal, not "is this a session or a token."
   - **Unified frontend Member component:** one component renders avatar/name/@ for
     any member; `type` only drives a small badge, not a separate render path.
   - **Collapse the fork points:** `messages.mention_bot_ids` vs `mention_user_ids`
     being two columns is identity-split leaking upward. Under a first-class model an
     @ is an @ of a *member*. Every such `if sender_type == "bot"` branch is the cost
     of "half first-class."
     - **Decided 2026-05-31: a `message_mentions` join table, not JSONB columns.**
       `message_mentions(msg_id, member_id, member_type)` — the same polymorphic
       `(member_id, member_type)` shape this schema already uses for
       `channel_memberships` and `messages.sender_*`. Rationale: (a) `@me`
       notifications become an indexed reverse lookup (`WHERE member_id = $me`),
       which a JSONB array can only do via GIN containment; (b) dispatch routing
       uses the parse result already in memory at write time, so the table adds no
       read on the hot path; (c) mentions are written once with the (immutable)
       message — N small INSERTs inside the message transaction. Both legacy JSONB
       columns (`mention_bot_ids` / `mention_user_ids`) are dropped (greenfield, no
       migration). See [DECENTRALIZED_MESH §2](./DECENTRALIZED_MESH.md) for how
       dispatch consumes it.

3. **Formal Principal abstraction layer — gated on "will there be a third member
   type?"** This is the one strategic call.
   - Only ever user + bot → relation-polymorphism + dual identity tables already
     suffice; just finish the upper-layer consistency (#2). Don't touch table
     structure.
   - A third type coming (external webhook, remote MCP agent, org/team-as-member,
     federated identity) → every `if sender_type == "bot"` is future debt; invest in
     a real Principal abstraction (one interface, pluggable identity backends) so
     "add a member type" becomes "implement an interface," not "edit branches
     everywhere".
   - **Direction taken:** because the Environment-plugin track likely introduces
     scenario-defined actor types, do the **lightweight version**: define a
     `Principal{id, type, role}` interface and unified resolution **now**, but do
     **not** pre-create tables for types that don't exist yet.

4. **Cycle detection + responsibility pass-through must enter the model WITH
   first-class membership, not be patched on later.** A bot is unique among members:
   it is *both* a member *and* a tool driven by another member.
   - **Cycles/recursion:** bot A @ bot B @ bot A. Already hit in practice
     (`tests/test_bot_at_bot_recursion.py`). First-class membership makes such
     interactions more natural and more frequent — cycle/loop detection must be part
     of the model, not a later fix.
   - **Responsibility pass-through:** a bot's message looks like an independent
     member's, but audit must always pierce through to `created_by` / the driving
     principal. **The frontend may present a bot as a first-class member; the audit
     layer must never let it be truly independent.**

## 6. One-line summary

**Session is the immutable past, Memory is the mutable present, the Environment
template is the setting authored before the past began.** The template pours the
other two at birth and then退场; the session only appends; memory is the writable
distillate of the session plus the writable legacy of the template. All boundaries
are one-directional, and the three converge into each turn's bot context via
*push the index, pull the leaves*.
