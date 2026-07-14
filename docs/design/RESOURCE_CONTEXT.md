# Resource context — attachable Cheers resources as agent context

> Status: 📝 **Design accepted, not yet implemented** (2026-07)
> Roadmap: multi-agent collaboration track. Supersedes the narrower
> "handoff protocol" idea (bot@bot handoff becomes one *producer* here).

## The one-sentence pitch

Any participant — a **human** in the composer or a **bot** handing off a subtask
— can attach **Cheers's own resources** (a plan, a board, a file, a message or
thread, a run of decisions) as structured context to an agent invocation. It is
the Cheers-native equivalent of Cursor's `@file` or a browser agent picking up
the page — except the pickable things are **collaboration resources**, which only
a platform that *owns* them can offer. Bridges can't: they have no resource layer.

## Why one primitive, not two features

"Bot-to-bot handoff" and "human attaches context" are the same act — *select
Cheers resources, deliver them as context to an agent*. Two axes describe every
case: **who** produces the context (human / bot) and **how** it's picked
(manual / automatic). Build the shared foundation once; every cell is a thin
shell on top.

|              | **Manual pick** (explicit selection) | **Automatic pick** (system infers) |
|--------------|--------------------------------------|------------------------------------|
| **Human**    | composer "add context" picker → plan / board / file / message / thread | *suggested context*: the reply target, a named file, the channel's active plan — surfaced as one-click chips |
| **Bot**      | a bot explicitly requests a resource (already possible via the resource protocol) | **handoff**: on dispatch the gateway auto-assembles the initiator's plan + touched files + recent decisions |

The interactive human picker (manual) and the bot handoff (auto) are the two v1
producers; the other two cells are natural follow-ons on the same foundation.

## Two pick modes

The pick *mode* is orthogonal to producer and worth designing explicitly, because
it sets one hard rule.

### Manual pick — explicit, committed

The participant selects resources deliberately (a human clicks them in the
composer; a bot names them). Selection = intent; the refs go on the message as-is.

### Automatic pick — inferred, suggested

The system proposes relevant resources from context signals:

- **Human, suggested:** the message replies to something (→ attach that
  message/thread), names a file (→ attach `board.json`), or lands in a channel
  with an active plan (→ offer the plan). Like an editor auto-including the open
  file — but the human sees the chips and can drop any before sending.
- **Bot, handoff:** deterministic assembly from the initiator's turn state
  (plan + files touched + resolved decisions). No human is in the loop, so it
  can't "suggest" — it assembles, and the result is **rendered visibly** (a
  handoff card) and **audited**, so it's never silent.

### The hard rule: auto-pick is never silent

Automatically-picked context is **always visible and removable** before it acts
(human: chips you can delete pre-send; bot: a handoff card + an audit row). We
never smuggle context an agent then acts on without it being inspectable — same
honesty/governance spine as dispatch's audit and Fleet's consumer-scoped reads.
The only thing auto-pick removes is *friction*, never *visibility*.

## The foundation (build once)

### 1. The context bundle

An ordered list of **resource references**, each resolvable through the resource
protocol Cheers already speaks (`server/src/resource/mod.rs`). A ref is a
`(verb, params)` pair plus a human label and an optional inline preview:

```jsonc
"context_bundle": {
  "origin": "human" | "handoff",
  "from":   { "type": "user"|"bot", "id": "…", "trigger_msg_id": "…"? },
  "items": [
    { "verb": "channel.plan.read",  "params": {"channel_id":"…","session_id":"…"},
      "label": "Plan — 3/7 done", "preview": { /* small snapshot */ } },
    { "verb": "channel.files.read", "params": {"file_id":"…"},
      "label": "board.json",       "preview": null /* pull on demand */ },
    { "verb": "channel.messages.by-seq", "params": {"channel_id":"…","seq":42},
      "label": "decision: use RS256", "preview": {"text":"…"} },
    { "verb": "channel.activity.read", "params": {"channel_id":"…","since":"…"},
      "label": "recent decisions",  "preview": [ /* few rows */ ] }
  ]
}
```

