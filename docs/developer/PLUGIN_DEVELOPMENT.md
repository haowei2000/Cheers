# Workbench Plugin Development Guide

> **Language**: English (**normative**) | [中文(设计原文)](../arch/RENDERER_PLUGIN.md)
>
> This document is the authoritative reference for the workbench renderer-plugin
> contract. The Chinese design original explains *why* the model looks like this;
> when the two disagree, this document wins.
>
> Status: **v1 implemented.** Open a file in the Workbench **Files panel**, then pick a
> built-in lens or a plugin renderer from the "Renderer" dropdown. Bindings
> (`path → renderer id`) persist in `.workbench.json`. Ready-to-upload examples live in
> [`docs/arch/examples/`](../arch/examples/README.md).

## 1. Quickstart: the zero-admin dev loop

You do **not** need admin access (or an install step) to develop a plugin:

1. Copy the skeleton from §6 (or an example from
   [`docs/arch/examples/`](../arch/examples/README.md)) into `my-plugin.html`.
2. Open any channel → Workbench drawer → **drag the `.html` onto the drawer**
   (or use the **Load extension** button and pick the file).
3. The plugin loads for **this browser session only** — it is parsed, validated, and
   its renderers immediately join the candidate list of every matching file, marked
   with **⏱** in the renderer dropdown.
4. Select a file the plugin claims (its `match`, §4) → **Preview** → pick your
   renderer → interact → edits save back to the file.
5. Iterate: edit `my-plugin.html`, drop it again. A session plugin **shadows an
   installed plugin with the same id** for your session, so you can iterate on a
   deployed plugin without touching the installation. Reload the page and the
   session plugin is gone (existing bindings fall back to the installed version).

When it works, install it for everyone: *Settings → Workbench extensions* (admin, §8).

## 2. Concepts: renderers are CSS for files

- A **file** is pure content (Markdown is the primary format). It never declares which
  renderer to use.
- A **renderer plugin** carries all the judgment — *what it accepts, how it parses, how
  it draws* — turning a file into an interactive UI and writing edits back to that file.
- An **environment template** only seeds initial files; it never references a renderer.
- A **binding** (`path → renderer id`, stored in `.workbench.json`, never in the file)
  records the user's explicit renderer choice; without one, the best content match leads.

A renderer can be narrow ("markdown checklists with `- [ ]` lines") or broad. Small,
focused renderers coexist — like CSS rules that each match a specific selector.

## 3. A plugin is one sandboxed HTML file

A plugin is a **single `.html` file** containing:

1. an **embedded manifest** (`<script type="application/json" id="cheers-plugin">`) —
   parsed with `DOMParser` on upload, never executed;
2. your rendering logic — vanilla JS or bundled framework code, all inlined;
3. `postMessage` calls to talk to the host (§5).

It runs in an `<iframe sandbox="allow-scripts">` with an **opaque (null) origin**: it
cannot read the host's token, cookies, or localStorage, and it can only reach the one
file the host assigns to it. Bundles are capped at **2 MiB**.

## 4. Manifest

