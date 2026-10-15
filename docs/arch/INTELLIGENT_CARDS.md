# Intelligent UI / Cards

> Status: partly implemented, 2026-10-12. Workbench now has a bounded A2UI
> renderer, gateway validation, staged reply cards, typed requests through ACP,
> inline Desk previews and Mac native handoff. Global URI and remote operation jobs remain proposals. [Usage](../help/INTERACTIVE_RESOURCES.md).
> [中文](INTELLIGENT_CARDS.zh-CN.md)

## Implemented integration loop

See the [usage guide](../help/INTERACTIVE_RESOURCES.md). Remote MCP discovery,
validated Desk documents/actions, staged reply cards with minimal inline previews, Workbench typed requests
through existing ACP prompts, and versioned resource updates are implemented.
Mac handoff reuses the existing original/downloaded-copy adapter. The global
ResourceRuntime, v2 descriptors, and remote operation records below remain designs.

## Definition

An **Intelligent Card** is a model-authored, host-rendered interaction surface for
an addressable resource or a registered operation. The model describes intent,
content, and suggested actions. Cheers resolves the target, verifies authority,
renders supported controls, and records the actual result.

**Card = target + presentation + action bindings + authoritative state.**

“Intelligent” means that a reply can adapt its controls to the resource and the
viewer's capabilities. It does not mean model-supplied code gains host authority.
Cards can appear in messages, Workbench panels, or Canvas nodes. Their container
does not change their execution privileges.

## Backend/frontend ownership

The backend owns **resource meaning**; the frontend owns **presentation and
interaction with the viewer's environment**. The shared boundary is a versioned
resource descriptor, rather than backend-generated platform UI.

The backend manages canonical URI identity, originating scope, aliases, resource
resolution, access checks, and revisions. It parses supported content into
validated semantic structures: file metadata, document nodes, Canvas graphs,
form schemas, and resource relationships. It also validates model-authored card
definitions and describes permitted resource operations and their input schemas.
Large or opaque content can be returned as an authorized content reference with
MIME type and revision; semantic parsing does not require decoding every format.

The frontend consumes those structures, chooses a registered renderer, and owns
layout, localized controls, focus, local drafts, and selection. It routes resource
links to chat, Canvas, Workbench, or source view, and adapts external interaction
to the current platform: browser navigation, downloads, clipboard, native file
open/reveal, application handoff, and sandbox UI events. Reading pixels, browser
decoding, and editor ASTs for highlighting are presentation work; they do not
replace backend resource identity, semantic validation, or authorization.

A proposed descriptor includes `schema_version`, `canonical_uri`, `resource_type`,
`mime_type`, `revision`, `metadata`, either parsed `content` or `content_ref`, and
`allowed_operations`. The frontend combines the permitted operations with its
local capability registry to determine available controls. Device permissions
remain authoritative at the local executor; the backend cannot infer them simply
from client type. Backend-provided view hints are optional and declarative.

The data path is:

`model reference → backend URI resolution / content parsing → descriptor → frontend renderer / interaction adapter`

Distinguish three interaction paths:

- **Client interaction**: navigate, expand, copy, download, or open/reveal on the
  viewer's device. The frontend orchestrates these with browser/native adapters;
  resource reads still require backend authorization and native effects still
  require local policy. Pure navigation does not create a server operation job.
- **Resource mutation**: the frontend submits a validated request; the backend
  checks authority and revision, changes shared content, and returns the result.
- **Remote device operation**: the frontend selects a registered action; the
  backend coordinates authorization and the durable operation record; the
  connector executes on the selected device and reports the result.

Both local and remote reveal may use the same presentation, but their execution
bindings must be explicit. The frontend cannot turn a remote workspace path into
a local file, and the backend cannot open an application on the viewer's machine.

## One resource pipeline for the whole system

Treat Card as a resource presentation, not another business subsystem. Every
registered, resolvable resource URI has a default card presentation. A URI does
not need its own component: many URIs of one semantic type share one renderer.
Unknown, deleted, inaccessible, and unavailable targets receive an honest generic
reference/status presentation without exposing protected metadata. A URI whose
target is unavailable does not become a fabricated resource.

The common pipeline is:

