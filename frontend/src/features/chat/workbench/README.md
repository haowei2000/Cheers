# Building a Workbench Template

> **Status note (2026-06-23)**: templates are now **declarative manifest JSON**
> (`{id,title,views:[{file,lens,config}],seed}`), rendered by the built-in lenses
> (`table`/`kanban`/`markdown`) — no need to hand-write `PanelDef`/`registerEnvironment`
> components anymore (the approach below is the older compiled-in path; it still works
> but is no longer preferred). There are three ways to install a template:
> ① **Global**: an admin uploads the `.json` in *Settings → Workbench extensions* (stored
> in the `workbench_templates` table, visible to every channel);
> ② **Temporary**: anyone clicks "Temp template" in the workbench drawer and uploads a
> `.json` (this browser session only — not stored, not shared);
> ③ **Built-in**: compile the manifest into the frontend. Code renderers (sandbox plugins)
> are a separate kind, shipped as `.html` via `/workbench/plugins` — see the "two plugin
> kinds" section in [docs/arch/WORKBENCH.md](../../../../../docs/arch/WORKBENCH.md).
>
> The guide below describes the earlier "one PanelDef component per panel" approach,
> kept for reference.

A **workbench template** (an *Environment*) turns a channel into a scenario — e.g. a
research channel with **Target journals / Progress board / Paper reviews** boards. This
guide is for third-party developers who want to ship their own template.

The whole point: **a template is just frontend code over files.** Your boards are
plain files in the channel workspace (`context_files`). There is **no backend, no new
table, no separate store** to write. And because the bot reaches the same files via
its `fs_*` tools, your boards are automatically **shared human↔bot state**.

---

## TL;DR — 4 steps

1. Create a folder `environments/<your-template>/`.
2. Write one or more **panel** components, each exporting a `PanelDef`.
3. Write `index.ts` that calls `registerEnvironment({ id, title, panels, seed })`.
4. Add one line to `environments/index.ts`: `import "./<your-template>";`

Done. Your template shows up in the Workbench scenario picker; selecting it
seeds your starter files and mounts your panels.

---

## Anatomy of a template folder

A template is **self-contained** — everything lives in its own folder:

```
environments/
  index.ts                ← barrel: one `import "./<name>"` per active template
  <your-template>/
    index.ts              ← registerEnvironment({ id, title, panels, seed })
    FooPanel.tsx          ← export const fooPanel: PanelDef
    BarPanel.tsx          ← (optional) more panels
```

`environments/research/` is the reference example — read it alongside this guide.

---

## The three contracts you implement

```ts
// 1) What every panel receives.
interface PanelContext {
  channelId: string;
  fs: FsClient;          // read/write the channel workspace (see below)
}

// 2) A panel = a tab in the workbench.
interface PanelDef {
  id: string;            // unique within the workbench (e.g. "journals")
  title: string;         // tab label
  render: (ctx: PanelContext) => ReactNode;
}

// 3) A template = a scenario: panels + a seed.
interface Environment {
  id: string;            // unique (e.g. "research"); stored in .workbench.json
  title: string;         // shown in the scenario picker
  panels: PanelDef[];    // which panels this scenario shows
  seed: (fs: FsClient) => Promise<void>;  // scaffold starter files on activation
}
```

You register a template with `registerEnvironment(env)` (from `environmentRegistry.ts`).

---

## Your data access: the `fs` client

`ctx.fs` is a typed client over the channel's file workspace. **All paths are relative
to the channel** (the channel id is bound in automatically).

```ts
fs.ls(path?)                      → { path, entries: FsEntry[] }   // list a subtree
fs.read(path)                     → { path, content, version }     // read one file
fs.write(path, content, ifVer?)   → { path, version }              // create/overwrite
fs.rm(path, recursive?)           → ...                            // delete
// FsEntry = { path, version, is_dir, size_bytes }
```

`content` is always a **string** — store structured data as JSON
(`JSON.stringify` / `JSON.parse`). `ifVersion` is the optimistic lock (see Rules).

### Recommended helper: `useJsonFile`

For a JSON-backed board, use the shared hook instead of wiring `read`/`write` by hand:

```ts
const { data, setData, save, status } = useJsonFile<MyShape>(fs, "my-template/data.json", FALLBACK);
//   data    – current value (loads on mount; FALLBACK until loaded / if missing)
//   setData – edit in memory
//   save(next) – write back; re-reads automatically on a version conflict
//   status  – last "Saved / conflict…" message to surface in the UI
```

---

## Worked example: a "Reading List" template

A minimal complete template — copy, rename, adapt.

`environments/reading/ReadingPanel.tsx`:

