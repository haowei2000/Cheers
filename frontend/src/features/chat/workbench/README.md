# Building a Workbench Template

> **Status (2026-07-07)**: the workbench is **file-centric** — no tabs. The drawer body
> is one file browser; a selected file has three controls: **Pin** (inject into every
> bot prompt), **Preview** (render with the bound / best-matching renderer, switchable
> when several match), **Raw** (plain textarea, the fallback). A template is a
> **declarative manifest JSON** — pure data, no code. The old compiled-in
> `PanelDef`/`panelRegistry` path is deleted.

A **workbench template** (an *Environment*) turns a channel into a scenario — e.g. a
research channel where `papers.json` previews as a table and `metrics.json` as a chart.

The whole point: **a template is just data over files.** Boards are plain files in the
channel workspace (`context_files`); rendering is decided by per-file **bindings**, not
by the files. Because the bot reaches the same files via its `desk_*` tools, your
boards are automatically **shared human↔bot state**.

---

## The manifest

```jsonc
{
  "id": "research-lab",          // unique; stored in .workbench.json `environment`
  "title": "Research Lab",       // shown in the scenario picker
  "pin": ["prompts/conventions.md"],  // optional: auto-pinned on activation (bodies
                                      // injected into EVERY bot prompt — keep small!)
  "views": [                     // per file: which lens renders it (+ lens config)
    { "id": "papers", "title": "Literature", "file": "research/papers.json",
      "lens": "table", "config": { "columns": [ { "key": "title", "label": "Title" } ] } }
  ],
  "seed": {                      // path -> initial value (object => JSON, string => text)
    "research/papers.json": [],
    "prompts/conventions.md": "You are…"
  }
}
```

- **Lenses (built-in renderers)**: `table` (array of row objects; columns from
  `config`), `kanban` (`{columns:[{name,items:[]}]}`), `markdown` (a string),
  `chart` (`{xLabel?, yLabel?, series:[{name, points:[[x,y],…]}]}`, view-only).
  Unknown lens ids fail validation — data can never smuggle in code.
- **On activation** the workbench seeds the files (create-only), writes
  `bindings[file] = "builtin:<lens>"` + `configs[file] = config` into
  `.workbench.json` (create-only — a user's explicit binding is never overwritten),
  merges `pin` into `pinned`, and focuses the first view's file.
- `views[].title` is documentation today (the browser shows file names).

### Installing

- **Global**: an admin uploads the `.json` in *Settings → Workbench extensions*
  (`workbench_templates` table, visible to every channel).
- **Temporary**: anyone clicks "Temp template" in the drawer (or drops the file on
  it) — this browser session only.
- Reference examples: [`examples/research-lab.json`](./examples/research-lab.json),
  `examples/research.json`, `examples/lit-review.json`.

Code renderers (sandboxed iframe plugins) are the separate, heavier kind — shipped as
`.html` via `/workbench/plugins`; see
[docs/arch/WORKBENCH.md](../../../../../docs/arch/WORKBENCH.md) and
[docs/arch/RENDERER_PLUGIN.md](../../../../../docs/arch/RENDERER_PLUGIN.md).

---

## Rules & constraints (please read)

1. **Files only.** Store your data as files under your template's namespace
   (`<your-id>/...`) in the channel workspace. No new tables, no backend, no separate
   "memory"/"context" store — it's all `context_files`.
2. **Namespace your paths.** Prefix files with your template id so templates don't collide.
3. **Size limits.** ≤ **256 KB per file** (`CONTENT_TOO_LARGE`) and ≤ **1024 files per
   channel** (`CHANNEL_QUOTA_EXCEEDED`). Keep board state small.
4. **Optimistic lock.** Writes carry a `version`; a stale write fails with
   `VERSION_CONFLICT` (the lens hosts handle re-read + reapply).
5. **Untrusted content renders safely.** A file may have been written by a bot or
   another member. Built-in lenses render via text nodes / `<input>` / `<textarea>` —
   never `dangerouslySetInnerHTML`.
6. **Destructive ops are gated.** On the user path, `fs.rm` / `fs.mv` require
   owner/admin.
7. **Pull, not push.** The agent is **not** fed your files automatically; it reads them
   on demand via `desk_*`. The one exception is `pin`: pinned file **bodies** ride every
   prompt (and count toward the connector's `max_prompt_bytes`) — pin only small
   convention files.
8. **Idempotent seed.** Seeding is create-only (`ifVersion = 0`); re-activating fills
   only the missing files and never clobbers data.

---

## How the bot shares your boards (for free)

Your files live at `<your-id>/*.json` in `context_files`. The bot reaches the **same
paths** through its `desk_read` / `desk_write` / `desk_edit` MCP tools:

> `@bot read research/papers.json and mark "Attention Is All You Need" as Read`

The bot edits the same JSON; the preview live-refreshes on the Desk push signal (clean
buffers only — in-progress human edits are never clobbered). **Same store, both
directions — no glue needed.**

---

## Testing your template

- **In the UI:** `cd frontend && npm run dev` → open a channel → Workbench → "Temp
  template" → pick your `.json` → files seed, the first view's file opens in Preview.
- **Headless:** drive the resource bridge over the browser WS (auth → `resource_req`
  for `fs.write`/`fs.read` → assert `resource_res`); see `.claude/skills/run-e2e`.

---

> Honest scope: this is a **frontend** convention (declarative data over files). There
> is intentionally no backend plugin system for templates and no marketplace. The
> backend stays just `fs.*` verbs gated by channel-role.