```json
{
  "id": "md-checklist",
  "protocol": 1,
  "title": "Markdown checklist",
  "renderers": [
    { "id": "checklist", "title": "Checklist", "match": { "format": "markdown" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Globally unique plugin id: `^[a-z0-9][a-z0-9._-]{0,63}$` (primary key on install; must equal the manifest's `id`) |
| `protocol` | Protocol version. **Absent = 1** (the documented default — every plugin installed before the field existed is a protocol-1 plugin). Hosts skip plugins declaring a protocol they don't implement; the server rejects them at install. This document specifies **protocol 1**. |
| `title` | Human-readable name (≤255 bytes) |
| `renderers[]` | Renderers this plugin provides (non-empty; ids unique within the plugin) |
| `renderers[].id` | Unique within the plugin (≤64 bytes) |
| `renderers[].title` | Shown in the renderer dropdown |
| `renderers[].match.format` | Coarse format(s) by extension — a string **or a list**: `markdown` / `json` / `toml` / `xml` / `text` (`text` is the catch-all, matching any path) |
| `renderers[].match.glob` | Optional path narrowing, e.g. `"reviews/*.md"` |
| `renderers[].match.requireAll` | Content must contain **all** of these substrings |
| `renderers[].match.requireAny` | Content must contain **at least one** of these |
| `renderers[].match.dataHas` | Parsed **structured** content (JSON today; YAML when supported) must have **all** these top-level keys |
| `renderers[].match.dataKind` | Top-level shape of parsed structured content: `"object"` or `"array"` — the only way to claim "a JSON array" (arrays have no keys for `dataHas`) |
| `renderers[].match.jsonHas` | **Deprecated** alias of `dataHas` with frozen **JSON-only** semantics (will never match YAML). Valid forever under protocol 1; new manifests should use `dataHas`. |

Hosts **ignore unknown manifest keys** (and unknown `match` keys), so the vocabulary
can grow within protocol 1 without breaking older hosts.

`match` declares *what you accept*. The host evaluates it cheaply (substrings / JSON
keys — your sandbox is not started) to decide whether you appear among a file's
renderer candidates. Acceptance has **two layers**, both owned by the renderer:

1. **Declarative `match`** — cheap host-side pre-filter.
2. **Runtime final verdict** — when `cheers:render` arrives you actually parse; if the
   structure doesn't fit, reply `cheers:unsupported {reason}` and the host shows
   "this renderer cannot render this file".

> The retired `panels` manifest shape (scenario plugins) is **rejected on upload**.
> A plugin only provides renderers.

## 5. Protocol reference (protocol 1)

### 5.1 Messages

All messages are plain objects posted between the plugin window and its parent
(`parent.postMessage(msg, "*")` — the sandbox's null origin means you cannot target
a specific origin; the host, in turn, only accepts messages from your iframe).

> **Future direction (non-goal today):** a later protocol 2 may wrap these messages in
> a JSON-RPC 2.0 envelope (`type` → `method`, `reqId` → `id`, payload → `params`) to
> align with MCP Apps-style iframe UIs. The mapping is mechanical; nothing else about
> the capability model would change. Do not build against it — protocol 1 is the
> contract, and `protocol: 1` manifests will keep working.

| Direction | `type` | Payload | When |
|---|---|---|---|
| plugin → host | `cheers:ready` | — | iframe loaded; "assign me work". Send it **after** your message listener is wired. |
| host → plugin | `cheers:render` | `{ path, format, content, version, rendererId }` | Assigns **one** file. Sent in reply to your `cheers:ready`, and re-sent after a conflicted save — those are the only triggers (§5.2). `rendererId` says which of your manifest's renderers was picked. |
| plugin → host | `cheers:unsupported` | `{ reason? }` | Runtime verdict: you inspected `content` and can't render it. The host hides your iframe and shows the reason. |
| plugin → host | `cheers:save` | `{ content }` | Write the assigned file back (whole-content replace). At most **one** save in flight (§5.3). |
| host → plugin | `cheers:saved` | `{ ok, version, error? }` | Result of your save. On `ok`, adopt the new `version`. Carries **no correlation id** — it answers "the" pending save, which is why only one may be in flight. |
| plugin → host | `cheers:resource` | `{ reqId, resource, params }` | Read-only channel info (whitelist, §5.4). `reqId` is your correlation number. |
| host → plugin | `cheers:resource:result` | `{ reqId, ok, data\|error }` | Resource read result. |

### 5.2 Lifecycle

```
iframe boots ──▶ plugin: cheers:ready
host reads file ──▶ host: cheers:render {path, format, content, version, rendererId}
        │  parse fails → plugin: cheers:unsupported {reason}   (host shows notice)
        │  parse ok    → draw UI
user edits in your UI ──▶ plugin: cheers:save {content}
        ├─ host writes with ITS last-known version
        ├─ ok        → host: cheers:saved {ok:true, version}    (adopt version)
        └─ conflict  → host: cheers:saved {ok:false, error}
                       host: cheers:render {…fresh content/version}   (re-render)
