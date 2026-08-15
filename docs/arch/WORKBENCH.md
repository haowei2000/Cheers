# Workbench Extensions

Workbench has one extension system. Scenes, seed files, declarative Automation templates,
and optional macOS personal renderers ship in `.cheers-extension` ZIP packages.

## Package contract

`manifest.json` uses `schemaVersion: 1`. Extension, scene, renderer, and Automation IDs
match `^[a-z0-9][a-z0-9._-]{0,63}$`; versions are SemVer. Scene definitions contain
`items`, `seed`, and `pin`. Renderer references are `auto`, `builtin:<id>`, or
`self:<id>`; `self:` is valid only for personal macOS packages.

Packages are limited to 4 MiB compressed, 8 MiB expanded, 128 files, and 256 KiB per seed file. Parsers reject traversal, absolute paths, backslashes, symlinks, duplicate paths, encrypted entries, and unknown executable files.

## Scope

- `Official`: release-managed global data extensions.
- `Global`: admin-installed data extensions shared by all clients.
- `This Mac`: personal packages that may contain renderer code.
- `Temporary`: in-memory packages; code is accepted only in the macOS app.

Stable scene IDs are `extension:<extension-id>:<scene-id>` and `personal:<extension-id>:<scene-id>`. Personal renderer IDs are `personal:<extension-id>:<renderer-id>`.

`.workbench.json` stores shared scene state and built-in renderer bindings. Personal renderer bindings stay in device-local settings. Uninstalling an extension leaves seeded channel files intact.

Automation contributions are inert templates. Users instantiate them as durable
scheduled channel messages and choose the channel, optional bot, and cadence explicitly.
See [Scheduled Messages](SCHEDULED_MESSAGES.md).

## API

- `GET /api/v1/workbench/extensions`
- `GET /api/v1/workbench/extensions/:id/scenes/:sceneId`
- `PUT /api/v1/workbench/extensions/:id`
- `DELETE /api/v1/workbench/extensions/:id`

Uploads use `application/vnd.cheers.extension+zip`. The old `/workbench/plugins` and `/workbench/templates` routes are removed; their database tables remain historical and are not read or written.