Every `verb` above already exists in the resource registry
(`channel.plan.read`, `channel.files.read`, `channel.messages.by-seq`,
`channel.activity.read`, `channel.context`, `channel.sessions.read`, …). The
bundle is *just references to them* — no new read logic.

**Reference-first, preview-as-hint.** Big resources ship as a ref + a small
preview; the agent pulls full content **on demand** via the same verb. This
keeps the task frame small (the ACP frame has a ~16 MiB ceiling) and means the
context can be richer than what fits inline.

### 2. Delivery

- **Persisted** on the message: a new `context_bundle` JSONB column on `messages`
  (or a side table `message_context` keyed by msg_id). Survives history reload;
  renders as context chips.
- **Threaded into the task frame**: a new `context_bundle` field on the bridge
  `Task` frame (`cheers_bridge_protocol`), alongside `trigger_message` /
  `attachments` / `pinned` (`dispatcher.rs::build_task_frame`). The connector
  hands it to the agent as structured context.

### 3. Resolution & governance (the important part)

The receiving agent resolves each ref **as itself** — a `Principal::bot(B)` —
through the existing resource dispatch. So:

- **The consumer's permissions govern the pull**, not the producer's. Bot B can
  only read a referenced resource if B is authorized for it
  (channel membership + `PLATFORM_RESOURCE_PERMISSION` for restricted ops). A
  ref B may not read simply denies on pull — the bundle can *point at* more than
  B may see without leaking it.
- This is the same governance spine as Fleet and dispatch: resources flow, but
  every read passes the matrix. A human picking up a restricted file for a bot
  that lacks access doesn't smuggle it in — B still gets denied.

Previews are the one exception (they inline a snapshot the producer could see).
v1 rule: **previews are only generated for refs the *producer* may read**, and
kept small; anything sensitive rides as a bare ref (no preview) so only an
authorized consumer pull reveals it.

## Producer A — human, manual pick

The pickable resources are **exactly what the Viewboard and Workbench already
show** — a human attaches the same things they're looking at. Categories map to
resource verbs:

- **Plan** (Viewboard) → `channel.plan.read`
- **Recent decisions / Activity** (Viewboard) → `channel.activity.read`
- **Sessions / Cost / Audit** (Viewboard) → `channel.sessions.read` / `channel.usage.read` / approval audit
- **File / board** (Workbench) → `channel.files*` (board.json, any workbench/channel file)
- **Message / thread** → `channel.messages.by-seq` (pick a message; a thread = its range)

**Two entry points** (both feed the same context bundle):

1. **Composer "add context"** — an `@`-style picker (mirrors the mention popup)
   to browse and attach resources before sending.
2. **In-panel "attach"** — a "pick up → send to agent" affordance *inside* the
   Viewboard tabs and Workbench files. This is the pageagent/Cursor pattern:
   attach *what you're viewing* without leaving it. Often the more natural entry
   ("I'm looking at the plan — attach it").

Selected items become context chips on the composer; on send they persist to the
message and thread into any triggered bot's task frame. Rendered as a chips row
under the message ("📎 Plan · board.json · decision #42").

## Producer B — bot, automatic pick (handoff)

On a bot@bot dispatch that passes the [dispatch gate](BOT_DISPATCH.md), the
gateway auto-assembles a bundle for the target from the initiator's turn, reusing
the readers:

- `summary`: the initiator's reply text (the natural handoff message — already in
  `trigger_message`).
- **Plan**: `channel.plan.read` for the initiator's session.
- **Files touched**: refs to files the initiator wrote this turn (from its
  `tool_call` traces / `workspace_signal` paths).
- **Recent decisions**: `channel.activity.read` since the turn started
  (resolved approvals + notable tool calls — real events, not LLM self-report).

This is what turns "B sees only chat history and guesses" into "B receives the
shared working state." Pure open-questions the agent alone knows are a later
agent-emitted enhancement; the resource bundle already removes most of the guess.

## Producer C — human, automatic pick (suggested context)

