# Model-authored interactive resources

> Implemented for the React Web/Tauri Workbench. [中文](INTERACTIVE_RESOURCES.zh-CN.md)

An interactive UI is an ordinary channel file, opened using an ordinary resource
locator. Workbench renders it through `builtin:a2ui`; it has no separate storage,
loader, or navigation surface. Existing file access and revision checks apply.

## Author a resource

1. Call `read_ui_contract` on the injected Cheers MCP server. It returns the
   supported version, catalog, guide and example without requiring a Cheers
   checkout. `example` prepares a draft; `request_example` sends a structured
   request and, for authenticated Bots, already names that Bot as its target.
   Human discovery uses an example UUID; replace it with the intended Bot id.
   MCP `resources/read` also serves `cheers://help/interactive-ui`,
   `/catalog`, and `/example`. The canonical local catalog is
   `design-system/a2ui-catalog.json`.
2. Use existing channel file tools (`fs.write`, or `fs.patch` for structured
   changes) to persist a JSON/YAML document, for example `forms/report.a2ui.json`.
3. Return `cheers:desk/forms/report.a2ui.json` in the reply. Call
   `set_resource_cards` with the current reply's `msg_id` and existing v1
   `resource_ref` cards before finishing: partial replies stage `pending_cards`,
   and stream completion promotes them atomically into `cards`. Opening that card reaches Workbench and
   shows a minimal inline preview for Desk files. Small forms can be used directly
   in the reply; Expand reveals more controls and the header opens Workbench.
   Workbench automatically selects the matching renderer. Preview and Raw share one file
   session; the UI controls keep local form drafts rather than changing the file.

The persisted wrapper is a Cheers convention:

```json
{
  "a2ui": "v0.9.1",
  "messages": [
    {
      "version": "v0.9.1",
      "createSurface": {
        "surfaceId": "summary",
        "catalogId": "urn:cheers:a2ui:catalog:v1"
      }
    },
    {
      "version": "v0.9.1",
      "updateComponents": {
        "surfaceId": "summary",
        "components": [
          { "id": "root", "component": "Text", "text": "Report is ready." }
        ]
      }
    }
  ]
}
```

Each message follows the pinned A2UI envelope. This is a bounded custom catalog,
not support for the entire Basic Catalog or all A2UI features. It accepts
`createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface` in
order, with at most eight active surfaces. Every active surface needs `root`.
Component updates may reference later definitions within the transcript; final
missing children or cycles are rejected. Only this catalog id is supported.

## Components and actions

`Column` / `Row` hold explicit child ids. `Text` renders escaped plain text.
`TextField` and `CheckBox` have persistent labels and write to absolute JSON
Pointer paths in local draft data. `Button` uses a descriptive adjacent label
with registered Cheers Open/Request controls. Strings can be literal or
`{"path":"/report/topic"}` bindings. Relative paths, collection templates,
function calls, custom scripts, arbitrary styles, media URLs, and custom themes
are not in this catalog. Unknown properties fail validation.

Buttons support four explicit event names:

- `cheers.open`: context `{ "uri": "cheers:desk/reports/source.md" }`, or a URI
  data binding. Opens an existing locator through the host navigation boundary.
- `cheers.compose`: context with `actionId` and a `payload` object whose values
  are JSON scalars or data bindings. Prepares `[Action <id>] …` in the existing
  chat composer. The viewer reviews and sends it; clicking does not start an
  agent turn, send a message, or execute a desktop command.

- `cheers.request`: context `{ "actionId": "report.prepare", "botId": "<stable
  bot UUID>", "payload": { "topic": { "path": "/report/topic" } } }`.
  Sends an explicit user request through the existing human message endpoint,
  then the existing Bot task/ACP `session/prompt` pipeline. The host adds
  `sourceUri`, `sourceVersion`, surface/component ids and a UUID `invocationId`.
  The gateway reauthorizes channel write and the declared Bot, verifies the source
  revision, declared action/target and exact payload keys/literals. Bot replies
  update the same file with `if_version`; existing resource signals reload it.
- `cheers.openNative`: context `{ "uri": "cheers:ws/<bot UUID>/src/file.rs",
  "opener": "zed" }`. Cheers for Mac uses the existing registered-root and
  installed-editor checks (`finder`, `vscode`, `zed`). Authorized local workspace
  files open as originals; Desk/remote files open as downloaded copies. The result
  distinguishes both. External edits to a copy do not write back. Web disables
  this action and retains the resource preview.

