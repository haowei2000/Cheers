# Declarative Lens Spec (draft)

> **Language**: English (normative once accepted) · 中文镜像待补(草案定形后再做)
>
> **Status**: **Draft — not implemented** · **Date**: 2026-07-19 · **Owner**: haowei
>
> Supersedes nothing yet. Sits beside [WORKBENCH.md](WORKBENCH.md) (the three-layer
> model) and [PLUGIN_DEVELOPMENT.md](../developer/PLUGIN_DEVELOPMENT.md) (the sandboxed
> HTML plugin contract, which this does **not** replace — see §7).

## 1. Why this exists

The Workbench's point is that a human and an agent operate the **same board**: the bot
writes a file, the human ticks a box or drags a card, that writes back, the bot reads it
next turn. Today the only way to define a board is a **sandboxed HTML plugin** — real
code. That has three consequences we want to escape:

1. **It doesn't run where there is no web sandbox.** The native iOS client cannot host an
   opaque-origin iframe without adopting a WebView, and Apple's guideline 4.7 governs
   non-embedded software (4.7.4 in particular — an index of all offered software with
   universal links — is structurally impossible for plugins installed per self-hosted
   deployment). A declarative lens is **data, not code**: it is parsed into parameters for
   renderers already compiled into each client's binary, so it is out of that scope
   entirely. That exemption is conditional — see §6.
2. **The same widget gets reimplemented per input format.** `builtin:kanban` (JSON
   `{columns:[…]}`) and `cheers-kanban-md` (markdown `##` headings) draw the same UI and
   differ only in parsing. So do `builtin:table` and `cheers-table`. Eight
   implementations, five distinct widgets.
3. **Customisation costs writing JavaScript.** "Define your own board" should not require
   authoring, bundling and installing an HTML file.

## 2. Substrate: commented YAML, not JSON

**Board files are YAML documents.** JSON is not a supported source format for declarative
lenses (files that happen to be JSON still open in the editor fallback, §5).

The reason is comments. In a shared human/agent file, comments are how the human says
"don't reorder these" and how the bot explains what it did. JSON cannot carry them — and
this project has already paid for that: `.workbench.json` invented a `_doc` **field**
purely to smuggle documentation into a format with no comments, as
[yamlDoc.ts](../../frontend/src/features/chat/workbench/yamlDoc.ts) says outright.

**The load-bearing requirement is on writes, not reads.** A `parse → serialize` round trip
destroys every comment, which would make choosing YAML pointless. Writes MUST patch the
parsed document (a CST that carries comments and blank lines), touching only changed
nodes. The web side already does this; its documented loss cases (multi-document streams,
anchors/aliases, and length-changed arrays fall back to a full re-stringify) are inherited
by this spec and MUST be reproduced identically by every implementation — see §6.

**YAML 1.1 vs 1.2.** Boards are YAML 1.2 documents: `yes`/`no`/`on`/`off` are plain
strings. Agent stacks commonly use PyYAML, which is 1.1 and reads them as booleans. A
writer emitting an unquoted `no` therefore round-trips differently for different readers.
Implementations MUST quote any string value that a 1.1 parser would read as a boolean.

## 3. Model

Choosing YAML collapses the parser axis. The markdown convention parsers
(`- [ ]` lines, `##` sections, `---` frontmatter) exist only because the substrate was
plain text; with a structured document there is nothing to sniff. What remains is two
axes:

```
YAML document ──[ binding: a path + field definitions ]──> widget ──[ structured edit ]──> patched YAML
```

A **lens** is a binding, stored per file in `.workbench.json` (alongside today's
`bindings` and `configs`), or shipped by an environment template:

```yaml
# .workbench.json equivalent, shown as YAML for readability
lens:
  widget: list          # which layout
  at: tasks             # path into the document (omitted = document root)
  group: status         # list only: field to group columns by (a kanban)
  fields:
    done:  { type: bool }
    title: { type: text,   label: Task }
    owner: { type: enum,   options: [alice, bob] }
    ref:   { type: locator }
```

### 3.1 Widgets

