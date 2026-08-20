# Panel model

> Status: 📝 **Proposal (draft)** — 2026-08-20. Not implemented, not decided. Argues that
> Workbench, ViewBoard, and Remote workspace are one concept differing only in data
> source, and that collapsing them is the precondition for making any of them
> plugin-able. Related: [PLUGIN_SYSTEM.md](PLUGIN_SYSTEM.md) (the authority boundary this
> must not move), [WORKBENCH.md](WORKBENCH.md) (the package contract it extends),
> [CLIENT_NAV_IA.md](CLIENT_NAV_IA.md) (why the mobile clients follow).

## The claim

The channel's right-hand lane hosts four surfaces — Channel files, Remote workspace,
ViewBoard, Workbench — built as four subsystems. They are not four kinds of thing. They
are one kind of thing, a **Panel**, over four **Sources**.

```
Panel = Source × View × Scope
```

The distinction the current code draws is real but it is a distinction between *sources*,
not between *surfaces*. Drawing it at the surface layer cost three contribution
registries, two panel hosts, two mobile equivalents, and one feature implemented three
times. Redrawing it at the source layer costs one refactor and yields a plugin surface
that requires no new security boundary.

## What the three are today

| | Workbench | ViewBoard | Remote workspace |
|---|---|---|---|
| Subject | Channel workspace files (`context_files`) | Live projection of platform state | The bot's **actual machine** |
| Transport | `fs.*` verbs over the channel WS | `channel.*.read` verbs over the channel WS (Audit is REST) | REST `/workspace/*`, proxied to the connector |
| Authorization | channel-role | channel-role | per-bot authorization plus the session-workdir root-set |
| Mutability | read/write under an optimistic lock (`if_version`) | read-only | read/write with conflict detection |
| Liveness | `filesTick` | `boardTick`, driven by `board_signal` | `workspace_signal` plus explicit watch/unwatch, plus presence |
| Truth lives in | the gateway file store | the event / session / usage stores | a remote filesystem and its git history |
| Extensible today | yes — scenes and personal renderers | **no** — compile-time registration only | **no** — a single 1,928-line component |

Entry points: [ChannelToolbar.tsx:32](../../frontend/src/features/chat/ChannelToolbar.tsx:32)
lists all four as peer toggles. Verbs:
[resource/mod.rs:86](../../server/src/resource/mod.rs:86) onward. Remote workspace
authorization: [workspace.rs:606](../../server/src/api/workspace.rs:606).

The two-class argument at the top of
[viewBoard.tsx:2](../../frontend/src/features/chat/workbench/viewBoard.tsx:2) — agent-edited
files belong to the Workbench, self-maintained state belongs to a ViewBoard — is correct
and this proposal keeps it. What it does not justify is separate hosts, separate context
types, and separate registries. A source distinction was implemented as a subsystem
distinction.

## Why the split is already half-gone

**The lane treats them as one kind.** The shared window layer names all four in a single
union: `SpawnKind = "workbench" | "viewboard" | "files" | "workspace"`
([laneSnap.ts:30](../../frontend/src/features/chat/workbench/laneSnap.ts:30)). Each panel
gets floating, dragging, resizing, zone-snapping, and first-open placement from
[useLaneWindow.ts:34](../../frontend/src/hooks/useLaneWindow.ts:34) and the lane rect
published through
[LaneBoundsContext](../../frontend/src/hooks/useLaneWindow.ts:10). The *window* concept is
merged. Only the contents still pretend to be unrelated.

**One feature is implemented three times.** GitHub Code reads the same `ChannelProfile`
— repository, branch, head commit, state — and renders it three times against three
context types through three registries:

| Surface | Registry | Call site |
|---|---|---|
| Channel header | `registerChannelHeader` ([channelSlots.tsx:17](../../frontend/src/features/chat/extensions/channelSlots.tsx:17)) | [githubCode.tsx:21](../../frontend/src/features/chat/extensions/githubCode.tsx:21) |
| ViewBoard | `registerComponentViewBoard` ([viewBoard.tsx:144](../../frontend/src/features/chat/workbench/viewBoard.tsx:144)) | [GitHubCodePanel.tsx:33](../../frontend/src/features/chat/workbench/panels/GitHubCodePanel.tsx:33) |
| Workbench panel | `registerWorkbenchPanel` ([workbenchPanels.tsx:12](../../frontend/src/features/chat/workbench/workbenchPanels.tsx:12)) | [GitHubCodeWorkbenchPanel.tsx:52](../../frontend/src/features/chat/workbench/panels/GitHubCodeWorkbenchPanel.tsx:52) |

All three filter by the same `profiles: ["code"]`. That triplication is the running cost
of the split, and it is paid again by every profile-scoped feature that follows.

**The two render contracts are already the same function.** A lens is
`render(data, config, onChange)`
([lens/registry.ts:7](../../frontend/src/features/chat/workbench/lens/registry.ts:7)); a
board is `render(data, ctx, refetch)`
([viewBoard.tsx:122](../../frontend/src/features/chat/workbench/viewBoard.tsx:122)). Same
shape, different names. More telling, `Lens` already carries
`viewOnly?: boolean` — "never calls onChange (machine-written data, humans only view)"
([lens/registry.ts:17](../../frontend/src/features/chat/workbench/lens/registry.ts:17)).
That flag describes a ViewBoard exactly. The convergence was anticipated in the type and
then not taken.

