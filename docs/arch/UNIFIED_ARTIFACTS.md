# Unified artifacts

Status: implementation in progress. This document records the target contract and
the migration gates; a checked gate means verified implementation, not a proposal.

## Product contract

A channel has **Artifacts**. Documents, uploaded files, interactive HTML/React pages,
and structured canvases are content types. Cards are presentations of references,
not independent copies. Collections and canvas nodes organize references. Remote
host files remain remote until explicitly delivered; browsing does not publish them.

All clients use one artifact identity, title, availability, version and opening
contract. Preview and source edit the same content. Shared components use the
canonical design-system Item anatomy and native navigation on each platform.
Approvals/authentication retain their domain state machines and authorization;
sharing a presentation does not grant executable capabilities to generated content.

## Identity and storage

`artifact_id` is a channel-scoped, stable UUID string, independent of a path or
renderer. Content providers retain text in `context_files` and uploaded bytes in
object storage referenced by `file_records`. A transactional catalog maps each
provider identity to one artifact. Database triggers cover **all** existing writers,
including uploads, templates, direct edits and legacy clients; no best-effort dual
write is permitted. A rename preserves identity; deletion leaves a tombstone.

The catalog owns a monotonically increasing artifact version. Provider versions
remain explicit and are not interchangeable with artifact versions. Version history
stores text snapshots or the immutable attachment reference. Attachment expiry is
reported honestly; recording metadata does not extend storage retention or recover
expired bytes. Hidden workspace/configuration files remain addressable but are
excluded from the default artifact library. Migration must not expose host files.

Canonical links use `cheers:artifact/<artifact_id>` in the current channel. Legacy
Desk and Inbox links continue to resolve through their existing authorization.
New producer responses return canonical references. A future fixed-version link
must identify the revision explicitly; it must never silently open latest content.

HTML/TSX card anchors use `cheers:artifact/<artifact_id>#^<data-cheers-id>`.
The anchor identifies a node in the current source, not a second artifact. Opening
on Web focuses the source node; context reads include the source document with the
node ID in request params. A missing node must not be inferred from a stale line
number. Native clients currently open the source document without node focusing.

## Implementation gates

- [x] P0: freeze source inventory, contract and migration acceptance cases.
- [x] P1: transactional catalog, snapshots, backfill, unified list/read, stable links.
- [ ] P2: unified Bot create/update/deliver tools, idempotency and producer migration.
- [ ] P3: one Web/macOS artifact library, shared host and reference previews.
- [ ] P4: canvas references, versioned design edits and truthful action results.
- [ ] P5: iOS/Android routing, library and capability-aware rendering.
- [ ] P6: verify migration, remove duplicate business paths and retire old producers.

The HTML/TSX discovery regression is fixed at renderer acceptance: the discovery
layer must ask the registry whether a path can have a renderer, not duplicate an
extension allowlist. Rendering failures remain visible and source remains available.

## Implementation status (2026-10-27)

| Existing source | Current integration | Remaining migration |
| --- | --- | --- |
| `context_files` / `fs.*` | Transactional catalog; library editing sessions on Web and iOS use artifact IDs/versions for read, update and structured patch | Move collection indexes and remaining legacy source-browser sessions from paths to artifact IDs |
| `file_records` / `channel.files.*` | Same catalog, availability and library; deliver returns canonical metadata | Reconcile upload notifications and migrate remaining attachment consumers |
| HTML/TSX renderers | Registry-based discovery, sandbox preview, stable node references; iOS and Android label their source-only capability | Visual/browser verification |
| Message resource cards | Canonical locator/context round-trip and iOS card opening | One shared reference presentation and producer examples |
| Web/macOS channel panels | Artifacts is the default library; old Inbox links open it; duplicate ChannelFilesDialog removed | Full interaction/accessibility verification, collection dirty-state coordination |
| iOS | Shared paginated library for browsing, attachment selection and context; message files and reference cards route into it; native editors use artifact version checks | Native visual/accessibility and end-to-end checks |
| Android | Resource request lifecycle and scope binding; unified paginated library, availability, inert source preview, message-reference routing and system file export implemented | Native visual/accessibility and end-to-end verification; editing and composer context capabilities remain unavailable |

