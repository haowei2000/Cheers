# Canvas

> Status: **partly implemented** — 2026-08-31. Steps 1, 3, 4 and 6 of the migration
> order have landed: structured edits reach the client, the document format and its
> layout exist, and `builtin:canvas` renders and edits one. Steps 2, 5, 7 and 8 have not.
> Argues that a canvas is a *file rendered by a lens*,
> and that this one decision satisfies all four goals below without a new security
> boundary, a new write path, or a new navigation concept. Related:
> [PANEL_MODEL.md](PANEL_MODEL.md) (the `{source, view}` vocabulary a canvas node reuses),
> [PLUGIN_SYSTEM.md](PLUGIN_SYSTEM.md) (the authority boundary that rules out a code-authored
> canvas), [WORKBENCH.md](WORKBENCH.md) (the shared window layout this is *not*),
> [WORKBENCH_WRITEBACK.md](WORKBENCH_WRITEBACK.md) (the structured-edit path it must use).

## The goals

1. **Bidirectional editing** — the same canvas is editable by direct manipulation *and*
   by editing its text.
2. **Human and agent editable** — a bot arranges the board; a person reads and corrects it.
3. **Multiple canvases** — a channel has several, and you switch between them.
4. **Round-trippable addressing** — you can point at one thing on the canvas from either
   view, and a URI resolves back into either view.

## The claim

**A canvas is a channel file rendered by a `builtin:canvas` lens.**

Every goal follows from that sentence, because each one already has machinery attached to
"a file in the channel workspace":

