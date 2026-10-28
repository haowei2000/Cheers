# Code-authored canvas and inspector

> Status: code-authored card selection and position editing implemented for Desk `.tsx`, `.jsx`, and `.html` previews. The YAML graph canvas remains available.

## Core contract

A card is ordinary TSX or HTML. Authors give any card that needs a persistent reference a unique `data-cheers-id`:

```tsx
export default function Dashboard() {
  return <main data-cheers-canvas>
    <section
      data-cheers-id="revenue-card" data-cheers-position="40,60"
      data-cheers-source-uri="cheers:ws/@api/server/src/api/revenue.rs#L42"
    >Revenue</section>
  </main>;
}
```

The card's address is `cheers:desk/cards/dashboard.tsx#^revenue-card`. The file remains the source of truth. The Inspector resolves the id against the current source, so moving the card to another line does not break its URI or its annotation. Duplicate ids fail closed; they must be corrected in code before the card can receive a stable address.

The React preview compiles JSX with a small Babel AST visitor that adds `data-cheers-source` to DOM elements. This follows the same source-location injection idea as [Code Inspector](https://github.com/zh-lx/code-inspector/blob/main/packages/core/src/server/transform/transform-jsx.ts). Compilation runs in a bounded Web Worker in the trusted Workbench; the resulting code executes only in the preview frame. Selecting a preview element can add its source line to context or open the shared Raw editor at that line. A stable `data-cheers-id` takes precedence over a line number. HTML cards can use the stable id; automatic source-line injection is currently limited to JSX.

`data-cheers-canvas` makes a positioned container. A card with adjacent literal `data-cheers-id` and `data-cheers-position="x,y"` can be dragged in Design Mode. The host changes just the two coordinate values in the same TSX/HTML file, through its existing file session and save path. Duplicate ids, computed positions, and nonliteral coordinates cannot be dragged; edit those in Raw. This keeps position write-back explicit and avoids rewriting unrelated JSX.

For a gateway-free manual check, run `cd frontend && pnpm dev`, then open `/dev/code-canvas.html`. Dragging the Revenue card changes `data-cheers-position` in the source pane beside it.

The annotation store remains `annotations.yaml` as a file of notes, but a code-authored card's anchor is now its URI. The canvas content and card structure do not have to be YAML. Existing YAML canvas files and lenses continue to load during migration.

Opening a `#^id` Desk URI resolves the id against the current file and opens Raw at its current line. Selection in the preview offers the same source jump directly.

When a card represents backend behavior, `data-cheers-source-uri` declares that connection in the component itself. The Inspector exposes **Open related code** for a valid Desk or workspace URI. Code Inspector cannot infer a backend handler from JSX alone; the explicit URI is the durable link between the two files.

## Preview trust boundary

The preview uses an opaque-origin iframe with only `allow-scripts`. Its content security policy starts with `default-src 'none'`, blocks `fetch`/WebSocket, external scripts, nested frames, workers, form navigation, and `eval`, and permits inline scripts/styles and data/blob media needed for local rendering. React, ReactDOM, and the current application CSS are bundled from local dependencies into the frame document; the preview has no CDN dependency. Authored code cannot access the parent DOM or Workbench APIs directly. The host accepts only a small `postMessage` bridge for inspection, code-canvas moves, and action submissions, and validates the source frame and bounded arguments before acting. TSX compilation runs in a separate worker with an 8-second timeout and a 200 KB source limit.

This is a browser preview boundary, **not a fully trusted container for arbitrary hostile code**. Browser CSP support differs, especially for navigation restrictions; authored code can still consume significant CPU or memory in its frame, and a navigation may send data placed in the preview to an external URL. Do not put secrets or privileged host state into the frame. For stronger guarantees, run previews in a separately hosted origin and an OS/container sandbox with a network-deny policy, resource limits, and a controlled rendering channel. The Workbench should keep the same URI and bridge contract when that execution backend is added.

## Next migration steps

1. Add code-authored connections and resize handles after defining a source edit contract for them.
2. Move canvas operations that still require YAML node records to code-authored component state or explicit editable props.
3. Keep the iframe boundary and channel file authorization; the upstream Code Inspector development server's local IDE opener does not belong in the shared runtime.
