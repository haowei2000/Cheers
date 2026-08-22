# Workbench Extension Development

The legacy HTML plugin and JSON template formats have been removed. Workbench accepts one package format: `.cheers-extension`.

Use `packages/cheers-workbench-sdk` to author a renderer and run:

```bash
cheers-workbench pack path/to/extension
```

An extension is a ZIP with this canonical layout:

```text
manifest.json
scenes/<scene-id>.json
seed/<scene-id>/<workspace-path>
renderers/<renderer-id>.js
renderers/<renderer-id>.css
```

Official extensions are declarative and released with the Gateway; they may contain scenes,
seed files, and inert Automation templates. Administrators cannot upload server-side
Workbench packages. Browser and iOS clients never execute extension code. A personal
extension installed on macOS may contain renderers; the package is stored in
`~/.cheers/extensions` and runs only after a renderer is selected.

Renderer source exports no HTML document. Every renderer must implement
`toContext(target)`, returning a human label and an exact, contiguous `sourceText`
fragment from the assigned file. Row, card, and node context-menu handlers call
`ctx.context.pick(event, target)`; the host rejects missing or ambiguous anchors and
converts a valid anchor into a line-scoped `fs.read` context reference. Call
`defineRenderer({ toContext, activate })`; `activate` may return a disposer. The packer
bundles TypeScript and ordinary dependencies into a single IIFE. Runtime imports between
extensions are unsupported.

Request `automation.manage` only when the renderer needs `ctx.automation`. The host scopes
all returned tasks to the calling extension and confirms every create, update, delete,
or run operation.

See [WORKBENCH.md](../arch/WORKBENCH.md) and [RENDERER_PLUGIN.md](../arch/RENDERER_PLUGIN.md) for the package and sandbox contracts.