```

Those are the **only** two `cheers:render` triggers: your `cheers:ready` and a
conflicted save. A file changed by someone else (bot / another member) does **not**
push a new render into an open iframe — you see the fresh content when the user
reopens the file (remount → `ready` → `render`), or via the re-render that follows
your own conflicted save. There is no way to re-read the assigned file yourself:
the §5.4 resource whitelist covers channel data only, not file content.

### 5.3 Rules

- **Single-file capability.** One `cheers:render` = one file. You can only render and
  save that `path`; you cannot touch other files or channels. The host pins the path —
  `cheers:save` carries no path at all.
- **Optimistic locking.** `save` carries no version; the host writes with the `version`
  it last sent you. On conflict you get `cheers:saved {ok:false}` **followed by a fresh
  `cheers:render`** — re-render from the new content and let the user reapply. Do not
  retry the save blindly.
- **One save in flight.** Hosts do **not** correlate saves: each `cheers:save` is
  answered by an independent `cheers:saved` with no request id, and completion order is
  not guaranteed. Plugins MUST wait for `cheers:saved` before sending the next
  `cheers:save` (the SDK enforces this — an overlapping `save()` rejects).
- **Safe rendering.** `content` is untrusted text (it may come from a bot or another
  member). Write it to the DOM with `textContent` or controlled form values — **never
  concatenate into `innerHTML`**.
- **Missing file.** A not-yet-existing path renders as `content: ""`, `version: 0`;
  your first save creates it.

### 5.4 Host API: read-only channel resources

Besides the assigned file, a renderer may read a conservative whitelist of **read-only**
resources for the *current channel* (the host pins `channel_id`; server-side
channel-role auth still applies): `channel.info`, `channel.members`,
`channel.messages`, `channel.activity.read`, `channel.messages.index`.

```js
var rid = 0, pending = {};
function res(resource, params) {
  return new Promise(function (resolve) {
    var id = ++rid; pending[id] = resolve;
    parent.postMessage({ type: "cheers:resource", reqId: id, resource: resource, params: params || {} }, "*");
  });
}
// in your message listener:
//   if (m.type === "cheers:resource:result") { var p = pending[m.reqId]; if (p) { delete pending[m.reqId]; p(m); } }
var info = await res("channel.info", {});   // → { ok, data } | { ok:false, error }
```

Note the sandbox isolates *tokens and DOM*, not *network*: a plugin that reads channel
data could `fetch` it out. That is why the whitelist is read-only and conservative, and
installed plugins are **admin-vouched** (§8).

## 6. Minimal skeleton

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <script type="application/json" id="cheers-plugin">
    { "id": "my-plugin", "title": "My plugin",
      "renderers": [{ "id": "main", "title": "My renderer", "match": { "format": "markdown" } }] }
  </script>
</head>
<body>
  <div id="root"></div>
  <script>
    var ASSIGN = null;
    window.addEventListener("message", function (e) {
      var m = e.data; if (!m || typeof m !== "object") return;
      if (m.type === "cheers:render") {
        ASSIGN = m;
        // 1. parse m.content — if it doesn't fit, bail out:
        //    parent.postMessage({ type: "cheers:unsupported", reason: "…" }, "*");
        // 2. draw UI (textContent only for untrusted text)
        // 3. on edit: parent.postMessage({ type: "cheers:save", content: newContent }, "*");
      } else if (m.type === "cheers:saved") {
        if (m.ok) ASSIGN.version = m.version;   // else: a fresh cheers:render follows
      }
    });
    parent.postMessage({ type: "cheers:ready" }, "*");  // AFTER the listener is wired
  </script>
</body>
</html>
```

### 6.1 Optional inline SDK

If you'd rather not hand-roll the listener/promise plumbing, copy
[`docs/arch/examples/cheers-plugin-sdk.js`](../arch/examples/cheers-plugin-sdk.js)
(~50 lines, protocol 1) **inline** into your `<script>` — plugins are self-contained
files, there is no external loading in the sandbox:

```js
var host = cheersPlugin({
  onRender: function (file) {
    // { path, format, content, version, rendererId } — sent on your ready and
    // re-sent after a conflicted save (the only triggers, §5.2): always re-draw here.
  },
});
host.save(next).then(function (r) { /* r.version */ }).catch(function (e) { /* show e */ });
host.resource("channel.info", {}).then(function (data) { /* … */ });
host.unsupported("no task lines found");
```

It wires the listener first and posts `cheers:ready` for you.

## 7. Cookbook

Complete working examples (upload as-is, or drop on the drawer to try):

- [`md-checklist.plugin.html`](../arch/examples/md-checklist.plugin.html) — markdown
  todo list → interactive checklist. The canonical *"markdown convention + narrow
  `match` + line-preserving rewrite"* recipe.
- [`lit-review.plugin.html`](../arch/examples/lit-review.plugin.html) — paper-tracker
  table over `{ "papers": [...] }` JSON (`match.dataHas` pre-filter + runtime array
  check + form-driven JSON writeback).
- [`code-review.plugin.html`](../arch/examples/code-review.plugin.html) — markdown
  review findings (`## file` sections, `- [ ] [P0|P1|P2]` items) with severity badges.
  The *"structured markdown sections"* recipe.

Matching environment templates: [`md-demo`](../arch/examples/md-demo.template.json),
[`lit-review`](../arch/examples/lit-review.template.json),
[`code-project`](../arch/examples/code-project.template.json).

Recipes in words:

- **Claim a markdown convention** — declare `format:"markdown"` plus `requireAny`
  /`requireAll` markers for your convention; split content into lines on render, edit
  lines in place, `join("\n")` on save so non-convention lines survive byte-for-byte.
