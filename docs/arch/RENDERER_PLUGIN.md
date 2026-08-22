# Workbench Renderer Runtime

Third-party renderer code is a macOS personal-extension capability. Browser and iOS clients ignore renderer contributions.

The host creates the HTML document and mounts extension JavaScript in an opaque-origin iframe with `sandbox="allow-scripts"`. The extension cannot access host DOM, cookies, storage, auth tokens, Tauri APIs, arbitrary files, or another extension.

Default CSP denies network, frames, forms, objects, navigation, and external scripts. `permissions.network: "unrestricted"` opens HTTP(S), WebSocket, and remote media connections after an explicit install warning; external scripts and host DOM remain unavailable.

Host and renderer communicate with JSON-RPC 2.0 messages carrying request IDs. Methods are:

- `file.render` and `file.save`
- `channel.read`
- `navigation.open`
- `composer.prefill`
- `context.pick` and `context.added`; renderer `toContext(target)` supplies an exact
  source anchor, while the host validates uniqueness, calculates line numbers, and owns
  context insertion
- `automation.list`, `automation.create`, `automation.update`, `automation.delete`, and
  `automation.run` behind `automation.manage`; every mutating call requires host
  confirmation and is scoped to tasks owned by that extension
- `renderer.unsupported`
- `log`
- `lifecycle.dispose`

Every capability is checked against the package manifest. Installation validates and records bytes but never executes code. The host calls the disposer on close, switch, update, or uninstall. A renderer missing the mandatory `toContext(target)` conversion fails activation. A missing or failed renderer falls back to automatic built-in matching or Raw.