A later follow-on on the same foundation: as a human composes an `@bot` message,
the composer *suggests* context chips from signals it already has — the reply
target, a filename in the text, the channel's active plan — each a one-click add
(and, per the hard rule, visible + droppable, never auto-committed). Lowers the
friction of manual pick without changing the delivery/resolution path.

## Phasing

| Phase | Scope | Verifiable outcome |
|---|---|---|
| **F0 — foundation** | bundle schema; `context_bundle` on message (persist) + on the Task frame; agent resolves refs via existing verbs; consumer-governed reads | a hand-crafted bundle on a message reaches a bot's task frame; bot pulls a ref it may read, is denied one it may not |
| **F1 — human, manual pick** | composer "add context" picker for plan/file/message/activity; context chips on messages | a human attaches a plan + a file to an `@bot` message; the bot receives and reads them |
| **F2 — bot, automatic pick (handoff)** | gateway auto-assembles the bundle on bot@bot dispatch (reuses F0) | A hands to B; B's task frame carries A's plan + touched files + recent decisions; a handoff card renders |
| **F3 — human, automatic pick (suggested)** | composer suggests chips from reply target / filenames / active plan | typing `@bot fix the board` offers a one-click `board.json` chip |

Recommended order: **F0 → F1 → F2 → F3**. F1 first among producers — visible,
demo-able, legible as "Cheers's `@context` for collaboration resources"; F2
reuses the foundation with no UI; F3 layers suggestion onto F1's picker.

## Out of scope (for now)

- Agent-emitted "open questions" (a structured block the initiator writes) — a
  later F3 enhancement composing with this bundle.
- Subsuming today's file attachments into the bundle — they coexist in v1; a file
  is just one resource kind, so a later unification is natural but not required.
- Cross-channel / cross-workspace refs — v1 is channel-scoped (matches how the
  resource verbs are scoped and authorized today).

## Relationship to the existing workbench "pin"

Cheers already has a **pin** (`PinToggle` in the workbench file tree →
`.workbench.json` `pinned[]` → `dispatcher::load_pinned_context`): a file whose
full content is inlined into the `pinned` slot of **every** task frame in the
channel — "the semantic layer, a controlled push, not auto-memory."

They do **not** conflict — different scope, different delivery slot — and pin in
fact *validates* this direction (same "controlled push" philosophy). Context
bundle is the **per-message, multi-kind, ref-based generalization** of what pin
does at channel scope:

| | **Pin** (exists) | **Context bundle** (new) |
|---|---|---|
| Scope | channel-standing, always on | one message / one invocation |
| Applies to | every bot, every request | one `@bot` message / one handoff |
| Content | one file's full text, inlined | refs (plan/file/msg/activity) + pull, consumer-governed |
| Slot | `pinned: Vec<String>` | `context_bundle` (new) |

Three rules keep them clean (not a v1 merge):

1. **No name collision.** The picker is "add context" (this message), never
   "pin" (always). Pinned files show in the picker as *already pinned — in every
   prompt*, so a user doesn't redundantly attach them.
2. **No double delivery.** A file that is both pinned and attached would reach the
   agent twice (inlined in `pinned` + via the bundle). The human picker disables
   already-pinned files; the F2 handoff auto-assembler **excludes pinned paths**.
3. **Future unification, not now.** Pin is conceptually a *channel-scoped standing
   bundle (files only, inlined)*. It could later be reframed as a standing
   `context_bundle` at channel scope to share one delivery path — a refactor,
   explicitly out of v1. v1 keeps the two slots and de-dups.

## Resolved decisions (2026-07)

1. **Storage** → a `context_bundle` **JSONB column on `messages`** (not a side
   table). Simplest, one migration, read/write with the message row; revisit only
   if bundles grow large or need per-item query.
2. **Restricted-resource previews** → **no preview, bare ref only.** A ref the
   producer could see but the consumer may not carries no inline snapshot; only an
   authorized consumer *pull* reveals content. Nothing sensitive rides in the
   frame. (Non-restricted refs may carry a small preview.)
3. **F1 resource kinds** → **plan + file/board + message/thread** (the minimum
   useful set). `activity` and `session` follow (activity is anyway the workhorse
   of the F2 handoff auto-bundle).