- **Claim a JSON structure** — declare `dataHas` for your top-level keys (or
  `dataKind:"array"` for a top-level array); on render, `JSON.parse` in try/catch and
  verify shapes, `cheers:unsupported` when they don't hold; save with
  `JSON.stringify(data, null, 2)`.
- **Use channel context** — call the §5.4 resource helper, e.g. `channel.members` to
  resolve author ids to names in your UI. Data may be stale seconds later, and renders
  are rare (§5.2: on `ready` and after a conflicted save — never on external edits), so
  re-fetch via the resource helper when freshness matters rather than counting on a new
  `cheers:render` to refresh it for you.

## 8. Install & bind

- **Try/dev** (anyone): drop the `.html` on the Workbench drawer — session-only (§1).
- **Install** (admin): Settings → Workbench extensions → upload the `.html` (stored in
  the `workbench_plugins` table, visible to all channels). The installer vouches for
  the code — that is the trust model.

  The server validates the manifest on install (`PUT /workbench/plugins/:id`) and
  rejects with **400** naming the reason:

  | Rejection | Rule |
  |---|---|
  | id charset | plugin id must match `^[a-z0-9][a-z0-9._-]{0,63}$` |
  | id mismatch | `manifest.id` must equal the id in the URL |
  | missing title | `manifest.title` non-empty, ≤255 bytes |
  | unsupported protocol | `protocol` absent or `1` |
  | legacy manifest | a `panels` key = retired scenario-plugin protocol |
  | renderers | non-empty array; per renderer: non-empty `id` (≤64, unique) + `title`; `match` type-checked on known keys (unknown keys allowed) |
  | size (413) | bundle ≤ 2 MiB, manifest ≤ 64 KiB |

  Already-installed plugins are never revalidated (list/bundle paths are untouched);
  the rules bite on the next install/update.
- **Bind**: when a file is open, the Workbench resolves `bindings[path]` from
  `.workbench.json`; without a binding it offers the candidate list (most specific
  `match` first, CSS-style cascade) and defaults to the best match, falling back to
  raw text. The user's explicit choice always wins and persists ("Auto" clears it).
  Bindings never live in the file itself — files stay pure content.

## 9. Security model (three layers)

1. **Opaque origin** — `sandbox="allow-scripts"` without `allow-same-origin`: the
   plugin cannot steal host credentials.
2. **Single-file capability** — the host proxy pins the plugin to the one assigned
   `path`; server-side channel-role auth is unchanged.
3. **Inert manifest** — parsed with `DOMParser`, never executed.

## 10. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| **My renderer never appears in the dropdown** | Its `match` doesn't accept the file. Check in order: ① `match.format` vs the file's extension class (`.md`→markdown, `.json`→json, `.toml`→toml, `.xml`→xml, anything else→text); ② every `requireAll` substring is really in the content (exact match, case-sensitive); ③ at least one `requireAny` hit; ④ `jsonHas`: file must parse as a JSON **object** (not array) containing all listed keys; ⑤ `glob` matches the full path. |
| **The plugin loads but the iframe stays blank** | You never sent `cheers:ready`, or sent it before wiring your `message` listener (the host's `cheers:render` answer raced past you). Send `ready` as the **last** line of your script. |
| **"This renderer can't render this file"** | Your own runtime verdict — you replied `cheers:unsupported`. If unexpected, your parse is stricter than your `match`; align them. |
| **Saves fail repeatedly / edits bounce back** | Version conflict: someone (often the bot) wrote the file between your render and your save. Contract: on `cheers:saved {ok:false}` the host re-sends `cheers:render` with fresh content — re-render and let the user reapply. If you cached `version` yourself and reused it, stop: the host tracks the version, you never send one. |
| **Upload rejected: invalid manifest** | The embedded `#cheers-plugin` JSON failed validation — the error message names the field. Common: missing `renderers` (a legacy `panels` manifest), duplicate renderer ids, `match` not an object. |
| **Works when dropped, gone after reload** | That's the design: dropped plugins are session-only. Install via Settings → Workbench extensions to persist. |

## Related

- Chinese design original: [docs/arch/RENDERER_PLUGIN.md](../arch/RENDERER_PLUGIN.md)
- Workbench architecture: [docs/arch/WORKBENCH.md](../arch/WORKBENCH.md)
- Environment templates (data, not code): [frontend workbench README](../../frontend/src/features/chat/workbench/README.md)
- Examples index: [docs/arch/examples/README.md](../arch/examples/README.md)