Forms from HTML/React artifacts and extension views now normalize through the
same Workbench interaction dispatcher. The file panel and Collection host no
longer maintain separate form-to-draft implementations. Renderer inputs are
untrusted; the dispatcher validates locator/action/payload limits independently.

Input drafts belong to the current view. A source document update or switching
away/remounting resets them to the new source data. There is no implicit form
writeback or claim of cross-device draft synchronization. Unsupported or malformed
documents retain Raw access; explicitly selecting this renderer explains the
error. Missing host capabilities disable controls and preserve readable content.

## Preview and boundaries

Run `pnpm dev` in `frontend/` and open `/dev/a2ui.html` on its reported URL. The
fixture shows source editing, bound text/checkbox inputs, prepared drafts, URI
navigation feedback, and invalid-input errors. It does not connect to a gateway.

## Inline presentation

Desk cards in replies use the same A2UI renderer and interaction dispatcher as
Workbench. Text/code files show an escaped source preview; HTML/React scripts are
not executed inline. Workspace, attachment and projection locators retain their
existing open entry, without pretending to have a Desk preview adapter.

The optional Cheers storage-wrapper metadata selects a subtree:

```json
"views": {
  "minimal": { "surfaceId": "report", "root": "summary" },
  "medium": { "surfaceId": "report", "root": "root" }
}
```

These are Cheers presentation hints, not A2UI protocol messages. Both parsers
verify that each view references a component in an active surface. Minimal views
allow one surface, 16 component visits, three inputs and two actions. Small files
without view metadata use the full root; larger forms ask for inline expansion
instead of silently omitting input fields. Expanded content scrolls within the
reply; Workbench remains the complete/source-editing view. Form drafts survive
expand/collapse on the same surface, and reset on a new source revision.

The channel shares one authenticated FsClient and server-snapshot store across
reply cards and Workbench. Concurrent reads coalesce; resource signals refresh
visible previews, and completed editor saves publish into that same snapshot.
Unsaved Raw buffers and local form drafts are separate view state. Offscreen
history cards defer loading. Loading, source/permission errors, retry, refresh and
observed revision remain visible. A preview never bypasses server authorization.

## Bot connection and request contract

The ACP connector's standing output contract and per-turn guidance point agents
at `read_ui_contract`, include the current reply id, and explain staged cards.
The ACP agent must advertise HTTP MCP support; its channel-scoped Cheers MCP
server uses the existing authorized tools. No new ACP RPC or transport is added.
Structured events ride `context_bundle.interaction`, which the connector renders
inside an XML-escaped, untrusted `<interaction>` block. Input grants no authority.

The gateway validates typed A2UI JSON/YAML on writes, patches, edits, appends and
renames, and revalidates the persisted source at submission. Request acceptance
is a durable ordinary human-message receipt. A repeated invocation id with the
same request replays that receipt within the existing 24-hour idempotency retention,
without another message/dispatch, including
when the file subsequently changes or the Bot goes offline. Current caller write
permission is still required. Different input with the same id is rejected.
The UI retains retry ids for the same form/source revision while mounted, disables
controls while submitting, and reports errors without claiming work completed.
After remount/reload a new explicit submission gets a new id; this is not a
persistent offline queue or an exactly-once external-device execution guarantee.

The implemented loop is **MCP discovery → Desk write → current reply card →
Workbench A2UI → typed user request → existing ACP prompt → versioned Desk update**.
Native handoff uses the same dispatcher and existing Mac executor. General global
URI resolution, remote desktop operation jobs/receipts, live A2UI wire streaming,
Canvas embedding, non-Desk inline adapters, and SwiftUI/Compose renderers remain future work.
Channel-relative `cheers:desk/…` is still scoped to the current channel. Message
cards expose bounded Desk previews and navigate to the complete Workbench view.

Reference: [A2UI v0.9.1](https://a2ui.org/specification/v0.9.1-a2ui/).

## TSX request approval

A sandbox bridge request proposes an action; it does not send a message. Cheers
shows the action, target Bot and input outside the iframe. Only a trusted click
on the host Request control sends it. Cancel discards the proposal. Source changes
invalidate approval. Failures remain visible and retry retains the invocation id;
success confirms acceptance, not task completion. Standard form submissions and
compose actions prepare a draft through the shared dispatcher.

The iframe permits scripts and form events without same-origin access. Its CSP
continues to deny outbound form submissions and network access. The runtime is an
installed local pnpm dependency with React peer dependencies, shared by development
and Docker builds.