New MCP tools are `artifact_list`, `artifact_get`, `artifact_read`,
`artifact_create`, `artifact_update` and `artifact_deliver`. Gateway initialization
instructions direct new outputs to these tools and canonical artifact links.
`inbox_list`, `inbox_open` and `inbox_deliver` are callable compatibility bindings,
omitted from `tools/list`; discovery is declared in the shared tool registry and
does not change dispatch or scope checks. Legacy Desk operations still exist for
path/directory consumers during migration. Create uses create-only path semantics. With an optional
`idempotency_key`, retries return the original result for 24 hours; concurrent
duplicates commit once, changed arguments are rejected, and authorization is
checked again before replay. Without a key, an existing path is rejected.
Delivery reuses the same existing idempotency infrastructure.
This is not yet the completed P2 producer/idempotency migration.

`channel.artifacts.patch` is the native/editor structured mutation contract. It
uses the same provider patch engine (including YAML comment preservation), checks
artifact version before dispatch and provider ID/version under the write lock,
then returns canonical metadata from that transaction. No parallel patch engine
or second editing buffer is introduced.

The library preserves the existing text editor and its version checks. It blocks
navigation and closing through its own controls while edits are dirty. This does
not yet provide a global draft recovery contract for channel changes or every
collection/window close path. Canvas form actions populate a message draft and
say so; they do not claim that the requested operation has executed.

Validation in this batch: fresh-database migrations, catalog integration cases,
gateway unit tests, MCP catalog/locator tests, frontend full unit tests, TypeScript,
production build, changed-file ESLint, design-system audit and SQLx metadata
regeneration. Browser visual verification is pending because no computer-use
browser is available in the session. No production database or deployment was
changed. P3–P6 remain open; this batch must not be described as full unification.

Second-batch verification: 997 frontend tests, six database artifact integration
tests, 31 MCP tests, 33 iOS release-readiness tests on iPhone 17 Pro simulator,
iOS simulator build, TypeScript, changed-file ESLint, design-system audit and SQLx
offline metadata check. Android build is not verified: `java -version` reports no
Java runtime. Native preview coverage includes artifact availability and actions.

Third batch: JDK 17 and Android command-line tools are installed; the earlier Java
blocker is resolved. Twelve JVM protocol/state tests pass, including a real
MockWebServer WebSocket handshake and forced channel-scope binding. The independent
`apps/android/protocol-tests` target compiles the production Kotlin sources without
an Android SDK. Design-system checks pass. APK build was attempted and stops because
the Android SDK license had not yet been accepted (Platform 35 and AGP's default
Build-Tools 34.0.0). The user subsequently authorized acceptance; those components
are now installed. Full Android build verification follows below.

Fourth batch: Android `assembleDebug` and all 12 `testDebugUnitTest` tests pass,
including compilation of the Compose artifact library. The debug APK is generated;
device interaction and visual acceptance remain pending. MCP's 31 tests, seven
fresh-database integration tests and the design-system audit pass after adding
optional create idempotency. The new database test verifies concurrent deduplication,
changed-argument rejection and authorization after membership removal. No deployment
has been performed.

Fifth batch: MCP resource templates now discover artifact list/content/metadata,
with strict pagination and boolean query parsing. Channel-qualified MCP resource
URIs and in-channel artifact links address the same catalog IDs. Previously issued
file/source URIs remain readable. Prompt discovery exposes `review_artifact`;
existing `review_attachment` calls remain compatible. English and Chinese Bot
documentation now describe channel-shared artifacts rather than a private Desk.
MCP's 33 tests and Gateway's 485 unit tests pass, including canonical discovery,
legacy dispatch, OAuth scopes and resource URI validation. Formatting and diff
checks pass. Remaining Desk operations and collection consumers
still prevent marking P2/P6 complete.

## Acceptance and rollout

Test text and attachment backfill, rename stability, delete/recreate identity,
cross-channel denial, deterministic pagination, stale writes, duplicate delivery,
attachment expiry, reconnect and old links. Test HTML/TSX discovery including
specialized extensions. UI verification covers loading/empty/error states, keyboard
navigation, narrow screens and both themes.

Use a fresh PostgreSQL database for migration and SQLx metadata validation. Never
edit an applied migration. Keep old storage and endpoints until consumers have
migrated and counts/content/permissions have been reconciled. Compatibility stays
at the boundary; there must be one business implementation behind it. Deploy the
rebuilt gateway before clients use new resource verbs. Connector protocol changes
follow the repository's signed-release and configuration-floor rules.