`URI → ResourceRuntime → gateway resolver / source handler → ResourceDescriptor → renderer registry → interaction dispatcher → executor → result / resource invalidation`

`ResourceRuntime` is a proposed shared client boundary with `resolve`, `subscribe`,
and `invoke`. It owns scoped identity, query/subscription deduplication, local
capability matching, action dispatch, and result normalization. Renderers consume
resource state and emit typed interaction intents. They do not parse URI business
semantics, fetch resources directly, invoke native commands, or send ad hoc chat
messages to implement actions. Pure navigation also enters the interaction
dispatcher but is executed locally without creating a backend job.

The backend resolves URI identity and semantic anchors through a source adapter,
then uses the existing authorized handler/producer. Content parsers are registered
by semantic type/format and supply one validated descriptor. There is no second
file store or Card-only read/write endpoint. REST, WebSocket, MCP, and native
bridges may remain different transports; all adapters converge on the same
resource and invocation contracts. Existing domain approvals retain their required
resolution semantics behind bindings in the same dispatch path.

The renderer registry is keyed by semantic `resource_type`, supported content
format, and contract version. MIME alone cannot distinguish a Canvas from another
YAML document. The host selects an available renderer from backend type metadata
and optional validated view hints. Native clients implement the same semantic
renderer entries using their own controls; no feature-specific registry for chat,
Canvas, or mobile is added.

Presentation receives container (`message`, `panel`, `canvas_node`, or detail
route), existing `PresentationLevel` (`minimal`, `medium`, `max`), and optional
focus anchor. The outer container owns placement, navigation history, and Canvas
geometry; the renderer owns resource content and interactions. File cards, file
panels, and file Canvas nodes consume one file state/action model. Rich content
may have dedicated compact/detail implementations within that one renderer entry;
it must not gain independent data loading or execution rules.

Registering a resource type requires a default summary presentation, available
detail views, permitted action schemas/executors, and unsupported-platform behavior.
Examples: file → file summary/preview, message → message summary/thread target,
Canvas → document summary/graph or node list, operation → status/receipt, and
approval → pending/resolved state with its actual resolution binding. Unsupported
specialized views fall back to generic resource metadata and allowed interactions.

Resource cache identity includes instance, originating scope, canonical object,
and revision mode; authorization-dependent state is isolated by authenticated
principal. Different anchors can share object data while retaining distinct focus
targets. Card expansion, Canvas pan/zoom, and local form drafts remain viewer state.
Alias canonicalization prevents duplicate resource subscriptions; a copied URI
does not change its channel or execution device.

Migration should replace callers at shared seams: extend gateway `resolve_frame`
and existing dispatch, converge loaders behind the resource runtime, adapt Lens
`{source, view, config}` into that runtime, and route existing locator opens,
`onOps`, and form submissions through registered interaction bindings. Legacy
representations normalize once at the boundary; they must not become parallel
protocols used by new features. Delete replaced loading/routing paths after their
callers migrate, rather than permanently layering a new Card framework over them.

Acceptance: the same URI in a message, panel, and Canvas node resolves the same
resource/revision, shares authorized state updates, exposes equivalent action
meaning, and returns the same execution receipt. Every registered resource type
has a card renderer or explicit generic fallback. This is the target architecture,
not a claim that every existing Cheers URI already has a specialized card today.

## Existing foundation, verified against code

- `frontend/src/features/chat/ResourceRefCards.tsx` renders v1 `resource_ref`
  cards from message `content_data.cards`, with navigation as their interaction.
- `server/src/resource/messages.rs` validates one to three read-only cards,
  rejects unknown fields, and authorizes a bot attaching to its own partial or completed reply. Partial cards
  publish atomically at completion.
  `packages/cheers-mcp-server/src/registry.rs` exposes card attachment to agents.
- `frontend/src/features/chat/locator.ts` and the Rust locator mirror support
  channel-relative `cheers:desk/…`, `cheers:ws/…`, `cheers:inbox/…`, messages,
  projections, line anchors, and Desk `#^id` anchors.
- `frontend/src/lib/deepLink.ts` routes desktop
  `cheers://channel/<id>?msg=<id>`. This is a navigation route, not a universal
  resource address across gateway instances.
