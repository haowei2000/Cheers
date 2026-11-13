# Flat artifacts

Status: approved for P0 → F1 (2026-11-13). D1–D4 confirmed by the owner.
Implementation gates remain open. When a phase lands,
mark its gate and say what verified it.

Implementation progress (2026-11-13):

- P0: plan PR #876 and artifact delete/rename PR #877 merged. The latter includes
  the Bugbot fix restricting ID mutations to exactly one file; all required CI passed.
- F1: implemented on `feat/artifact-view-by-name`, pending PR/CI and deployment.
  Shared suffix selection, source/error fallback, extension suffix declarations,
  library rename diagnostics, and bot guidance are implemented. New official seeds
  use suffix names; table columns live beside `rows` in the file. Existing files are
  never automatically renamed. Legacy content matching is retained only for the
  read-only migration report over loaded library pages.
- Local validation: 1,301 frontend tests, typecheck, design-system/security checks,
  production build; 549 gateway unit tests and 13 artifact integration tests;
  37 MCP tests, 256 connector tests (one ignored), and five SDK tests passed.
  Headless Chrome fixture checks cover all text views, malformed-source fallback,
  and library rename at 390/768/1280 widths in light/dark themes.
- Real-stack validation: the rebuilt source gateway and isolated PostgreSQL passed
  the browser registration/channel flow plus artifact creation over WebSocket,
  library rename, and opening the renamed table. Four browser scenarios passed.
  Extension file panels also obey suffixes and ignore manifest view/config overrides
  (two focused regression tests passed).
- Still open: release deployment and ordered connector release/daemon upgrade.
  The real-stack test uses an isolated local gateway, not the deployed kind cluster.
  F2–F6 and native-client F5 work have not started.

This plan replaces the layered model in [UNIFIED_ARTIFACTS.md](UNIFIED_ARTIFACTS.md),
where an artifact is a catalog row over two content providers. The catalog identity,
version, availability and `cheers:artifact/<id>` link contract from that document
stay; the two providers and the view picker go.

## Decisions

1. **One store.** Every artifact's bytes live in object storage (S3/rustfs). The
   `artifacts` table is the only record of identity, path, version and availability.
   `context_files` and the text/attachment split are retired.
2. **One way to deliver.** Bots write every artifact through one tool,
   `artifact_put`. Edits by ID (`artifact_patch`, `artifact_rename`,
   `artifact_delete`) remain, because they act on an existing version.
3. **The file name decides the view.** Each name maps to exactly one view. There is
   no content sniffing, no "view as" picker and no per-path binding.
4. **Extensions own a suffix.** An installed renderer extension claims a compound
   suffix (for example `.gantt.yaml`) and is the only view for it.

D1–D4 confirmed on 2026-11-13; D5 remains open until phase R:

- **D1 (F1).** Existing files are not renamed automatically; the library lists files
  whose view changed and offers a rename.
- **D2 (F4).** Empty directories disappear; a folder is only a path prefix.
- **D3 (F2).** Expiry stays per artifact: `artifact_put` artifacts do not expire,
  files uploaded by people keep the 7-day TTL.
- **D4 (F1).** Lens configuration lives in the file (a kanban file carries its
  `columns`); template-supplied lens config and `.workbench.json` bindings go.
- **D5 (R).** Revision retention rule, for example "keep the last 20 versions and
  every version newer than 30 days".

## Data model

| Today | Flat |
|---|---|
| `context_files.content` (text in Postgres) or `file_records` + S3 | One S3 object per artifact version |
| `artifacts` catalog kept in sync by triggers | `artifacts` is written directly; no triggers |
| `artifact_revisions.snapshot` holds full text as JSONB | `artifact_revisions` holds the version's object key and sha256 |
| Directory rows (`is_dir`) | No directories. A path prefix is a folder |
| `source_kind`, `source_version`, `source_id` | Removed; `legacy_id` keeps old `cheers:desk` / `cheers:inbox` links resolving |

