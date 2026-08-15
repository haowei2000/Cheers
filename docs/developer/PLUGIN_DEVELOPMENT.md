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

Global extensions are declarative and may contain scenes and seed files only. Browser and iOS clients never execute extension code. A personal extension installed on macOS may contain renderers; the package is stored in `~/.cheers/extensions` and runs only after a renderer is selected.

Renderer source exports no HTML document. Call `defineRenderer({ activate(ctx) { ... } })`; `activate` may return a disposer. The packer bundles TypeScript and ordinary dependencies into a single IIFE. Runtime imports between extensions are unsupported.

See [WORKBENCH.md](../arch/WORKBENCH.md) and [RENDERER_PLUGIN.md](../arch/RENDERER_PLUGIN.md) for the package and sandbox contracts.