**The plugin roadmap already points here.** [PLUGIN_SYSTEM.md](PLUGIN_SYSTEM.md), under
"Where this is going", commits to growing explicit `channelHeader`, `viewBoards`, and
`workbenchPanels` contributions in the client package format. This proposal's only
disagreement with that plan is arithmetic: grow one contribution kind, not three.

## The model

```ts
interface Panel {
  id: string;
  title: string;
  icon?: IconRef;
  /** Existing filter, unchanged — all three registries already have it. */
  profiles?: string[];
  scope: "channel" | "session" | "bot";
  source: PanelSource;
  view: ViewRef;          // "builtin:<lens>" | "personal:<ext>:<renderer>" | native
  config?: unknown;       // lens-specific (table columns, …)
}

type PanelSource =
  | { kind: "fs";        path: string }            // Workbench today
  | { kind: "resource";  verb: string }            // ViewBoard today
  | { kind: "workspace"; botId: string; path: string }  // Remote workspace today
  | { kind: "rest";      endpoint: string };       // Audit today
```

Each source kind supplies one liveness adapter behind a single interface — `filesTick`,
`board_signal`, and `workspace_signal` are three implementations of "this data changed,
refetch." The coalescing and visibility-deferral logic already written once in
[useBoardTickRefetch](../../frontend/src/features/chat/workbench/viewBoard.tsx:53) becomes
the shared implementation, and
[useResourceQuery](../../frontend/src/features/chat/workbench/useResourceQuery.ts:24)
becomes the generic loader.

`Scope` replaces three ad-hoc mechanisms: the ViewBoard's own session selector, the
Workbench's channel binding, and Remote workspace's bot selector. They are the same
control with different vocabularies.

### What happens to the three names

They survive as **lane presets**, not subsystems: a default panel set plus a navigator.
"Workbench" is the fs-source preset with a file tree. "ViewBoard" is the resource-source
preset with a tab strip. "Remote workspace" is the workspace-source preset with a git
sidebar. Users keep the words; the codebase stops keeping three of everything behind
them.

## Plugin tiers

The tiers fall out of the rule [PLUGIN_SYSTEM.md](PLUGIN_SYSTEM.md) already enforces —
*third-party code never runs where it would inherit ambient authority* — with no new
boundary introduced.

| Tier | Contribution | Where it may install | New security surface |
|---|---|---|---|
| **A — declarative panel** | `{source, view: "builtin:*", config}` | Global (admin, server-stored), personal, temporary | **None.** It is a scene pointed at a verb instead of a file. |
| **B — sandboxed renderer panel** | Tier A plus renderer JS | Personal macOS only, as today | **None.** Same iframe, same CSP, same capability check. |
| **C — native panel** | Compiled component | First-party, in-tree | n/a |

Tier A is the whole point. A declarative panel over `resource://channel.plan.read`
rendered by `builtin:table` is expressible in the existing manifest grammar the moment
`source` accepts a verb, and the verb allowlist already exists as
[`EXTENSION_CHANNEL_RESOURCES`](../../frontend/src/features/chat/workbench/extensions/package.ts:16).
Plan, Cost, and Sessions are close to expressible this way today; what blocks them is not
safety but that a scene's source is hardcoded to a file path.

Tier B needs one addition to the JSON-RPC surface in
[RENDERER_PLUGIN.md](RENDERER_PLUGIN.md): a `panel.data` method beside `file.render`.
Everything else — opaque origin, permission-derived CSP, request IDs, lifecycle disposal
— is unchanged, because the sandbox never cared what the bytes were.

## Boundaries that must not move

These are the places where the "one concept" instinct is wrong. A merge that crosses any
of them is a regression, not a simplification.

1. **`workspace://` is not `fs://`.** The Workbench's fs verbs authorize by channel-role.
   Remote workspace authorizes per bot against the session-workdir root-set
   ([workspace.rs:606](../../server/src/api/workspace.rs:606),
   [SESSION_WORKDIR_ROOTSET.md](SESSION_WORKDIR_ROOTSET.md)). Unify the *client* contract;
   leave the *server* seam exactly where it is. One panel type reading two verb families
   is fine. One verb family serving both is a privilege escalation.

2. **No plugin may declare a `workspace://` source.** A declarative panel that can name
   arbitrary paths on a bot's machine is a different risk class from one that reads a
   channel verb, and the manifest is attacker-controlled data. Keep this source
   first-party at minimum until the dedicated plugin signing root lands
   ([PLUGIN_SYSTEM.md](PLUGIN_SYSTEM.md), known inconsistency 4). Validation belongs in
   the shared grammar, which means a corpus case, not a comment.

3. **`viewOnly` is a property of the source, not the view.** A read-only projection
   rendered by a writable lens must not become writable. Today the Workbench's
   `if_version` lock is what stops a stale snapshot overwriting a concurrent agent write;
   a projection has no such lock because it has no version. If the flag migrates to the
   view, the first plugin that binds `builtin:table` to `channel.sessions.read` gets a
   Save button over data that cannot accept one.