- Structured Canvas documents use nodes, edges, and `{source, view, config}`;
  `fs.patch` is their structured write path. See `CANVAS.md` and
  `frontend/src/features/chat/workbench/canvas/document.ts`.
- HTML/React artifacts also exist in `lens/ArtifactLens.tsx`. Its sandbox bridge
  accepts `form.submit` and `action.trigger`. `panels/FilePanel.tsx` currently
  handles their payloads with `ctx.composeMessage`: they populate a chat draft,
  rather than execute a registered desktop operation. Older Canvas design status
  notes do not describe all of this newer implementation.

The root gap is a shared target/action/result contract, not missing card markup.

## Card and Canvas

A Card is one bounded interaction: preview a file, choose a value, inspect a
change, or launch an operation. Its identity belongs to the presented resource
or operation; its message is provenance and conversation context.

A structured Canvas is an authored document organizing multiple nodes and
relationships. Its node placement and edges are shared content; pan/zoom is
viewer state. A card may be one node's presentation, and a Canvas file itself
may be the target of a message card. Adding a card to a Canvas stores a reference,
not a second copy of its execution state.

An HTML/React Canvas artifact is a custom interactive view. It can express much
richer layout and local UI logic than a standard card. A future action bridge
must still use the same host action registry: artifact scripting and desktop
authority are separate capabilities. Keep the existing chat-draft submission
mode explicit rather than silently turning old forms into executable commands.

Workbench layout is a viewer's arrangement of panels. It is neither card state
nor a shared Canvas document. Keep all three persistence responsibilities apart.

## Initial card vocabulary

1. **Resource card**: file/attachment/Canvas preview; Open, Download, reveal source,
   or an applicable registered local opener. Show resource revision and availability.
2. **Operation card**: target device, proposed effect, inputs, progress, result,
   and relevant cancellation/undo controls. Examples: reveal a registered file
   in Finder, open it in an approved application, or apply a reviewed change.
3. **Form card**: bounded fields, schema validation, and an explicit submission
   binding. Reuse ACP elicitation when the interaction is already an elicitation;
   preserve its responder and resolution semantics.

Use a registered `view` to specialize these surfaces, rather than a new top-level
card kind for every business feature. These categories are presentation modes,
not separate loaders, stores, or execution frameworks. Existing permission, auth-required,
elicitation, and task-claim cards keep their native protocol and endpoints behind
shared presentation. A generic model-authored approval-looking button must not
resolve those requests.

## Proposed v2 authoring envelope

The following is illustrative future JSON, **not accepted by the v1 endpoint**:

```json
{
  "v": 2,
  "id": "summary-file",
  "kind": "resource",
  "target": "cheers:desk/reports/summary.pdf",
  "view": "builtin:file",
  "title": "Summary report",
  "description": "Open the generated report or reveal the local copy.",
  "actions": [
    { "id": "open", "binding": "resource.open" },
    {
      "id": "reveal",
      "binding": "desktop.reveal",
      "input": { "device_id": "device-7", "file_handle": "file-42" }
    }
  ]
}
```

The gateway freezes local target scope to the emitting instance/channel at
ingestion and produces a canonical target. It validates unique card/action ids,
version, kind, view, bounded content, and binding-specific input schemas. It
returns a persisted card reference, parsed resource descriptor, and viewer-specific
permitted resource operations. The frontend adds supported local interactions and
filters the final actions against its capabilities. Model-written title/description are commentary, not proof of
file existence, trust, operation completion, or authority.

The frontend owns control labels, icons, routing, and platform adapter selection
through registries. The backend and local executor own their respective permission
requirements; the frontend displays their policy metadata. Unknown versions retain message text
and a supported resource link; unsupported action bindings are never executed.
Keep v1 read-only cards valid. Introduce an explicit v2 validator/transport contract
instead of weakening the v1 validator or treating extra fields as active actions.

## Execution and state

The invocation request identifies persisted card/action, validated inputs,
expected target revision when applicable, and an idempotency key. The acting
principal comes from the authenticated request, not from the model payload or
the original bot's authority. Capabilities are checked again at execution.

Server actions go through existing gateway resource handlers and authorization.
Device actions go through a registered local executor/connector with a device
grant; the local boundary verifies the file handle, app allowlist, exact input,
and user/device policy. Browser status, a URI, or model-selected `desktop.*` text
does not confer this grant. No arbitrary Tauri command names, shell commands, or
absolute local paths are accepted as action bindings.