| widget | shape at `at` | interaction | notes |
|---|---|---|---|
| `table` | sequence of mappings | edit cell, add/remove row | columns from `fields`, else inferred from the union of keys |
| `list` | sequence of mappings | toggle, reorder, move between groups | `group: <field>` renders columns — **this is the kanban**; a date field enables a timeline mode |
| `form` | one mapping | edit fields | a `table` transposed to a single record |

Two more widgets complete the set (promoted from "deferred" on 2026-07-19 — the official
scenario catalog needs them):

| widget | shape | status |
|---|---|---|
| `chart` | `{series: [{name, points: [[x,y],…]}]}` | exists on web (`builtin:chart`, view-only); iOS follow-up |
| `graph` | nodes + edges (codemap / server-map boards) | **spec'd, not designed** — the richest data model; the declarative successor to `codemap.plugin.html`. Last in build order. |

Build order stays: the three interactive widgets prove the model; `chart` is a port;
`graph` is designed only after the rest ships.

### 3.3 Official scenarios (seeded, `origin='system'`)

Four templates ship in the gateway binary
([`server/assets/workbench-templates/`](../../server/assets/workbench-templates/)), seeded
at startup exactly like official plugins (same `decide` policy: admin deletion sticks
within a release; a higher manifest `version` re-seeds; an admin-claimed id is never
overwritten). All seed **commented-YAML** board files; views reference **built-in lenses
only** (CI-enforced), so they render on web today and on iOS via `fs.read.data`:

| id | family | boards |
|---|---|---|
| `cheers-task-board` | tasks | kanban (Todo/Doing/Done) + backlog table (priority/status enums) |
| `cheers-code-project` | code dev | plan kanban · issues table (severity + `ref` locator column) · progress chart · todo checklist · `codemap/map.yaml` seed (graph follow-up) |
| `cheers-research-lab` | research | experiments table · metrics chart · submissions tracker (venue/status/deadline) |
| `cheers-team-ops` | team mgmt | server inventory table · assets/renewals table · on-call kanban |

Each pins a small `prompts/*-conventions.md` telling the agent which file to keep updated —
that pin is what closes the human↔agent loop on day one.

### 3.2 Field types

`text` · `number` · `bool` · `date` · `enum` (needs `options`) · `link` · `image` ·
`markdown` · `locator`

Field types are **orthogonal** to widgets, which is where the composition pays: a gallery
is a `table` with an `image` field, not a fourth widget.

`locator` holds a `cheers:` URI and renders as a jump — `cheers:ws/<bot>/<path>#L<n>`
opens the workspace at that line. The plugin protocol already carries this (`cheers:open`),
so an agent writing "the bug is here" becomes one tap for the human. No new mechanism.

**Untrusted-value rules** (values are agent-authored):
- `image` MUST NOT auto-load remote URLs by default; channel attachments only, or an
  explicit per-file opt-in. A bot-written URL is otherwise a tracking pixel that leaks
  every viewer's IP.
- `link` MUST show the resolved URL before navigation.
- `markdown` renders inline formatting only — never raw HTML, never auto-linked.

## 4. Coverage check: the four official plugins

Re-expressed in this model, from their actual source in
[`server/assets/workbench-plugins/`](../../server/assets/workbench-plugins/):

| plugin | today | as a declarative lens | covered? |
|---|---|---|---|
| `cheers-checklist` | `/^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/` per line; toggles the state char; rejoins lines so non-task lines survive byte-for-byte | `widget: list`, fields `{done: bool, title: text}` | **yes** |
| `cheers-kanban-md` | `##` starts a section, `- [ ]` lines inside are cards; text before the first heading is preserved as `pre`; moving a card removes and reinserts its line | `widget: list, group: status` | **yes** |
| `cheers-frontmatter` | requires a leading `---\n` and a closing `---`; `/^([A-Za-z0-9_-]+):[ \t]?(.*)$/` per line; unparseable lines shown read-only and preserved; body after the fence untouched | `widget: form` over the document root | **yes** — and better: frontmatter *is* YAML, so the ad-hoc KV regex disappears |
| `cheers-table` | `JSON.parse`, must be an array of plain objects; columns = union of row keys; saves `JSON.stringify(rows, null, 2)` | `widget: table` | **yes**, except its whole-file re-serialize is replaced by a comment-preserving patch |