Object keys are per version: `artifacts/<channel_id>/<artifact_id>/<version>-<sha256>`.
A write stores the object first, then commits the row with
`UPDATE artifacts ... WHERE version = $expected`. A failed or losing write leaves only
an unreferenced object, which a sweep removes. This replaces the `context_files` row
lock as the concurrency check.

Old links in message history never stop working: `cheers:desk/<path>` resolves by
path, `cheers:inbox/<file_id>` and resource URIs resolve by `legacy_id`.

## Writing: `artifact_put`

```
artifact_put(channel_id, path,
             content | data_b64 + sha256 | upload_id,
             if_version?, idempotency_key?)
```

- Without `if_version`: create; an existing path is refused.
- With `if_version`: replace that version.
- `content` is text the model wrote; `data_b64` + `sha256` is a small binary from an
  Agent with no shell; `upload_id` comes from `artifact_upload_prepare`, the transport
  for everything else.
- `artifact_create`, `artifact_update`, `artifact_deliver`, `artifact_upload_finish`,
  `inbox_deliver` and the `desk_*` write tools become hidden aliases, then are removed.

`artifact_patch` keeps structured edits, including YAML comment preservation: the
gateway reads the current object, applies the same patch engine and writes the next
version through the `artifact_put` path.

## Views

| Name | View |
|---|---|
| `*.md`, `*.markdown` | markdown |
| `*.html`, `*.htm` | html |
| `*.tsx`, `*.jsx` | react |
| `*.canvas.yaml`, `*.canvas.json` | canvas |
| `*.chart.yaml`, `*.chart.json` | chart |
| `*.table.yaml`, `*.table.json` | table |
| `*.kanban.yaml`, `*.kanban.json` | kanban |
| `*.codemap.yaml`, `*.codemap.json` | codemap |
| `*.a2ui.yaml`, `*.a2ui.json` | a2ui |
| `*.<suffix>.<ext>` claimed by an installed extension | that extension |
| images, PDF | built-in file preview |
| anything else | source (text) or download (binary) |

The longest matching suffix wins. The table is one data file shared by the gateway
(list `type` filter, MCP guidance) and every client, so no copy of the rule can
drift.

## Phases

Each phase is one PR to `develop`, leaves the system working, and can be rolled back
until F6. Sizes are rough: S ≈ a day, M ≈ a few days, L ≈ a week or more.

### P0. Land the finished work (S)

- Open PRs for `feat/artifact-delete-rename` (artifact_delete/rename, module cleanup)
  and `design/flat-artifacts` (this document). Delete the merged
  `fix/artifact-deliver-integrity` branch.
- [x] Confirm D1–D4 (owner approved P0 → F1 on 2026-11-13).
- Optional, separate PR: the ~15 `clone` on `Copy` clippy findings and two unused
  `.sqlx` files. Not blocking: CI runs clippy with `|| true`.

### F1. View by name (M, Web/macOS + bot guidance)

- `shared/view-suffixes.json`: the view table. Rust reads it with `include_str!`,
  the frontend imports it.
- `renderers/registry.ts`: replace `formatOf`, `accepts`, `candidatesFor`,
  `specificity` and `previewOptions` with `viewFor(path, extensions)`.
- `sandbox/rendererExtension.ts`, `extensions/package.ts`, `manifest.ts`: add
  `match.suffix`; an extension without one loads but is offered for nothing, and the
  extension panel says why.
- `workbenchConfig.ts`: stop reading `bindings`, drop the key on the next write,
  update the `_doc` text.
- `RendererHost.tsx`, `panels/FilePanel.tsx`: remove the picker and the fallback
  chain; a render failure shows source with the error.
- Kanban reads `columns` from its file; template-supplied lens config is removed.
- `ArtifactLibrary.tsx`: "view changed" list with a "Rename to …" action that calls
  `channel.artifacts.rename`.
- Gateway: `artifact_list` `type` filter and a derived `type` field use the shared
  table instead of the canvas regex.
