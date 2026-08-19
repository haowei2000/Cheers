# Plugin system

> Status: **partially adopted** — 2026-08-19. The integration half landed with the
> *Pluggable integrations* milestone; the workbench half predates it. They enforce the
> same rule but do not yet share a manifest — see [Known inconsistencies](#known-inconsistencies).

## The rule everything follows

**Third-party code never runs where it would inherit ambient authority.**

The gateway holds the database, the decrypted credentials, and every authorization
decision. Code running there has all of it, and no in-process sandbox is credible. So
the gateway runs **no third-party code at all**: an integration is *data* describing how
to drive engines the gateway itself owns.

The browser holds the user's session token and the DOM. Code running there could
exfiltrate the session. So client extensions run in an opaque-origin iframe with
`sandbox="allow-scripts"`, reaching the host only through a JSON-RPC capability list
checked against their manifest ([RENDERER_PLUGIN.md](RENDERER_PLUGIN.md)).

The agent's machine already runs arbitrary code — that is what an agent is. Real logic
belongs there, as an ACP connector or an MCP server. This is why GitHub *write-back*
(commenting, opening PRs) is deliberately not a gateway engine.

When you are unsure where a new capability belongs, re-derive it from this rule rather
than from precedent.

## Three execution sites

| Site | Runs | Trust basis | Blast radius |
|---|---|---|---|
| **Gateway** | Declarations only — templates, projections, signature schemes | The gateway's own engines interpret them; nothing third-party executes | Whole workspace |
| **Client** | Sandboxed renderer JS (macOS personal installs only) | Opaque-origin iframe, no host DOM/cookies/token, manifest-checked JSON-RPC | One user, one device |
| **Agent host** | Arbitrary code, by design | Out of process; the connector's own L0 host policy is the floor | One bot's machine |

## What exists today

| Mechanism | Package | Install record | Signed | Permission vocabulary |
|---|---|---|---|---|
| Bot + ACP connector | `connector-manifest.json` | `terminal_installations` | ed25519 vs pinned key | capability delegations, bot-grants, event-access |
| Workbench extension — global | `.cheers-extension` zip | `workbench_extensions`, `origin IN ('admin','system')` | sha256 only | **none permitted** (see below) |
| Workbench extension — personal | same zip | none — client-side only | sha256 only | `file.write`, `channel.resources`, `network`… |
| Integration | compiled into `catalog.rs` | `integration_installations` | n/a (in-tree) | channel-role projection |

Three clarifications the table cannot carry:

**MCP is not a fourth install mechanism, and it points the other way.** There is no
"install an MCP server" feature: Cheers *is* the MCP server
([packages/cheers-mcp-server](../../packages/cheers-mcp-server)), and a bot's connector
host is the client. What the platform records is whether a given host has signed in —
`mcp_connection_state`, a column on `terminal_installations`
([0077](../../server/migrations/0077_installation_mcp_connection_state.sql)), not an
install record of its own. It appears in this section only because its OAuth scopes are
one of the permission vocabularies below.

**The server refuses to store code.** Every server-side install path calls
`validate_package(raw, allow_code = false)` — [api/workbench.rs:73](../../server/src/api/workbench.rs:73)
and [workbench_official_extensions.rs:104](../../server/src/domain/workbench_official_extensions.rs:104).
That rejects any package contributing a renderer *or* requesting any permission at all
([workbench_extensions.rs:495](../../server/src/domain/workbench_extensions.rs:495)). A
globally installed extension is therefore purely declarative: scenes and automations over
`builtin:` renderers. Renderer JavaScript exists only in personal, client-side installs on
macOS; browser and iOS ignore renderer contributions entirely. The execution boundary is
enforced in code, not by convention.

**LiveKit is a half-citizen.** It uses the shared verification primitive
(`webhook::verify_body_sha256_b64`, called from [api/voice.rs:1560](../../server/src/api/voice.rs:1560))
but keeps its own route, its own dedupe table (`voice_webhook_events`), and its own event
semantics. Only verification was generalised — deliberately.

## The integration pipeline

Six stages, each a separate module, each replaceable without touching the others.

1. **Ingress** — `POST /api/v1/integrations/:integration_id/:installation_id/events`
   ([router.rs:985](../../server/src/router.rs:985)). Unauthenticated by necessity, so it
   does the minimum: verify the signature, store the event, answer `202`. A provider that
   waited on our fan-out would time out and start redelivering.
2. **Verification** — [`webhook.rs`](../../server/src/domain/integrations/webhook.rs). The
   scheme is declared data. Three properties are load-bearing: every function takes
   `&[u8]` so nothing reaches `serde_json` before a valid signature; comparison goes
   through `Mac::verify_slice`, never `==`; and `Rejection` carries no cause, so the
   endpoint cannot enumerate which integrations exist.
3. **Storage** — `integration_webhook_events`, keyed
   `(integration_id, installation_id, event_id)` on the provider's own delivery id. A
   redelivery of a handled event is a no-op at the primary key.
4. **The worker** — [`integration_event_worker.rs`](../../server/src/gateway/integration_event_worker.rs)
   polls every 5s and calls `delivery::drain_once`.
5. **Mapping** — [`mapper.rs`](../../server/src/domain/integrations/mapper.rs) over
   [`template.rs`](../../server/src/domain/integrations/template.rs). Interpolation, a
   `length` helper, and a conditional. No loops, no expressions, no user code.
6. **Delivery** — [`delivery.rs`](../../server/src/domain/integrations/delivery.rs) posts
   through `create_message` as the user who bound the channel, so the integration stays
   inside the existing permission model rather than beside it.

Two supporting engines run outside that flow:

- [`credentials.rs`](../../server/src/domain/integrations/credentials.rs) — encrypted
  token custody. Callers receive a [`Secret`](../../server/src/domain/integrations/secret.rs),
  which has no `Display` and redacts under `Debug`; reading the plaintext requires
  `expose()`, which is greppable in review.
- [`projection.rs`](../../server/src/domain/integrations/projection.rs) +
  [`bindings.rs`](../../server/src/domain/integrations/bindings.rs) — the provider's
  permission vocabulary mapped onto the four channel roles, written as ordinary
  `channel_memberships` rows. Nothing in a permission check knows the row came from GitHub.

## Maintaining it

### Adding an integration

Adding a provider is an edit to one table plus configuration. In the common case there is
**no new Rust logic**.

1. Add an `IntegrationDescriptor` to `descriptors()` in
   [`catalog.rs`](../../server/src/domain/integrations/catalog.rs): the signature scheme,
   where the provider puts its event id and event type (`Header` or `BodyPointer`), the
   `resource_kind` and `resource_path`, the role projection, an optional `init_prompt`,
   and the event mappings.
2. Add config only if the provider needs app-level credentials — GitHub needs
   `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` in [`config.rs`](../../server/src/config.rs).
   Per-installation webhook secrets do **not** go in config; they live encrypted in
   `integration_installations.webhook_secret_enc`, because a provider issues a distinct
   secret per installation.
3. Add a provider API client under `domain/integrations/<provider>/` only if the
   integration must *read* the provider (repo lists, collaborator rosters). This is the
   one place new Rust is expected.
4. Run `cargo test --lib`. The catalog's own tests validate the new row — see the
   invariant table below. A malformed projection or an uncompilable template fails there,
   not at delivery time.

Do not add a new route, a new signature check, or a new dedupe table. If you find
yourself wanting one, that is the signal the descriptor is missing a field.

### Adding an event mapping

Append an `EventMapping` to the provider's event table. Both gates exist because
providers need both shapes and neither expresses the other: `skip_when` for GitHub's
`push` arriving on branch *deletions* with `deleted: true`, `require` for a nested object
that is sometimes absent. An event type with no mapping is stored, marked processed, and
never posted — that is the intended handling for the dozens of types nobody wants echoed.

### Adding a workbench extension

Build with `cheers-workbench pack` from
[`packages/cheers-workbench-sdk`](../../packages/cheers-workbench-sdk). Then decide the
scope *first*, because it determines what the package may contain:

- **Global** (admin-installed, server-stored): declarative only. No renderers, no
  permissions. If validation rejects your package with "global extensions must be
  declarative", the package wants to be personal.
- **Personal** (macOS, client-installed): may carry renderer JS and request permissions.
  Never leaves the device.

Official scene templates are seeded from `server/assets/workbench-templates/*.template.json`
and re-seeded when the embedded version rises — but never over an id an admin has claimed
([`should_seed`](../../server/src/domain/workbench_official_extensions.rs:22)).

### Invariants, and the test that guards each

Every row here is a property someone will eventually try to break. Do not change one
without changing its test deliberately.

| Invariant | Guard |
|---|---|
| No integration can hand out channel ownership | `catalog::tests::no_integration_can_hand_out_channel_ownership` |
| A repository reader never becomes a channel writer | `catalog::tests::a_repository_reader_never_becomes_a_channel_writer` |
| A projection cannot invent a fifth role or duplicate a provider role | `catalog::tests::every_declared_role_projection_is_valid` |
| Every declared template compiles | `catalog::tests::every_declared_mapping_compiles`, `…::every_declared_init_prompt_compiles` |
| Event types are unique within an integration | `catalog::tests::event_types_are_unique_within_an_integration` |
| Hostile provider text cannot forge markdown structure | `mapper::tests::a_hostile_commit_message_cannot_forge_structure_in_a_real_mapping` |
| Project-init facts travel beside the body, never inside it | `catalog::tests::an_init_body_is_escaped_so_the_facts_must_travel_beside_it` |
| Nothing outside `domain::integrations` reads `projected_from` | `bindings::tests::nothing_outside_this_module_can_read_the_projection_marker` (negative control: `…::the_marker_guard_still_rejects_a_read`) |
| A human's role edit is never silently reverted by the next sync | `api::channels::tests::setting_a_role_by_hand_releases_the_row_from_its_integration` |
| A secret never reaches a log line | `secret::tests::debug_never_reveals_the_value` |
| Delivery is idempotent across a crash | `delivery::tests::a_message_id_is_stable_for_one_delivery` |

Two invariants are structural rather than test-guarded, and reviewers must hold them:

- **Verify before parse.** Every function in `webhook.rs` takes `&[u8]`. A signature
  helper that accepts a parsed value would silently undo this.
- **Uniform rejection.** `Rejection` deliberately carries no cause. Adding a reason to
  the response turns the ingress endpoint into an enumeration oracle.

### Release discipline

- Migrations are sequential and never renumbered; never edit an applied migration's body
  (see CLAUDE.md). Integration schema currently ends at `0087`.
- Connector changes follow the release order in [AGENTS.md](../../AGENTS.md): version bump →
  fmt/test/check → upgrade local daemons. Auto-update needs the signed
  `connector-manifest.json` from the tag's CI job.
- Run `cargo fmt --check` per crate before pushing; CI's fmt gate fails PRs that
  `cargo check`/`cargo test` will not catch.

## Known inconsistencies

These are real and worth fixing, in roughly this order. None is a security hole today;
together they are why the system reads as chaotic.

1. **"Installation" means two unrelated things.** `terminal_installations` is a machine
   running a connector daemon; `integration_installations` is a provider-side install.
   Both surface as `/installations` in the router
   ([:593](../../server/src/router.rs:593) and [:332](../../server/src/router.rs:332)).
   Rename the former to runners or deployments.
2. **Four permission vocabularies that cannot be compared.** A manifest says `file.write`;
   a bot has capability delegations; an integration projects channel roles; MCP has OAuth
   scopes. No query answers "what can this thing do?", so no consent screen can honestly
   describe what is being approved. The resource protocol is already the platform's
   authorization surface and should become the single vocabulary.
3. **Personal scope has no server record.** The bytes are not lost — the desktop shell
   persists each one to `~/.cheers/extensions/{id}.cheers-extension`, written atomically
   at `0o600` ([plugins.rs:197](../../apps/macos/src-tauri/src/plugins.rs:197)), with
   enable/disable in `localStorage`
   ([runtime.ts:11](../../frontend/src/features/chat/workbench/extensions/runtime.ts:11)).
   What is missing is the *server's* copy: the `origin` check allows only `'admin'` and
   `'system'`, while the client's `InstallScope` is `"global" | "personal" | "temporary"`.
   So a personal install is invisible to admins and does not follow the user to a second
   device. Whether the fix is a scope column on the same table depends on an unanswered
   question — see "Where this is going".
4. **No authorship check on packages.** sha256 proves the bytes were not altered in
   transit, not who wrote them. The ed25519 + pinned-key mechanism already exists in
   [`self_update.rs:93`](../../packages/cheers-acp-connector-rs/src/self_update.rs:93) and
   should be pointed at packages too — mattering most for personal installs, which are the
   only ones that may hold `network: unrestricted`.
5. **`catalog.rs` is compiled-in data.** It is data the gateway interprets, yet changing
   it requires a gateway rebuild. That is the test for what can move out of tree, and the
   catalog currently fails it.

## Where this is going

One manifest whose `contributes` block names the target surface, so a single package can
carry a server-side integration *and* a client-side renderer — which is exactly what an
Overleaf integration needs (`.tex` rendering plus project binding). The workbench manifest
already has the right shape; extending its `contributes` with `integrations` is a change
of source, not a redesign.

Giving personal scope a server record (inconsistency 3) waits on one product question,
because the answer changes the architecture rather than the schema: **does the server store
the bytes?** If it does, the invariant at
[desktop.ts:28](../../frontend/src/lib/desktop.ts:28) — that personal-extension bytes never
leave the device — dies, and with it the justification for validating on the client at all.
If it does not, a record of `{user_id, extension_id, version, sha256, installed_at}` buys
admin visibility and cross-device *discovery* but not cross-device *install*: the second
device learns the extension exists and has no way to obtain it. Neither is obviously right,
so the column is not the decision.

The repo split follows that work rather than preceding it. The boundary is **engine vs
content**, not plugin vs core: the engines above stay in-tree and version with the gateway;
individual descriptors and renderer bundles move to a signed-package repo. The test for
which side something belongs on is whether changing it requires a gateway rebuild.

## Related

- [Workbench renderer runtime](RENDERER_PLUGIN.md) — the client sandbox and its JSON-RPC surface
- [Terminal installations](TERMINAL_INSTALLATIONS.md) — connector hosts, the *other* "installation"
- [Platform-resource permissions](PLATFORM_RESOURCE_PERMISSION.md) — the vocabulary item 2 should converge on
- [Security baseline](SECURITY.md)