For each accepted remote-device or asynchronous server invocation, persist an
operation record with states (ordinary navigation and local UI interaction are
outside this job lifecycle):

`queued → running → succeeded | failed | cancelled | unknown`

“Unknown” covers lost contact where execution may already have happened; do not
blindly retry a side effect. Admission failures such as forbidden, unavailable,
stale revision, and invalid input occur before execution. Approval requirements
are decided by executor policy for the exact target/input/revision. Reversible
low-impact actions can run directly; irreversible effects follow that policy.
Cancellation requests do not mean cancellation succeeded, and undo is shown only
when an executor actually supports it.

Idempotency deduplicates replayed invocations. Separate invocations need new keys;
one-shot form submissions and approvals additionally need atomic resolution.
Use executor deduplication/reconciliation for device effects; a gateway key alone
cannot guarantee exactly-once OS execution across crashes.

Push operation updates through the existing realtime infrastructure. Display the
operation id, executor/device, result, and artifact links. Card appearances in
chat and Canvas resolve the same operation record; a later unrelated run must
not overwrite the historical result of an earlier invocation.

Keep message/card definition as the authored snapshot, resource data as current
or explicitly revision-pinned, operation records as execution truth, and expanded
state/form drafts as viewer state. Label these distinctions in the UI.

## Global URI

**Existing `cheers:` locators are contextual, not global.** Keep them as compact
authoring aliases. Resolve them using their persisted originating scope, never
the currently selected channel after a card is copied elsewhere.

Reserve a new global resource namespace, separate from existing OS route hosts:

```text
cheers://resource/<instance-id>/channels/<channel-id>/desk/reports/summary.pdf
cheers://resource/<instance-id>/channels/<channel-id>/desk/canvases/arch.canvas.yaml#^plan
cheers://resource/<instance-id>/channels/<channel-id>/messages/<message-id>/cards/<card-id>
cheers://resource/<instance-id>/channels/<channel-id>/operations/<operation-id>
cheers://resource/<instance-id>/devices/<device-id>/files/<file-handle>
```

This syntax is proposed and requires coordinated TypeScript/Rust parsers,
gateway resolution, and OS deep-link routing. `<instance-id>` is a stable gateway
identity mapped to a configured endpoint; it is not an arbitrary URL to fetch.
Instance identifiers need a defined provisioning/restore policy. Scope survives
navigation, but resolution still requires access and a reachable instance/device.
“Global” means unambiguous identity, not public access or universal reachability.

Global identity must not depend on an account's `@handle` or an unqualified local
file path. Remote workspace resources need stable bot/workspace identifiers;
device files need registered opaque handles. A handle is an identifier, not a
bearer credential; never embed access tokens or device grants in copied URIs.

Desk path URIs are globally **qualified**, but a rename can break them. If durable
links across renames are required, add stable file ids plus path aliases/tombstones;
do not claim that qualifying a path solves identity. `#^id` identifies a semantic
element where the target format supports it. `#L…` is useful for source navigation
but can drift unless the link also pins a revision.

Actions are registered bindings; merely opening a URI only navigates/reads. A URI
for an operation resolves its record, never starts the operation. Support separate
HTTPS share links generated by the configured gateway origin for browser access;
these open the same target with the same authorization, not a public duplicate.

## Presentation and capability behavior

Reuse Cheers `leading → title → critical status/status → actions`, shared
ActionKey registration, and `medium / regular` defaults. Use native form/lens
structures for richer content rather than decorative boxed-card walls. Preserve
44px Web/iOS interaction hit areas, keyboard paths, visible focus, inline progress
and recoverable errors. Use shared 14px utility text and existing semantic tokens.

Capabilities follow the selected executor, not simply Web versus desktop. A Web
client may request an authorized connected device action; a desktop client may
lack the target device grant. When unavailable, retain preview/download and show
why the local action cannot run. Do not imply that the file exists on the viewer's
machine just because a bot's workspace contains it.

## Desktop and mobile

