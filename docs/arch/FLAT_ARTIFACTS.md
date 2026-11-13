# Flat artifacts

Status: proposed (2026-11-13). Nothing below is implemented yet. When a phase lands,
mark its gate and say what verified it.

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

## Data model

| Today | Flat |
|---|---|
| `context_files.content` (text in Postgres) or `file_records` + S3 | One S3 object per artifact version |
| `artifacts` catalog kept in sync by triggers | `artifacts` is written directly; no triggers |
| `artifact_revisions.snapshot` holds full text as JSONB | `artifact_revisions` holds the version's object key and sha256 |
| Directory rows (`is_dir`) | No directories. A path prefix is a folder; empty folders do not exist |
| `source_kind`, `source_version`, `source_id` | Removed |

Object keys are content-addressed per version
(`artifacts/<channel_id>/<artifact_id>/<version>-<sha256>`). A write stores the
object first and then commits the row with `UPDATE ... WHERE version = $expected`,
so a failed or losing write leaves only an unreferenced object, which a sweep
removes. This replaces the `context_files` row lock as the concurrency check.

Retention is a column, not a store: `expires_at` stays per artifact. Artifacts
written with `artifact_put` do not expire; files uploaded by people keep today's
7-day TTL unless that policy changes separately.

Revision history moves out of Postgres. That also removes the unbounded JSONB growth
noted in the earlier review; pruning old objects is a separate retention decision.

## Writing: `artifact_put`

```
artifact_put(channel_id, path,
             content | data_b64 + sha256 | upload_id,
             if_version?, idempotency_key?)
```

- Without `if_version`, it creates and refuses an existing path, like `artifact_create` today.
- With `if_version`, it replaces that version, like `artifact_update` today.
- `content` is for text the model wrote; `data_b64` + `sha256` for small binaries
  with no shell; `upload_id` from `artifact_upload_prepare` for anything else. The
  upload ticket remains the transport, not a second way to deliver.
- `artifact_create`, `artifact_update`, `artifact_deliver`, `artifact_upload_finish`,
  `inbox_deliver` and the `desk_*` write tools become hidden aliases of `artifact_put`,
  then are removed after the deprecation window.

`artifact_patch` keeps structured edits (including YAML comment preservation): the
gateway reads the current object, applies the same patch engine, and writes the next
version through the same path as `artifact_put`.

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

The longest matching suffix wins. A lens that needs configuration reads it from the
file itself (a kanban file carries its `columns`); template-supplied lens config and
the `.workbench.json` path-to-renderer bindings are removed.

Extension manifests gain `match.suffix`. The content predicates (`requireAll`,
`requireAny`, `jsonHas`, `dataHas`, `dataKind`, `glob`) are deprecated: during the
window an extension without `suffix` still loads but is offered for nothing, and the
extension panel says why.

**Existing files are not renamed silently.** A plain `plan.yaml` that shows as a
canvas today shows as source after phase F1. The migration report lists every file
whose view changes, and the library offers "Rename to plan.canvas.yaml", which calls
`artifact_rename`.

## Server readers that move with the store

These read `context_files` directly today and must read through the artifact store:

- `gateway/dispatcher.rs`: `.workbench.json` and per-path config on every dispatch.
  Needs a small in-process cache keyed by artifact version, because S3 latency on the
  dispatch path is not acceptable.
- `api/annotations.rs`: `annotations.yaml`.
- `api/workspace.rs`: path/basename lookup for workspace context.
- `api/resources.rs`: resource URI resolution and version checks.

## Phases

Each phase is one PR to `develop` and leaves the system working.

- [ ] **F1. View by name (Web/macOS).** Suffix table above, `match.suffix` for
  extensions, picker and bindings removed, migration report and rename action in the
  library. iOS and Android follow the same table in F5.
- [ ] **F2. Object-backed artifacts.** New columns (`object_key`, `sha256`) and
  revisions by object key. New text writes go to S3; reads fall back to
  `context_files` for rows not yet migrated. Triggers stay until F3 completes.
- [ ] **F3. Backfill.** Idempotent, resumable gateway job that copies every
  `context_files` file to S3 and records the object; verified by counts and sha256 per
  channel. Directory rows are dropped; empty directories are listed in the report.
- [ ] **F4. `artifact_put` and server readers.** One write tool; old tools become
  hidden aliases; the four readers above switch to the store; `fs.*` verbs are
  reimplemented on top of artifacts for old clients.
- [ ] **F5. Clients.** Web `FilePanel`/`fsClient`, iOS and Android move from `fs.*`
  and `channel.files.read` to artifact verbs and the suffix view table.
- [ ] **F6. Removal.** After one release with no `fs.*`, `desk_*` or `inbox_*` calls
  in gateway logs: remove the aliases and verbs, drop the triggers, then drop
  `context_files` in its own migration.

## Risks

- **Dispatch latency.** Config files now come from S3; F4 must ship the cache with
  the switch, not after it.
- **Backups.** Text content leaves Postgres; restore procedures must include the
  bucket.
- **Views that change.** F1 changes what users see for existing JSON/YAML files;
  the report and rename action are part of F1, not a follow-up.
- **Lost features.** Empty directories and per-path view bindings disappear by design.