| Goal | What serves it | New work |
|---|---|---|
| 1. Bidirectional editing | [`FilePanel`](../../frontend/src/features/chat/workbench/panels/FilePanel.tsx:135) already runs `mode: "auto" \| "preview" \| "raw"` over one file: a lens on one side, CodeMirror on the other, one `if_version` lock, one comment-preserving write-back | the lens |
| 2. Human and agent editable | An ordinary channel file under the `fs.*` verbs, authorized by channel-role. A bot could always write it | **none** |
| 3. Multiple canvases | Several files. Switching is the file tree | a nicer picker |
| 4. Round-trippable addressing | `cheers:` locators, `sourcePathLineRange`, granular context picking — see [Addressing](#addressing) | one inverse function |

The alternative — a canvas as a bespoke subsystem with its own store, its own persistence
and its own navigation — buys nothing that this does not, and costs a second answer to
every question the Workbench has already answered once.

## A canvas is not the lane layout

These are different objects and merging them is a mistake in both directions.

| | `layout` (shipped) | Canvas (this doc) |
|---|---|---|
| What it is | **My** arrangement of the channel's instrument windows | A document the channel **authors together** |
| Lives in | the `layout` key of `.workbench.json` | `canvases/<name>.canvas.yaml` |
| Coordinates | fractions of the lane — it must fit a fixed viewport | absolute units; pan/zoom is per-viewer and never stored |
| A drag means | a device-local override; it does **not** write the shared value | an edit to the shared document; it **does** write |
| How many | one per channel | as many as you like — goal 3 |

The "a drag never writes shared" rule in
[`sharedLayout.ts`](../../frontend/src/features/chat/workbench/sharedLayout.ts) exists
because window placement is a *viewer preference*. Moving a node on a canvas is *editing
content*. Applying either rule to the other object produces a bad product: a canvas whose
edits nobody else sees, or a lane that yanks a panel out from under its reader.

## The document

The node/edge model is [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) — the format
Obsidian opened up — with four deliberate divergences. Two of its decisions are worth
copying outright: an **edge binds to a node id plus a side** (`top`/`right`/`bottom`/`left`)
rather than to points, so moving a node can never strand a connector; and **colors are
opaque preset slots** whose values the application defines, which maps straight onto the
design system's semantic tokens.

```yaml
# The channel's architecture canvas. Nodes reference workspace files; edges bind to node
# ids, so moving a node never breaks a connector.
canvas: 1
layout: dag                # auto-layout strategy: dag | grid | free
nodes:
  - id: plan
    source: { kind: fs, path: dev/plan.yaml }
    view: builtin:kanban   # the SAME {source, view} a scene item and a lane panel use
  - id: note
    text: "Blocked until #631 lands"
  - id: pinned
    source: { kind: fs, path: dev/issues.yaml }
    view: builtin:table
    rect: { x: 520, y: 0, w: 300, h: 200 }   # pinned: overrides auto-layout
edges:
  - { id: e1, from: { node: plan, side: right }, to: { node: note, side: left }, label: blocks }
```

### Where it diverges from JSON Canvas, and why

| JSON Canvas | Here | Why |
|---|---|---|
| Absolute pixels, always | **Auto-layout by default; `rect` is a pin** | Nobody hand-writes `x: 480`, and an agent *cannot* — it can reliably say "these three files, these two dependencies" and not "x=480, y=320". Coordinates as the required unit would defeat goal 2 and bury goal 1's text view in noise. Dragging a node is what pins it. |
| Array order is the z-index | **Explicit `z`** | Raising a window would otherwise rewrite the whole array — an enormous diff, and unmergeable per-node. Obsidian is single-user and local-first; this file has concurrent writers. |
| Group membership implied by geometry | **Explicit parent, if groups arrive** | Geometric containment is ambiguous under overlap and worse under concurrent edits. |
| No version field | **`canvas: 1`** | A format with several implementations needs one. |
| JSON | **YAML** | Comments. See below. |

The YAML choice only earns its keep *because* of auto-layout. A file full of machine-written
coordinates has nothing worth commenting; a file of nodes and relationships does, and
comments are how a human and an agent explain themselves to each other
([WORKBENCH_WRITEBACK.md](WORKBENCH_WRITEBACK.md)).

### A node is a panel with a position

`{source, view, config}` is the vocabulary unified in `refactor(workbench): a scene item is
a panel`. A canvas node is its third user, after scene items and lane panels. Adding a
fourth spelling here would undo that refactor within a release of landing it.

## The edit path

**Canvas edits must go through `fs.patch`, not `fs.write`.**

[`fs.patch`](../../server/src/resource/fs.rs:626) already exists on the gateway: `set` /
`insert` / `move` / `remove` ops over a path array (`["nodes", 3, "rect", "x"]`), 1–100 per
call, applied atomically under `SELECT … FOR UPDATE`, preserving YAML formatting. The web
client had never used it: it wrapped four of the gateway's eight file verbs, so `fs.patch`,
`fs.edit`, `fs.append` and `fs.mv` were reachable by agents and by nothing the UI did.
[`fsClient.patch`](../../frontend/src/features/chat/workbench/fsClient.ts) and
[`useFile.applyOps`](../../frontend/src/features/chat/workbench/jsonFile.ts) close that for
`patch`; the other three are still unwrapped.

The difference decides goal 2:

| | `fs.write` (today) | `fs.patch` |
|---|---|---|
| Conflict window | from when you opened the file | from read to write |
| After a conflict | your edits are unrecoverable — you hold a stale whole document | **the ops replay**: "set node-3.rect.x to 420" is still true against the new version |
| Agent edits another node meanwhile | always conflicts | does not conflict |

Both take `if_version`, so neither is conflict-*free*. What changes is that an op is
replayable and a document is not.

This needed two additions to the lens contract in
[`lens/registry.ts`](../../frontend/src/features/chat/workbench/lens/registry.ts):

```ts
interface LensProps {
  onChange: (next: unknown) => void;        // whole document — unchanged
  onOps?: (ops: PatchOp[]) => void;         // structured edits
}

interface Lens {
  savesItself?: boolean;                    // writes as it goes; the host offers no Save
}
```

`savesItself` is not cosmetic. A lens that writes through `onOps` has no unsaved buffer,
and a Save button over one would perform exactly the whole-document write the ops path
exists to avoid. It is distinct from `viewOnly`, which claims the lens never edits at all.

`table` and `kanban` benefit immediately: editing one cell stops rewriting the file.

## Addressing

Goal 4 is what makes the two views *one document* rather than two editors that share a
file. Most of it is built. The round trip:

```
lens element ──sourcePath──▶ YAML node ──range──▶ lines ──▶ cheers: URI
     ▲                                                          │
     └────── focusPath ◀── sourcePathAtLine ◀── lines ◀─────────┘
                                 ▲ missing
```

Already present:

| Direction | Machinery |
|---|---|
| Interactive pick → lines | `requestContextPick(e, {sourcePath})` → [`sourcePathLineRange`](../../frontend/src/features/chat/workbench/contextSource.ts) walks the YAML AST for `node.range` |
| Exact anchor → lines | `uniqueSourceTextRange`, which **fails closed** on an ambiguous anchor rather than guessing |
| **Code pick** → lines | `selectionLineRange`, used by `FilePanel`'s raw mode |
| Lines → URI | `rangedFileContextItem` → `contextItemLocator` → `cheers:desk/<path>#L5-L9` |
| URI → code view | `CodeEditor`'s `scrollToLine` |

[`locator.ts`](../../frontend/src/features/chat/locator.ts) describes itself as the
"AI-writable serialization" of resource addressing, so this path was always meant for agents.

### The four gaps

1. **The Workbench deep-link drops the line.**
   [`ChannelView.tsx:885`](../../frontend/src/features/chat/ChannelView.tsx:885) is
   `setWbTarget(loc.path)` — `loc.line` is parsed and thrown away. Remote workspace passes
   `scrollToLine`; the Workbench does not. Small.

2. **There is no inverse of `sourcePathLineRange`.** This is the keystone:

   ```ts
   /** Line → data path: the innermost YAML node whose range contains that offset. */
   export function sourcePathAtLine(content: string, line: number): (string | number)[] | null
   ```

   Same library, same AST, walked the other way. Without it, `#L12` can never become
   "the first card in the second column".

3. **A lens cannot be told what to focus.** `LensProps` needs
   `focusPath?: ReadonlyArray<string | number>` so it can scroll to and highlight the
   addressed element.

4. **Line anchors are too brittle for a machine-written document.** An agent reorders the
   nodes and every `#L12` in the channel's history points somewhere else. A canvas node
   has a **stable id**, unlike a table row, so it deserves a stable anchor:

   ```
   cheers:desk/canvases/arch.canvas.yaml#L12-L18   line anchor  (universal, exists)
   cheers:desk/canvases/arch.canvas.yaml#^plan     id anchor    (stable, new)
   ```

   `#^<id>` follows Obsidian's block-reference convention and cannot be confused with
   `#L12`. Only formats that declare ids resolve it.

Gaps 2 and 3 pay off before any canvas exists — they make every lens addressable.

## Agent-generated views

A declarative canvas can only look like the lens vocabulary allows — five lenses today.
The wanted effect is an agent producing a node that looks like *anything*: a styled report,
a diagram, an illustrated summary. That is reachable now, because the constraint was never
"no agent-authored rendering" but "nothing agent-authored evaluated with ambient authority",
and [`SandboxRenderer`](../../frontend/src/features/chat/workbench/sandbox/SandboxRenderer.tsx:379)
already removes that authority:

- `<iframe sandbox="allow-scripts" srcDoc=…>` with **no `allow-same-origin`** — an opaque
  origin. No session cookie, no app `localStorage`, no reach into the parent DOM.
- A CSP of `default-src 'none'` with nonce-gated script and style, and without the
  `network` permission also `connect-src 'none'`, `img-src data: blob:`, `frame-src 'none'`,
  `form-action 'none'`, `base-uri 'none'`, `navigate-to 'none'`.

So an agent-authored view is delivered as an ordinary workspace file and rendered there.
Two tiers, because they carry very different residual risk:

| | Tier 0 — presentational | Tier 1 — interactive |
|---|---|---|
| Node | `view: html`, content a workspace file | `view: html`, plus script |
| iframe | `sandbox=""` — **scripts disabled entirely** | `sandbox="allow-scripts"`, no permissions |
| Agent can produce | HTML, CSS, inline SVG | the above plus behaviour |
| Residual risk | misleading pixels — the same risk any message body already carries | plus CPU exhaustion, fingerprinting, and reliance on the browser's sandbox |
| Consent | none needed: it cannot execute | the existing code-consent surface |
| Platforms | **all** | **desktop first** |

Tier 0 is a one-attribute change to an existing component and is likely most of what
"arbitrary styling" means. It is inert by construction, so it needs no consent and no
platform restriction.

Tier 1 is where **desktop-first** belongs — but for an honest reason, not the obvious one.
The sandbox is a browser iframe and behaves identically everywhere; the macOS-only rule in
[PLUGIN_SYSTEM.md](PLUGIN_SYSTEM.md) is about *package distribution and authorship*
("sha256 proves transport integrity, not authorship"), which is a different question from
a channel file whose author is an identified member or bot, written under channel-role and
recorded in the operation log. Desktop-first is therefore a *rollout* choice — smallest
blast radius, and where renderer code already runs — not a claim that the web client is
unsafe. Revisit it once Tier 1 has real use.

Two properties worth noticing, because they are why this fits rather than fights the design:

- **The document stays declarative.** An `html` node is `{id, view: html, source: {kind: fs,
  path: …}}` — still addressable by `#^id`, still diffable, still something an agent writes
  as structure.
- **"Code editing" becomes literal.** The raw view of an `html` node's file *is* its source.
  Goal 1 is satisfied more directly here than anywhere else in the design.

What must not follow from this: an `html` view is a **leaf**. It renders; it does not gain
host RPC, it does not get `channel.resources`, and it is never the canvas document itself.
The moment a generated view can write the canvas that positions it, the data/code line has
moved.

## How desktop and web diverge

The split already exists and is worth stating precisely, because "advanced features on
desktop, a safe fallback on the web" is only sound for one of the two kinds of check.

**A client-side check is a real boundary when the client is what it protects.** "Should
*this* client execute *this* code?" is answered correctly by the client refusing: an
attacker who could forge `window.isTauri` would already need script execution in the app's
origin, which is the thing they were trying to obtain. "May this user perform this
privileged operation?" is the other kind, and there [`isTauri()`](../../frontend/src/lib/serverConfig.ts:14)
is worth nothing — which is why the gateway holds its own half with `allow_code = false`
at every install path.

Today: **one bundle, runtime detection, a single refusal point.**
[`WorkbenchDrawer`](../../frontend/src/features/chat/workbench/WorkbenchDrawer.tsx:378)
passes `isTauri() ? "temporary" : "global"` and
[`package.ts`](../../frontend/src/features/chat/workbench/extensions/package.ts:496) refuses
code at global scope. Tauri plugin modules are dynamically imported and genuinely absent
from the web bundle; `SandboxRenderer` is present but unreachable.

Splitting further has three levels, and the middle one is the buy:

| | Buys | Costs |
|---|---|---|
| **A. Today** — one bundle, runtime check | simple, no drift | a future guard omitted anywhere fails silently |
| **B. One chokepoint plus a CI check** | omitting a guard **fails the build** | one check script, in the style of `check-design-system.mjs` |
| **C. Two builds** — `__DESKTOP__` define, tree-shaken | the web bundle physically lacks the sandbox | two CI lanes, two artifacts, a doubled test matrix, and contract tests that must know which build they are testing |

**Prefer B.** C's extra protection only applies *after* an XSS, and an attacker who has the
app's origin gains nothing by reaching a zero-permission opaque-origin iframe — that is a
downgrade, not an escalation. The regression risk B removes is the real one.

### What the web falls back to

The rule: **a fallback is a real view, not an error.** Renderer selection already works this
way — a failed or missing renderer drops out of the candidate list so the host picks the
next built-in match, or inert Raw ([WORKBENCH.md](WORKBENCH.md)).

| Capability | Desktop | Web | What the web shows |
|---|---|---|---|
| `view: html` Tier 0 | yes | yes | the same thing; it is inert everywhere |
| `view: html` Tier 1 | yes | no | **the same file rendered as Tier 0** — drop `allow-scripts`, keep the markup |
| `view: self:<renderer>` | yes | no | best built-in match, else Raw (already the behaviour) |
| Personal extension install | yes | no | refused at global scope (already) |
| `network: unrestricted` | yes | no | — |

Tier 1 degrading to Tier 0 is the reason to define them over the same artifact: one file,
one attribute apart, no second copy of the content to keep in sync.

### The tax

Capability divergence compounds into support cost, and for a canvas it is sharper than
usual: **a canvas containing desktop-only nodes stops being a portable document**, and half
a channel sees something different from the other half. The mitigation is the same
invariant as everywhere else in this design — because the *document* stays declarative, a
degraded node still says what it is and still resolves by `#^id`, rather than rendering as
an empty box.

## Boundaries that must not move

**1. The document is data; only a node's *view* may be markup or code, and only in the
sandbox.** The tempting version of "maximum flexibility" is a canvas authored in TSX, the
way a local editor previews a component. That specific shape does not transfer, and the
reason is the threat model rather than the technology:

| | A local editor | The Cheers client |
|---|---|---|
| Whose code | yours, or code you reviewed | **anyone with channel write access, including bots** |
| Runs where | your machine | every viewer's client |
| Ambient authority | your machine is already yours | **that viewer's session token and DOM** |

What is foreclosed is precisely the third row: an agent-authored module evaluated *in the
app's own origin*. It is not the same as an agent producing visual output — see
[Agent-generated views](#agent-generated-views), which reaches the same goal through the
existing sandbox and keeps the document declarative, addressable and diffable.

The line to hold: **the canvas document is always data.** Goals 2 and 4 both depend on it —
an agent must be able to write the structure, and a URI must be able to address a node. A
node's *content* may be arbitrary; the graph that positions and names it may not.

**2. A canvas is not the lane layout.** See above. In particular, do not give canvas nodes
a local override: that rule is what makes window placement personal, and applying it here
would mean nobody sees anybody else's edits.

**3. `viewOnly` remains a property of the source, not the view** — guardrail 3 of
[PANEL_MODEL.md](PANEL_MODEL.md). A node whose source is a resource projection carries no
version to write back against, and must not grow a Save because it happens to sit on an
editable canvas.

**4. No live multiplayer.** Editing follows the same "edit locally, then Save" discipline
as every other lens. A CRDT (Yjs, Automerge) would make simultaneous editing work and is a
different project; `fs.patch` shrinks the conflict window enough that it is not needed to
ship. Do not smuggle one in as an implementation detail.

## What is actually new

| Work | Size | Notes |
|---|---|---|
| `builtin:canvas` lens | **large** | Node rendering, drag, connect, marquee, pan/zoom. `CodemapLens` ([builtins.tsx:730](../../frontend/src/features/chat/workbench/lens/builtins.tsx:730)) already implements pan/zoom with a movement-threshold guard; copy it |
| `onOps` + `fsClient.patch` | small | Independently useful to `table`/`kanban` |
| `sourcePathAtLine` + `focusPath` + line-carrying deep link | small | Independently useful to every lens |
| Auto-layout engine (`dag`, `grid`) | medium | Pure function, testable, touches no boundary |
| Undo stack | medium | Nearly free once edits are ops: push the inverse |
| Recursive node rendering | **risky** | See open questions |
| Canvas creation / switching | small | The file tree already does most of it |
| `view: html` Tier 0 (no script) | **small** | One iframe attribute plus a node type; `SandboxRenderer` already builds the document and the CSP |
| `view: html` Tier 1 (script) | medium | Reuses the sandbox; the new part is a consent surface for a channel artifact rather than a package |
| Desktop-only chokepoint + CI check | small | Level B under [How desktop and web diverge](#how-desktop-and-web-diverge) |

## Migration order

Risk-ascending, and the addressing work comes early because it pays off without a canvas.

1. ~~**`onOps` + `fsClient.patch`.**~~ **Done.** `patchOps.ts` mirrors the gateway's
   `apply_value_op`; `useFile.applyOps` replays its ops after a conflict rather than
   discarding a stale document.
2. **`sourcePathAtLine`, `focusPath`, and carry `#L<n>` into the Workbench.** Gaps 1–3.
   Every existing lens becomes addressable. **Not started** — and still the step with the
   widest payoff outside the canvas.
3. ~~**Fix the canvas format.**~~ **Done**, in `canvas/document.ts`. One addition this
   document did not anticipate: a parsed node carries `at`, its index in the RAW array,
   because dropping a malformed node makes the parsed position and the file position
   diverge and every patch op addresses the file. `#^id` anchors are still unbuilt (they
   belong with step 2).
4. ~~**A `builtin:canvas` lens with auto-layout.**~~ **Done**, and not read-only — see 6.
5. **`view: html` Tier 0.** Inert, all platforms, no consent. **Not started.** Research
   into how Cursor and Codex ship a "canvas" put this in perspective: both are
   generate-then-reprompt documents, so this step is where we match them rather than
   where we differ.
6. ~~**Interactive editing** — drag (which writes a `rect` pin), connect, undo.~~ **Done**,
   folded into step 4 because the pointer arbitration is structural to the component
   rather than a layer on top of it. This is the differentiator: nothing else lets you
   drag a document an agent is also writing.
7. **`source` nodes (recursive rendering).** Last, for the reasons below. **Not started** —
   a source node currently renders as a card naming what it points at.
8. **`view: html` Tier 1**, desktop first, once there is a reason to want behaviour rather
   than only appearance. **Not started.**

Two properties the implementation had to discover, both invisible to every static gate
and both caught by driving the thing in a browser. Laying out only the *unpinned* nodes
renumbers the sequence on each pin, so dragging one node moved three others; every node
now holds a slot and a pin overrides only its own. And `setPointerCapture` retargets
subsequent pointer events to the capturing element, so a drop's `event.target` is always
the viewport — connections hit-test with `elementFromPoint` instead.

## Open questions

- **Pointer arbitration for recursive nodes.** An editable table, inside a draggable node,
  inside a pannable canvas: which one owns a pointer-down? `CodemapLens`'s
  movement-threshold guard solves one layer of this; three layers is the unsolved part and
  the reason step 6 is last.
- **Does a canvas node need its own lens config?** `config` is per-node in the sketch
  above, but a table's column set is arguably a property of the *file*, not of one canvas
  that happens to show it. Two canvases showing the same file would then disagree.
- **Is `rect` enough of a pin?** Pinning position and size may not be the only thing a
  person wants to freeze against auto-layout — order and grouping are candidates too.
- **What consent does a Tier 1 artifact need?** Today's gate is per package install, which
  does not fit a file that arrives in a channel. Per-author, per-channel, and
  per-artifact-hash are all plausible and none is obviously right.
- **Should a canvas declare that it needs desktop?** A document whose nodes all degrade
  gracefully is portable; one built around Tier 1 is not. A per-canvas hint would let the
  web client say "this was authored for desktop" instead of silently showing less.
- **Does Tier 0 need a size or complexity cap?** Inert markup cannot execute, but it can
  still be enormous, and an agent producing a 4 MB node degrades the canvas for everyone.
- **How does an agent address a node it is about to create?** Ids are stable once written,
  but a bot composing a canvas in one `fs.patch` has to mint them itself. A collision rule
  (or a server-side mint) is undecided.

## Related

- [Panel model](PANEL_MODEL.md) — the `{source, view}` vocabulary and the source/view guardrails
- [Plugin system](PLUGIN_SYSTEM.md) — the three execution sites, and why the document is data
- [Workbench extensions](WORKBENCH.md) — the package contract and the shared window layout
- [Workbench write-back](WORKBENCH_WRITEBACK.md) — why the gateway owns structured edits
- [Workbench lens spec](WORKBENCH_LENS_SPEC.md) — the built-in view vocabulary
- [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) — the format this borrows its node/edge model from
