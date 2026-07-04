# Workbench Plugin Development Guide

> **Language**: English | [中文(设计原文)](../arch/RENDERER_PLUGIN.md)
>
> Status: **v1 implemented.** The host-side `render/save` protocol is live: open a file
> in the Workbench **Files panel**, then pick a built-in lens or an installed plugin
> from the "Renderer" dropdown. Bindings (`path → renderer id`) persist in
> `.workbench.json`. Ready-to-upload examples live in
> [`docs/arch/examples/`](../arch/examples/README.md).

## 1. Mental model: renderers are CSS for files

- A **file** is pure content (Markdown is the primary format). It never declares which
  renderer to use.
- A **renderer plugin** carries all the judgment — *what it accepts, how it parses, how
  it draws* — turning a file into an interactive UI and writing edits back to that file.
- An **environment template** only seeds initial files; it never references a renderer.

A renderer can be narrow ("markdown checklists with `- [ ]` lines") or broad. Small,
focused renderers coexist — like CSS rules that each match a specific selector.

## 2. A plugin is one sandboxed HTML file

A plugin is a **single `.html` file** containing:

1. an **embedded manifest** (`<script type="application/json" id="cheers-plugin">`) —
   parsed with `DOMParser` on upload, never executed;
2. your rendering logic — vanilla JS or bundled framework code, all inlined;
3. `postMessage` calls to talk to the host (§4).

It runs in an `<iframe sandbox="allow-scripts">` with an **opaque (null) origin**: it
cannot read the host's token, cookies, or localStorage, and it can only reach the one
file the host assigns to it.

## 3. Manifest

```json
{
  "id": "md-checklist",
  "title": "Markdown checklist",
  "renderers": [
    { "id": "checklist", "title": "Checklist", "match": { "format": "markdown" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Globally unique plugin id (primary key on install) |
| `title` | Human-readable name |
| `renderers[]` | Renderers this plugin provides (one or more) |
| `renderers[].id` | Unique within the plugin |
| `renderers[].match.format` | `markdown` / `json` / `toml` / `xml` / `text` (host classifies by extension) |
| `renderers[].match.glob` | Optional path narrowing, e.g. `"reviews/*.md"` |
| `renderers[].match.requireAll` | Content must contain **all** of these substrings |
| `renderers[].match.requireAny` | Content must contain **at least one** of these |
| `renderers[].match.jsonHas` | JSON only: parsed object must have **all** these top-level keys |

`match` declares *what you accept*. The host evaluates it cheaply (substrings / JSON
keys — your sandbox is not started) to decide whether you appear among a file's
renderer candidates. Acceptance has **two layers**, both owned by the renderer:

1. **Declarative `match`** — cheap host-side pre-filter.
2. **Runtime final verdict** — when `cheers:render` arrives you actually parse; if the
   structure doesn't fit, reply `cheers:unsupported {reason}` and the host shows
   "this renderer cannot render this file".

## 4. postMessage protocol

| Direction | `type` | Payload | When |
|---|---|---|---|
| plugin → host | `cheers:ready` | — | iframe loaded; "assign me work" |
| host → plugin | `cheers:render` | `{ path, format, content, version, rendererId }` | Assigns **one** file; re-sent when the file changes externally |
| plugin → host | `cheers:unsupported` | `{ reason? }` | Runtime verdict: can't render this content |
| plugin → host | `cheers:save` | `{ content }` | Write the assigned file back |
| host → plugin | `cheers:saved` | `{ ok, version, error? }` | Optimistic-lock result; on `ok`, update your `version` |
| plugin → host | `cheers:resource` | `{ reqId, resource, params }` | Read-only channel info (whitelisted; see below) |
| host → plugin | `cheers:resource:result` | `{ reqId, ok, data\|error }` | Resource read result |

Key rules:

- **Single-file capability.** One `cheers:render` = one file. You can only render and
  save that `path`; you cannot touch other files or channels.
- **Optimistic locking.** `save` carries no version; the host writes with the `version`
  it sent you. On conflict, `cheers:saved.ok=false` and the host re-sends a fresh
  `cheers:render` — just re-render.
- **Safe rendering.** `content` is untrusted text (it may come from a bot or another
  member). Write it to the DOM with `textContent` or controlled form values — **never
  concatenate into `innerHTML`**.

### Host API: read-only channel resources

Besides the assigned file, a renderer may read a conservative whitelist of **read-only**
resources for the *current channel* (the host pins `channel_id`; server-side
channel-role auth still applies): `channel.info`, `channel.members`,
`channel.messages`, `channel.activity.read` / `channel.messages.index`.

## 5. Minimal skeleton

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
        if (m.ok) ASSIGN.version = m.version;   // else: host re-renders with fresh content
      }
    });
    parent.postMessage({ type: "cheers:ready" }, "*");
  </script>
</body>
</html>
```

Complete working examples (upload as-is):

- [`md-checklist.plugin.html`](../arch/examples/md-checklist.plugin.html) — markdown
  todo list → interactive checklist (general).
- [`lit-review.plugin.html`](../arch/examples/lit-review.plugin.html) — paper-tracker
  table over `{ "papers": [...] }` JSON, with status + star rating (research).
- [`code-review.plugin.html`](../arch/examples/code-review.plugin.html) — markdown
  review findings (`## file` sections, `- [ ] [P0|P1|P2]` items) with severity badges
  (coding).

Matching environment templates: [`md-demo`](../arch/examples/md-demo.template.json),
[`lit-review`](../arch/examples/lit-review.template.json),
[`code-project`](../arch/examples/code-project.template.json).

## 6. Security model (three layers)

1. **Opaque origin** — `sandbox="allow-scripts"` without `allow-same-origin`: the
   plugin cannot steal host credentials.
2. **Single-file capability** — the host proxy pins the plugin to the one assigned
   `path`; server-side channel-role auth is unchanged.
3. **Inert manifest** — parsed with `DOMParser`, never executed.

Note the sandbox isolates *tokens and DOM*, not *network*: a plugin that reads channel
data could `fetch` it out. That is why the resource whitelist is read-only and
conservative, and plugins are **admin-installed** (the installer vouches for them).

## 7. Development checklist

- [ ] One `.html` with an embedded `#cheers-plugin` manifest (`id` / `title` / `renderers[]`).
- [ ] Each renderer declares `match.format` (coarse selector); precise judgment lives in code.
- [ ] Send `cheers:ready` last; parse `content` on `cheers:render`; edits go through
      `cheers:save`; update `version` on `cheers:saved`.
- [ ] Touch only the assigned file; assume no other paths.
- [ ] Untrusted content via `textContent` / controlled forms only — never `innerHTML`.
- [ ] Prefer Markdown as the primary format; supporting json/xml is your renderer's own
      business (declare the right `match.format`).

## 8. Install & bind

- **Install** (admin): Settings → Workbench extensions → upload the `.html` (stored in
  the `workbench_plugins` table, visible to all channels).
- **Bind**: when a file is open, the Workbench resolves `bindings[path]` from
  `.workbench.json`; without a binding it defaults to raw text and lets the user pick
  from the candidate list (most specific `match` first, CSS-style cascade). The user's
  explicit choice always wins and persists. Bindings never live in the file itself —
  files stay pure content.

## Related

- Chinese design original: [docs/arch/RENDERER_PLUGIN.md](../arch/RENDERER_PLUGIN.md)
- Workbench architecture: [docs/arch/WORKBENCH.md](../arch/WORKBENCH.md)
- Examples index: [docs/arch/examples/README.md](../arch/examples/README.md)
