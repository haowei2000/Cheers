# Channel annotations

> **Language**: English | [中文](annotations.zh-CN.md)

Annotations are a shared channel feature for workspace files and agent execution events.
The channel toolbar, Workbench notes action, and event-row annotation action open the
same panel. Filter by current object, channel, files, or events, and search labels,
notes, and source identifiers.

## Write and review

- In Workbench, annotate a file or select text/a structured item and use its annotation
  action. Existing text, YAML/JSON path, and inspectable URI anchors are retained.
- In a message's execution record, use the annotation action beside an event. Add a
  note and save. Ctrl/Command+Enter saves; ordinary Enter inserts a line break.
- Select a note to edit or delete it. The author and channel administrators can change
  it; read-only channel members can browse. Delete requires inline confirmation.
- Locate opens the original file or message execution record. File anchors resolve
  against current content. If the source has changed or trace retention removed it,
  the saved note and its source snapshot remain available.
- Send adds the note and its source to the message draft, including a file/message
  context attachment. Review the draft and send it through the normal composer.

## Persistence and access

The gateway stores both kinds in `channel_annotations`, scoped to a channel. Refreshing
or switching devices preserves notes. Clients refresh every 15 seconds and after
mutations. Concurrent edits/deletes use a revision check and return a conflict rather
than overwrite another person's changes. The editor keeps a failed draft for retry.
Event annotations use gateway-verified trace metadata and inherit the event's SEE
policy, including after trace retention. Channel membership is required for every API.

On first listing, the gateway imports valid entries from an existing channel
`annotations.yaml`, preserving anchors and creation dates. Import is idempotent;
deleted imports never return. Historical authors remain unknown, so channel
administrators manage those notes. The source document is kept intact as an archive;
new edits use the database. Fix malformed YAML and refresh to retry import. Invalid
individual entries are skipped; no original content is deleted.

## API and deployment

Authenticated endpoints:

- `GET /api/v1/channels/{channel_id}/annotations`: `{ notes, import_warning }`.
- `POST` to that endpoint: `{ target, label, note }`.
- `PATCH /api/v1/channels/{channel_id}/annotations/{id}`: `{ note, revision }`.
- `DELETE` to that item endpoint: `{ revision }`.

Targets are discriminated by `kind`: `file` has `path` and a typed `anchor`; `event`
has `msg_id`, `event_id`, optional `tool_call_id`, and a snapshot. The gateway replaces
client event snapshots with persisted source metadata. New event notes require a
persisted trace; retry after the event is saved if creation is rejected.

Migration `0103_channel_annotations.sql` runs on gateway startup. Rebuild and recreate
the gateway so the migration and routes ship together:

```sh
docker compose build --no-cache gateway
docker compose up -d --force-recreate --no-deps gateway
```

The real HTTP regression test uses an isolated database created by sqlx and starts
its own gateway on an OS-assigned port. Only a PostgreSQL connection with permission
to create test databases is needed; OpenSSL generates temporary signing keys. The
gateway process and temporary files are cleaned up when the test finishes.

```sh
cd server
DATABASE_URL="$TEST_DATABASE_URL" cargo test --features integration --test annotations_http
```

To run the same assertions against an existing isolated stack, supply its target
URL through `INTEGRATION_BASE_URL` (no fixed port):

```sh
INTEGRATION_BASE_URL="$TEST_GATEWAY_URL" DATABASE_URL="$TEST_DATABASE_URL" \
INTEGRATION_LOGIN="$TEST_LOGIN" INTEGRATION_PASSWORD="$TEST_PASSWORD" \
cargo test --features integration --test annotations_http external_gateway_annotations -- --ignored
```