Share resource identity, semantic content, and action meaning across clients;
implement presentation and interaction adapters in React/Tauri, SwiftUI, and
Compose. Do not make React code the portable card format. Native renderers need
explicit implementation; protocol support does not imply an existing SDK for
each Cheers client.

Actions declare execution scope: `viewer`, `server`, or `registered_device` with
a stable device id. “Reveal on Mac” still targets that Mac when viewed on a phone.
“Open on this device” is a separate interaction that may download an authorized
copy. Never silently retarget a failed remote action to the viewing device.

Determine availability from permitted operations, supported binding/renderer
versions, local permissions, target grants, and connectivity. Distinguish
unsupported, permission-required, offline, and expired from runnable actions.
Recheck at execution; reported client capabilities are not permission grants.

- Desktop uses panels, keyboard/pointer controls, and registered native app/file
  adapters. macOS, Windows, and Linux report actual capabilities separately.
- Phones use compact summaries and native detail sheets/full-screen routes,
  preview/share/document pickers, and native forms.
- Tablets and resizable windows select single/split presentation by available
  space and input. Mobile Canvas can show a semantic node list and detail using
  the same node ids and relations. List ordering must not rewrite spatial layout.

Custom artifacts retain a meaningful summary/source/native preview fallback.
Supported Canvas edits still use backend revision checks and structured writes.
Preserve large text, accessible labels, visible gesture alternatives, and 44pt
iOS / 48dp Android targets. Load large content lazily from bounded descriptors.

Prefer backend-generated HTTPS resource links for sharing, with optional verified
iOS Universal Links / Android App Links. Self-hosted domains require their own
association setup; otherwise retain browser access and explicit app opening.
Authentication or server selection preserves the pending target and source
conversation. Unknown instances are not silently selected. Canonical Cheers URIs
remain distinct from OS launch URLs and transient file permissions.

iOS uses system preview/share and granted file imports; Android file sharing uses
`content://` and temporary access grants. Sharing a resource link and exporting
a file copy are different actions; exported files do not automatically write back.
External app handoff success means the request was accepted/opened where observable,
not that the external task completed.

Persist a pending invocation's idempotency key before sending. Remote/server jobs
outlive the viewing app; reconcile their state on foreground/reconnect instead
of assuming uninterrupted mobile realtime. Leaving a view does not cancel a job.
Label cached content stale and do not silently queue offline side effects for
later execution. Scope caches/drafts by account and resource; clear them as
appropriate on logout and do not retain temporary download credentials as links.

Existing iOS foundations include `ChatView.swift` import/share,
`WorkbenchSheet.swift` Quick Look temporary-file preview, and `CheersApp.swift`
foreground session/realtime recovery. These are not proof of v2 card or global
URI support. Android likewise needs explicit card/adapter implementation.