`builtin:table`'s config (`columns: {key, label, options?}[]`) maps onto `fields`
one-for-one — `options` is the `enum` type. `builtin:kanban`'s private
`{columns:[{name,items[]}]}` shape becomes `list` + `group`, and that bespoke shape can go
on a deprecation path (it is already `pickable: false`).

**All four are covered. The model holds.**

### 4.1 What is NOT covered — found by doing this

- **Arbitrary custom UI.** `codemap.plugin.html` (60 KB, pan/zoom node graph, inline YAML
  subset parser) is not expressible and never will be. This is why §7 exists.
- **Author-defined text conventions.** Under this spec a user cannot invent a *new* plain
  text convention and have it parsed. YAML-first is what makes that acceptable: there is
  nothing to invent, because the structure is already explicit.
- **Line-level preservation semantics differ.** The markdown plugins preserve *unrecognised
  lines*; a YAML patch preserves *comments and untouched nodes*. Equivalent in spirit,
  not identical in behaviour. Migrating an existing markdown board changes what survives
  an edit — this needs a migration note, not a silent switch.

## 5. Fallback: the editor, not "Raw"

A file no lens claims opens in a **lightweight editor**. The web already ships one and it
is **already shared**: [CodeEditor.tsx](../../frontend/src/features/chat/workbench/CodeEditor.tsx)
(CodeMirror 6 — line numbers, undo, bracket matching, per-language highlighting) is
lazy-loaded by both the workbench File panel and the remote-workspace browser. There is no
second editor to consolidate; keep using this one.

One follow-up it does need: it eagerly loads **only the markdown and json** language packs
(everything else resolves asynchronously via `@codemirror/language-data`). Under this spec
YAML becomes the primary board format, so YAML belongs in the eager set.

Native clients use their platform text view, without syntax highlighting — acceptable for a
fallback.

This matters more than it looks: it restores the human half of the loop for the entire
long tail immediately, without waiting for lens coverage. It also means **the write path
must be built before any lens** — the editor needs it, and so does every widget.

## 6. Write-back: the gateway owns the patch

**Settled — see [WORKBENCH_WRITEBACK.md](WORKBENCH_WRITEBACK.md).**

Widgets emit a **structured edit** ("set `tasks[3].done` to true"), never a whole document.
A new `fs.patch` verb carries generic document ops (`set` / `insert` / `remove` / `move`)
plus `if_version`; the gateway applies them to the YAML CST and preserves comments. One
implementation instead of one per client — the deciding factor was consistency, since a
divergence here does not error, it silently mangles a user's file.

`fs.write` is unchanged and still serves the editor fallback (§5) and every sandboxed HTML
plugin. Both paths share the same optimistic lock.

**Prerequisite:** the Rust comment-preserving YAML editor is unproven and must be spiked
against `yamlDoc.ts`'s fixtures before any client work starts on `fs.patch`.

## 7. Non-goal: this does not replace HTML plugins

Two tiers, deliberately:

- **Declarative lens** — the default path for defining boards. Data. Renders natively on
  every client, web and mobile alike.
- **Sandboxed HTML plugin** — the escape hatch for genuinely custom UI. Code. Web and
  desktop only; native clients degrade to the editor (§5) and say why.

[PLUGIN_DEVELOPMENT.md](../developer/PLUGIN_DEVELOPMENT.md) remains the contract for the
second tier, unchanged.

## 8. Open questions

1. ~~§6 — client-side or gateway-side patching.~~ **Settled 2026-07-19: gateway-side, see
   [WORKBENCH_WRITEBACK.md](WORKBENCH_WRITEBACK.md).** What remains is a *spike*, not a
   decision: prove a Rust comment-preserving YAML editor can reproduce `yamlDoc.ts`'s four
   documented behaviours.
2. Do `list` and `kanban` really share one widget, or does kanban eventually need
   swimlanes / WIP limits that make a split cheaper?
3. Migration: existing markdown boards (checklist / kanban-md / frontmatter) — convert to
   YAML, or keep the three convention parsers as a compatibility layer?
4. Where does a lens definition live — `.workbench.json` only, or may a template ship one?
5. Does an unbound YAML file get a *suggested* lens by shape (a sequence of mappings → a
   table), or is binding always explicit? Today's `accepts()`/specificity ranking suggests
   the former is expected.