- Bot guidance: `MCP_INSTRUCTIONS`, `read_ui_contract` / `cheers://help/interactive-ui`,
  `docs/help/INTERACTIVE_RESOURCES*`, and the connector prompt (`desk_write` → artifact
  tools), released in the order in AGENTS.md.
- Verify: registry and manifest unit tests, `pnpm typecheck test design-system:check
  security:check`, `run-e2e` screenshots of each view.

### F2. Dual write to object storage (M, gateway)

- Migration: `artifacts` gains `object_key`, `sha256`, `legacy_id`;
  `artifact_revisions` gains `object_key`, `sha256`; `snapshot` becomes nullable.
- `resource/artifact_store.rs`: `put` (object, then conditional row update), `read`
  (object if present, else the old provider), orphan sweep.
- Every writer also writes the object: `fs.write/patch/edit/append`, the artifact
  verbs, `channel.files.create`, uploads, and human uploads in `api/files.rs`.
  Attachments are already in S3, so they only record `object_key`.
- Reads are unchanged. A background check compares object sha256 with the row and
  logs mismatches.
- Rollback: ignore the new columns.

### F3. Backfill (S, gateway job)

- Idempotent, resumable startup job: write an object for every `context_files` file
  and record it; record `object_key` for every attachment; set `legacy_id`.
- Report per channel: counts, sha256 matches, empty directories (D2), files whose
  view changes (D1).
- Exit: zero rows without `object_key`, zero sha256 mismatches.

### F4. Read from the store, `artifact_put` (L, gateway + MCP)

- Artifact verbs and `fs.*` read through `artifact_store`. `fs.ls` builds folders from
  path prefixes.
- Move the four direct readers: `gateway/dispatcher.rs` (`.workbench.json` and config
  on every dispatch), `api/annotations.rs`, `api/workspace.rs`, `api/resources.rs`.
  The dispatcher gets an in-process cache keyed by artifact version in the same PR.
- `artifact_put` in the registry; the old write tools become hidden aliases;
  delete/rename now cover attachments too. The frozen tool catalog changes.
- Log every legacy verb and tool call (verb, principal kind, channel) so F6 has data.
- `ARTIFACT_STORE_READS` flag to fall back to provider reads during the first release.
- Verify: artifact and flows integration suites on a fresh database plus a backfilled
  copy of a dev database; dispatch latency before and after.

### F5. Clients (L, Web + iOS + Android)

- Web: `fsClient.ts`, `channelFileClient.ts`, `FilePanel.tsx` and the other `fs.*` /
  `channel.files.read` callers (`ChannelView`, `fileView`, `ResourceInlinePreview`,
  `MessageComposer`, `contextPick`, `ContextPickBar`, `extensionInstall`,
  `api/messages.ts`) move to artifact verbs by ID. `artifactEditorClient` goes away.
- iOS (`WorkbenchSheet.swift`, `DTOs.swift`) and Android (`ArtifactController.kt`,
  `ChatViewModel.kt`) use artifact verbs and the shared view table.
- Verify: frontend suite, iOS release-readiness tests, Android unit tests and
  `assembleDebug`, native visual checks.

### F6. Remove the old model (M, irreversible)

- Gate: one full release with no legacy calls in the F4 logs, and a database plus
  bucket backup.
- Stop writing `context_files`; remove the `fs.*` verbs, `desk_*` / `inbox_*` tools,
  `channel.files.*` verbs, the triggers and `sync_channel_artifact`, then drop
  `context_files` in its own migration. Old links keep resolving through `legacy_id`.

### R. Revision retention (S, after F4)

- Sweep job applying D5 to old revision objects. The current version is never
  pruned. Not reversible, so it ships with a dry-run report first.

## Risks

- **Dispatch latency.** Config reads move to S3; F4 ships the cache with the switch.
- **Backups.** Text leaves Postgres from F4 on; restore procedures must include the
  bucket.
- **Views that change.** F1 changes what users see for existing JSON/YAML files; the
  report and rename action are part of F1.
- **External bots.** Bots outside this repo may still call old tools; F6 waits for
  the logs, not a date.
- **Dropped features.** Empty directories and per-path view bindings go by design.