4. **The grammar stays implemented three times, deliberately.** A personal package is
   never uploaded, so the client cannot ask the server whether it is valid. Adding a
   `panels` contribution means adding it to
   [workbench_extensions.rs](../../server/src/domain/workbench_extensions.rs),
   [package.ts](../../frontend/src/features/chat/workbench/extensions/package.ts), and the
   SDK's pre-flight — held in agreement by
   [fixtures/workbench/corpus.json](../../fixtures/workbench/corpus.json) and
   [limits.json](../../fixtures/workbench/limits.json). Add the corpus cases first, watch
   both sides fail, then make both pass.

## Migration order

Risk-ascending. Each step is independently shippable and steps 1–2 are invisible to users.

1. **One registry.** Replace `registerChannelHeader`, `registerWorkbenchPanel`, and
   `registerViewBoard` / `registerComponentViewBoard` with `registerPanel`, carrying a
   `surface: "header" | "lane" | "inline"` field. Pure refactor. Immediately collapses
   GitHub Code from three implementations to one.

2. **One host — which already exists.** The host is not something to extract:
   [`FloatingPanel`](../../frontend/src/components/ui/floating-panel.tsx) already
   provides lane-vs-viewport float, drag, resize, snap, z-order, collapse-with-glance,
   the mobile sheet, and DESIGN.md-correct `ActionButton` chrome, and
   `ChannelFilesDialog`, `BotTracePanel` and `RemoteWorkspaceDialog` already use it. The
   only two lane occupants that hand-rolled all of it were `WorkbenchDrawer` and
   `ViewBoardDrawer`, so the work is migrating those two onto it and giving it the three
   props they need that no other caller did: `open` (closed but MOUNTED, so the file
   tree and visited tabs survive), controlled `collapsed` (the ViewBoard's flag is owned
   by `useChannelInstruments`), and `dropTarget` (the Workbench's `.cheers-extension`
   drop). `useLaneWindow` had exactly those two callers and retires with them; only
   `LaneBoundsContext` survives, in `hooks/laneBounds.ts`.

3. **Source abstraction.** Introduce `PanelSource` and the per-kind liveness adapter.
   `useResourceQuery` becomes the loader for every kind;
   [makeFsClient](../../frontend/src/features/chat/workbench/fsClient.ts:25) becomes one
   adapter among several rather than the Workbench's private door.

4. **Manifest grammar.** Add the `panels` contribution beside `scenes`, gated to Tier A
   sources. Corpus cases first, per boundary 4 above.

5. **Then decide the UX.** Four toolbar toggles become one "add panel" control plus a
   picker. This is the step that makes plugins *discoverable* — a contributed panel
   appears in the same list as the built-ins instead of hiding inside whichever subsystem
   happened to accept it. It is listed last because it is the only step a user can see,
   and it should land on machinery that already works.

`ChannelFilesDialog` (80 lines) is the fourth lane occupant and fits the model unchanged;
it is the cheapest first consumer of `PanelHost` in step 2.

## Mobile follows, and gets the bigger win

iOS carries the same split at greater cost:
`apps/ios/Sources/Views/WorkbenchSheet.swift` (2,826 lines) and
`apps/ios/Sources/Views/ViewBoards.swift` (540). Since
[CLIENT_NAV_IA.md](CLIENT_NAV_IA.md) requires destinations and nesting to match across
clients, any change to the web lane's destination set has to be mirrored anyway — so the
merge is cheaper to port than to skip. Renderer contributions remain macOS-only; iOS and
browser clients continue to ignore them, which the Tier A/B split preserves without a
platform check.

## Open questions

- **Does `scope: "bot"` belong in the same union as `channel` and `session`?** Remote
  workspace is the only bot-scoped panel today. If it stays the only one, the scope union
  is carrying a case for a single caller.
- **Does the Audit board's `rest` source survive?** It exists because Audit has no
  resource verb. Giving it one removes a source kind; the alternative is keeping `rest`
  as a permanent first-party-only escape hatch.
- **Does a preset need to be a first-class object?** Steps 1–4 work with presets as
  hardcoded default panel sets. Making them declarative — and therefore installable —
  is a fifth contribution kind, and should not be decided until Tier A has real users.

## Related

- [Plugin system](PLUGIN_SYSTEM.md) — the authority boundary and the three execution sites
- [Workbench extensions](WORKBENCH.md) — the `.cheers-extension` package contract
- [Workbench renderer runtime](RENDERER_PLUGIN.md) — the sandbox and its JSON-RPC surface
- [Workbench lens spec](WORKBENCH_LENS_SPEC.md) — the built-in view vocabulary
- [Platform-resource permissions](PLATFORM_RESOURCE_PERMISSION.md) — the verb authorization model
- [Session workdir root-set](SESSION_WORKDIR_ROOTSET.md) — why `workspace://` authorizes differently
- [Shared client navigation IA](CLIENT_NAV_IA.md) — the cross-client destination contract
