# Workbench Extensions

Workbench has one extension system. Scenes, panels, seed files, declarative Automation
templates, and optional macOS personal renderers ship in `.cheers-extension` ZIP packages.

## Package contract

`manifest.json` uses `schemaVersion: 1`. Extension, scene, panel, renderer, and Automation
IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`; versions are SemVer. Scene definitions contain
`items`, `seed`, and `pin`.

A **panel** contribution is a declarative board: `{ id, title, source, view }`, at most 32
per package. `source` is `{ kind: "resource", verb }` or `{ kind: "fs", path }` and nothing
else — `workspace` names paths on a bot's own machine under an authorization model
channel-role does not cover, and `rest` is an arbitrary endpoint rather than a vocabulary,
so both stay first-party. A resource `verb` must come from the same allowlist as
`channel.resources`: declaring a source never widens what a package can read. `view` follows
the renderer reference rules below.

A panel is pure data — the host performs the read and renders it into a compiled built-in
view, so the package never receives the bytes as code. That is why panels need no permission
and install at global scope. The install dialog still lists the verbs a package's panels
will display, because putting a channel's activity on screen is worth seeing before you
agree to it. Panels are read-only regardless of the view: writability belongs to the source,
and a projection carries no version to write back against.

Official templates may declare `panels` too, in
`server/assets/workbench-templates/*.template.json`. The catalog validates them against the
SAME vocabulary the package installers enforce — it is a second way to declare a panel, not
a second grammar — and rejects a `self:` view, since a release-managed extension carries no
renderer bundle. Malformed catalog data panics at build time rather than failing a request.

A resource source may name `pick`: the key to unwrap before the data reaches the view, since
every `channel.*` verb wraps its payload (`{"members": [...], "total": N}`) while the array
views want the bare list. A key that is absent yields an empty view rather than an error. Only
a resource source may pick — an `fs` source hands back file content, not a wrapper. A panel may
also carry `config`, passed to the view untouched, the same data-only field a scene item has.
`cheers-team-ops` ships a Roster board built this way; copy it.

Renderer references are `auto`, `builtin:<id>`, or `self:<id>`; `self:` is valid only for
personal macOS packages. A panel with a `self:` view validates at personal scope on both
installers, but the host does not yet mount a sandboxed renderer for a panel — only for a
file. Until it does, ship panels with `builtin:` views.

Renderer capabilities are denied unless declared in `permissions`: `file.write`,
allowlisted `channel.resources`, `navigation.open`, `composer.prefill`,
`automation.manage`, and `network: "unrestricted"`. Official extensions may contribute
Automation templates but cannot request code capabilities.

Packages are limited to 4 MiB compressed, 8 MiB expanded, 128 files, and 256 KiB per seed file. Parsers reject traversal, absolute paths, backslashes, symlinks, duplicate paths, encrypted entries, and unknown executable files.

## Scope

- `Official`: release-managed catalog contributions shared by all clients.
- `This Mac`: personal packages that may contain renderer code.
- `Temporary`: in-memory packages; code is accepted only in the macOS app.

Stable scene IDs are `extension:<extension-id>:<scene-id>` and `personal:<extension-id>:<scene-id>`. Personal renderer IDs are `personal:<extension-id>:<renderer-id>`.

`.workbench.json` stores shared scene state and built-in renderer bindings. Personal renderer bindings stay in device-local settings. Uninstalling an extension leaves seeded channel files intact.

The settings list presents Official, This Mac, and Temporary extensions together. The
Gateway has no administrator upload or uninstall path for Workbench packages: official
content is compiled into the first-party catalog and changes only with a Gateway release.
Personal extensions can be disabled locally. Renderer state is reported as Ready, Running,
or Failed; a failed or missing renderer is excluded from the current file's candidates so
the host selects the next built-in match or displays inert Raw content.

Automation contributions are inert templates. Users instantiate them as durable
scheduled channel messages and choose the channel, optional bot, and cadence explicitly.
Personal renderers with `automation.manage` may manage only their extension-owned tasks,
and every mutating request requires a host confirmation.
See [Scheduled Messages](SCHEDULED_MESSAGES.md).

## API

- `GET /api/v1/workbench/extensions`
- `GET /api/v1/workbench/extensions/:id/scenes/:sceneId`

Uploads use `application/vnd.cheers.extension+zip`. The old `/workbench/plugins` and `/workbench/templates` routes are removed; their database tables remain historical and are not read or written.