References: [Apple Universal Links](https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content),
[Android App Links](https://developer.android.com/training/app-links),
[Android file sharing](https://developer.android.com/training/secure-file-sharing).

## Existing protocols and the interaction loop

**A2UI** supplies declarative UI surfaces, component catalogs, data bindings, and
user action messages. It is a candidate for the portable Card presentation
contract. Cheers would define its catalog and native renderers, validate actions,
and map them to registered bindings. Pin a protocol version: the official site
currently labels 0.9.1 current and 1.0 candidate; do not mix their action schemas.
[A2UI](https://a2ui.org/), [actions](https://a2ui.org/concepts/actions/).

**MCP Apps** supplies a tool-to-UI-resource association and a sandboxed HTML view
bridge. Views can request server tool calls, host links, or model-context updates.
Use it for external MCP tool interfaces and compatible custom artifacts; it is
not by itself a native SwiftUI/Compose card format. Its `ui://` URI names a UI
resource on an originating MCP server, not a globally identified Cheers file.
[MCP Apps overview](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html),
[bridge methods](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html).

**AG-UI** describes agent/frontend event and state exchange. It is an optional
adapter when integrating an agent runtime that speaks it, rather than a reason
to replace Cheers' existing realtime transport for the first card release.
[AG-UI overview](https://docs.ag-ui.com/introduction).

These layers can interoperate; A2UI documents an MCP Apps integration. They do
not replace Cheers URI management, authorization, device execution, operation
receipts, or reconnect reconciliation.
[Integration guide](https://a2ui.org/guides/a2ui-in-mcp-apps/).

Recommended next-step loop for a received card:

1. Resolve its target with the backend, validate its version/catalog, obtain the
   descriptor, and render supported controls through the client capability adapter.
2. A click produces a typed user action tied to persisted card/action identity,
   target, validated inputs, execution scope, expected revision, and invocation id.
   This is a Cheers binding envelope; it is not claimed as standard A2UI JSON.
3. Dispatch local navigation/handoff to the frontend adapter, shared mutation to
   the gateway, and remote effects to gateway/connector execution. Do not ask the
   model to reinterpret every registered button click as prose.
4. Return a structured result: navigation/handoff outcome, new resource revision,
   operation id/status, or updated UI data. Refresh the same card/surface. Only
   actions explicitly requesting agent continuation create/update agent context;
   ordinary refresh, paging, and opening need not start another model turn.

Recommended direction: use URI-based resource resolution and the Cheers descriptor
as the core contract. A2UI is an optional presentation format for resources needing
generated controls, MCP Apps an external UI adapter, and AG-UI an optional agent
integration. These are proposals, not installed dependencies or implemented
compatibility claims.

## URI-first resource interaction

The primary object is an addressable resource, not a generated UI surface. A
model can emit only a resource URI; the backend resolves it to an authorized
descriptor, and the frontend renders a default card for that resource type.
Titles, preferred views, and commentary are optional presentation hints. The
same URI can appear in chat, a Canvas node, a notification, or a copied link
without requiring the original generated component tree.

Expose resource **affordances**: registered interactions available for the current
principal and target, with action id, relation, execution scope, input schema,
and a typed invocation binding. The frontend maps those descriptions to controls
and local adapters. A URI answers “which object?”; the descriptor answers “what
is it and what may I do?”; the invocation contract answers “how do I request an
effect and observe the result?” Opening an action/operation reference never
implicitly performs a mutation. Treat resource and operation reads separately
from explicit invocation, with authorization checked at invocation time.

A2UI principally answers “which UI components and data bindings should be
rendered, and what user action should they emit?” Its surface/component identity
does not substitute for Cheers' global resource identity, aliases, access rules,
or revision policy. An A2UI surface may refer to a Cheers URI and have its actions
adapted to resource affordances. Keep its catalog/component parsing as a
presentation concern; keep resource semantics authoritative at the gateway.

This is a resource-oriented/hypermedia design, not a claim that a universal
URI-based card standard already covers desktop/mobile execution. URI syntax
alone does not define descriptors, available actions, capability matching,
idempotency, or receipts; Cheers must specify that small shared contract. Start
with a file URI, default native card, authorized open/download interactions,
and an explicit remote-device action before adding generated component trees.

## Implementation order and acceptance

1. Define canonical scoped targets and their TS/Rust fixture corpus; normalize v1
   locators to originating scope internally. Add global resolver/navigation with
   instance, channel, anchor, rename, and authorization behavior documented.
2. Add v2 resource cards and host action registry, starting with existing read
   operations. Verify text fallback and cross-platform capability rendering.
3. Add durable operation receipts and one registered desktop action, such as
   revealing an already granted device file. Verify input validation, grants,
   disconnect reconciliation, retries, and actual execution receipts.
4. Reuse the card renderer in Canvas/Workbench. Preserve `{source, view, config}`
   through a target-to-source adapter; do not add another Canvas persistence store.
5. Add form bindings and optional sandbox bridge actions after those contracts
   work. Keep `composeMessage` and registered execution as explicit distinct modes.

Acceptance includes copying a card across channels without retargeting it,
opening its target from chat/Canvas/raw source, rejecting forged native actions,
preventing repeated clicks from duplicating one invocation, and rendering useful
fallbacks for unsupported clients. The bounded A2UI/TSX renderers, gateway action validation, staged cards, ACP request
dispatcher and Mac adapter are implemented. The resource-state follow-up adds a
shared global descriptor resolver, retained Desk revisions, private CAS drafts and
device-bound workspace execution with PTY terminals and durable receipts. See
[the usage guide](../help/INTERACTIVE_RESOURCES.md) for the supported clients,
policy controls and explicit limits; cross-server federation and native mobile
terminal surfaces remain future work.