```tsx
import { Plus, Save, Trash2 } from "lucide-react";
import type { PanelContext, PanelDef } from "../../panelRegistry";
import { useJsonFile } from "../../jsonFile";

interface Item { title: string; done: boolean; }

function ReadingPanel({ fs }: PanelContext) {
  const { data, setData, save, status } = useJsonFile<Item[]>(fs, "reading/list.json", []);
  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
        <span className="text-zinc-300">Reading List</span>
        <div className="flex-1" />
        <button onClick={() => setData([...data, { title: "", done: false }])}>
          <Plus className="w-3.5 h-3.5 text-zinc-400" />
        </button>
        <button onClick={() => void save(data)}>
          <Save className="w-3.5 h-3.5 text-zinc-400" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {data.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={it.done}
              onChange={(e) => setData(data.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))}
            />
            {/* untrusted text → plain <input>, never dangerouslySetInnerHTML */}
            <input
              value={it.title}
              onChange={(e) => setData(data.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              placeholder="paper title"
              className="bg-transparent flex-1 text-zinc-200 outline-none"
            />
            <button onClick={() => setData(data.filter((_, j) => j !== i))}>
              <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
            </button>
          </div>
        ))}
      </div>
      {status && <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800">{status}</div>}
    </div>
  );
}

export const readingPanel: PanelDef = {
  id: "reading",
  title: "Reading List",
  render: (ctx) => <ReadingPanel {...ctx} />,
};
```

`environments/reading/index.ts`:

```ts
import { registerEnvironment } from "../../environmentRegistry";
import { ResourceError } from "../../../hooks/useChatRealtime";
import { readingPanel } from "./ReadingPanel";

registerEnvironment({
  id: "reading",
  title: "Reading",
  panels: [readingPanel],
  // create-only so re-seeding never clobbers existing data
  seed: async (fs) => {
    try {
      await fs.write("reading/list.json", JSON.stringify([], null, 2), 0);
    } catch (e) {
      if (!(e instanceof ResourceError && e.code === "VERSION_CONFLICT")) throw e;
    }
  },
});
```

`environments/index.ts` — add one line:

```ts
import "./reading";
```

That's it. Reload the dev server → Workbench → scenario picker → **Reading** → it seeds
`reading/list.json` and shows your panel.

---

## Rules & constraints (please read)

1. **Files only.** Store your data as files under your template's namespace
   (`<your-id>/...`) in the channel workspace. No new tables, no backend, no separate
   "memory"/"context" store — it's all `context_files`.
2. **Namespace your paths.** Prefix every file with your template id
   (`reading/list.json`, not `list.json`) so templates don't collide.
3. **Size limits.** ≤ **256 KB per file** (`CONTENT_TOO_LARGE`) and ≤ **1024 files per
   channel** (`CHANNEL_QUOTA_EXCEEDED`). Keep board state small; large blobs / binaries
   do not belong here.
4. **Optimistic lock.** Writes carry a `version`; a stale write fails with
   `VERSION_CONFLICT`. `useJsonFile` handles this (re-read + ask the user to reapply) —
   if you hand-roll `fs.write`, do the same.
5. **Render untrusted content safely.** A file may have been written by a **bot or
   another channel member**. Render via React text nodes / `<input>` / `<textarea>`.
   **Never `dangerouslySetInnerHTML`.** If you render markdown, disable raw HTML.
6. **Destructive ops are gated.** On the user (browser) path, `fs.rm` / `fs.mv` require
   **owner/admin** — a plain member gets `PERMISSION_DENIED`. Catch it and show a hint.
7. **Pull, not push.** The agent is **not** fed your files automatically; it reads them
   on demand via `fs_*`. Your template doesn't (and can't) push content into the model's
   context — that's a separate semantic/system-prompt concern.
8. **Idempotent seed.** Use create-only writes (`ifVersion = 0`) and swallow
   `VERSION_CONFLICT`, so selecting the scenario again fills only the missing files.

---

## How the bot shares your boards (for free)

Your files live at `<your-id>/*.json` in `context_files`. The bot reaches the **same
paths** through its `fs_read` / `fs_write` MCP tools. So this just works:

> `@bot read reading/list.json and mark "Attention Is All You Need" as done`

The bot edits the same JSON; your panel shows it on the next refresh. **Same store,
both directions — no glue needed.**

---

## API surface (where things live)

| You import | from | gives you |
|---|---|---|
| `PanelDef`, `PanelContext` | `../../panelRegistry` | the panel contract |
| `registerEnvironment`, `Environment` | `../../environmentRegistry` | register your template |
| `useJsonFile`, `errMsg` | `../../jsonFile` | JSON load/edit/save helper |
| `FsClient`, `FsEntry`, `FileContent` | `../../fsClient` | `fs` client types |
| `ResourceError` | `../../../hooks/useChatRealtime` | typed error (`.code`) |

Channel binding lives in a convention file `.workbench.json` =
`{ "environment": "<id>" }` — the workbench reads it on open; you don't touch it.

---

## Testing your template

- **In the UI:** `cd frontend && npm run dev` → open a channel → Workbench (⊟) →
  scenario picker → your template → boards seed and appear.
- **Headless:** drive the resource bridge over the browser WS (auth → `resource_req`
  for `fs.write`/`fs.read` → assert `resource_res`); see the e2e pattern in the repo.

---

> Honest scope: this is a **frontend** plugin convention (panels over files). There is
> intentionally no backend plugin system, no dynamic/remote loading, and no marketplace
> — templates are compiled in. The backend stays just `fs.*` verbs gated by channel-role.
