# React + Vite plugin template

A workbench renderer plugin written in React + TypeScript, bundled into **one
self-contained `.html`** — the only shape the host accepts.

The vanilla examples next door (`md-checklist.plugin.html` and friends) are hand-written
single files: perfect for a 100-line renderer, painful past that. This template is the
answer for anything bigger — components, TypeScript, a real build — without giving up the
single-file contract.

## Use it

```bash
cp -r docs/arch/examples/react-vite-template my-plugin && cd my-plugin
npm install
npm run build          # -> dist/index.html : your whole plugin, one file
```

Then load `dist/index.html` in the workbench:

- **Fastest loop** — Workbench drawer → **Watch file** → pick `dist/index.html`. Run
  `npm run dev` (`vite build --watch`) in another terminal and every save rebuilds and
  reloads the plugin in place. No re-dropping.
- **One-shot** — drag `dist/index.html` onto the drawer (session-only, ⏱).
- **Ship it** — Settings → Workbench extensions (admin).

Verified: `npm run build` emits a single 199 KB `dist/index.html` (React included), well
under the server's 2 MiB bundle cap.

## What's in it

| File | Why it matters |
|---|---|
| `index.html` | Holds the **embedded manifest** (`#cheers-plugin`). Vite copies this non-module script tag through untouched, so the built file keeps it. **Edit your manifest here.** |
| `vite.config.ts` | `vite-plugin-singlefile` inlines every JS chunk and stylesheet. The extra `assetsInlineLimit` / `cssCodeSplit` / `inlineDynamicImports` settings stop a stray import from silently splitting a second file out — which the host could never load. |
| `src/cheers.ts` | Typed client for the protocol — the TypeScript twin of `../cheers-plugin-sdk.js`. Also forwards uncaught errors as `cheers:log`. |
| `src/main.tsx` | A working checklist renderer: parse → draw → edit → save, with a runtime `unsupported` verdict. |
| `src/styles.css` | The iframe is its own document and inherits nothing from the host — plugins style themselves from scratch. |

## Rules the template already follows

- **Redraw fully on every `cheers:render`.** It arrives exactly twice: in reply to
  `cheers:ready`, and after a conflicted save. An edit by a bot or another member does
  **not** re-render you, and there is no way to re-read your file.
- **One save in flight.** `cheers:saved` carries no request id, so `save()` rejects if you
  call it again before the previous one settles.
- **Never build markup from file content.** React escapes by default — keep it that way;
  no `dangerouslySetInnerHTML`.
- **Rewrite only the lines you own.** `serialize()` in `main.tsx` preserves every
  non-task line byte-for-byte, so the file stays hand-editable by humans and bots.

## Gotchas

- **Change the manifest `id`** before you install — `react-template` is a placeholder, and
  the id is the install primary key.
- **Don't add a `<base>` tag or absolute asset URLs.** The sandbox has an opaque origin
  and no network path back to the app; anything not inlined simply fails to load.
- **React StrictMode double-invokes effects in dev builds.** `connect()` is called once
  inside `useEffect` here; if you move it, make sure you don't wire two listeners and post
  `cheers:ready` twice.

See [PLUGIN_DEVELOPMENT.md](../../../developer/PLUGIN_DEVELOPMENT.md) for the full
contract.
