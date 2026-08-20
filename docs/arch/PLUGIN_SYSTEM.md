# Plugin system

> Status: **adopted boundary** — 2026-08-19. Server integrations are trusted,
> release-coupled catalog entries. Client plugins are presentation extensions and
> cannot register server behavior.

## The rule everything follows

**Third-party code never runs where it would inherit ambient authority.**

The gateway holds the database, decrypted credentials, and every authorization decision.
Code running there has all of it, and no in-process sandbox is credible. The gateway
therefore runs **no third-party code**. Its declarative integration catalog is first-party
Rust data, reviewed and shipped with the gateway binary.

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
| **Gateway** | First-party catalog declarations and generic engines | Code review plus the signed gateway release | Whole workspace |
| **Client** | Controlled header, ViewBoard and Workbench contributions; renderer JS only in the sandbox | Profile filtering plus capability-checked JSON-RPC | One user, one device |
| **Agent host** | Arbitrary code, by design | Out of process; the connector's own L0 host policy is the floor | One bot's machine |

## What exists today

| Mechanism | Package | Install record | Signed | Permission vocabulary |
|---|---|---|---|---|
| Bot + ACP connector | `connector-manifest.json` | `connector_hosts` | ed25519 vs pinned key | capability delegations, bot-grants, event-access |
| Workbench contribution — official | compiled catalog data | none | signed Gateway release | **none permitted** (see below) |
| Workbench extension — personal | same zip | none — client-side only | local package consent | `file.write`, `channel.resources`, `network`… |
| Integration | compiled into `catalog.rs` | `integration_installations` | n/a (in-tree) | channel-role projection |

Three clarifications the table cannot carry:

**MCP is not a fourth install mechanism, and it points the other way.** There is no
"install an MCP server" feature: Cheers *is* the MCP server
([packages/cheers-mcp-server](../../packages/cheers-mcp-server)), and a bot's connector
host is the client. What the platform records is whether a given host has signed in —
`mcp_connection_state`, a column on `connector_hosts`
([0077](../../server/migrations/0077_installation_mcp_connection_state.sql), written when
the table was still `terminal_installations`), not an
install record of its own. It appears in this section only because its OAuth scopes are
one of the permission vocabularies below.

**The server exposes catalog data only.** Gateway releases compile official Workbench
contributions into the first-party catalog; there is no server-side package store and no
administrator upload or uninstall API. Official contributions are purely declarative:
scenes and automations over `builtin:` renderers.
Renderer JavaScript exists only in personal, client-side installs on macOS; browser and iOS
ignore renderer contributions entirely. The execution boundary is enforced in code, not by
convention.

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

GitHub Code layers the standard `code` profile onto an ordinary text channel. The
Gateway retains repository binding and import state; the selected Agent reports clone,
checkout, workspace, and HEAD state through the scoped `report_code_workspace` MCP tool.
The header, ViewBoard, and Workbench receive only that profile JSON, never OAuth or App
installation credentials.

## Maintaining it

### Adding an integration

Adding a provider is a first-party gateway change. It must go through ordinary code
review, tests, and a gateway release; there is intentionally no server plugin install API.

1. Add an `IntegrationDescriptor` to the `ALL` table in
   [`catalog.rs`](../../server/src/domain/integrations/catalog.rs): the signature scheme,
   where the provider puts its event id and event type (`Header` or `BodyPointer`), the
   `resource_kind` and `resource_path`, the role projection, an optional `init_prompt`,
   and the event mappings.
2. Add config only if the provider needs app-level credentials. GitHub uses
   `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` for installation tokens, its App
   OAuth client pair to verify installers, and one App-level webhook secret in
   [`config.rs`](../../server/src/config.rs). Providers that issue a distinct
   webhook secret per installation keep it encrypted in
   `integration_installations.webhook_secret_enc` instead.
3. Add a provider API client under `domain/integrations/<provider>/` only if the
   integration must *read* the provider (repo lists, collaborator rosters). This is the
   one place new Rust is expected.
4. Run `cargo test --lib`. The catalog's own tests validate the new row — see the
   invariant table below. A malformed projection or an uncompilable template fails there,
   not at delivery time.

Do not add a provider-specific signature implementation or a new dedupe table.
GitHub's fixed App webhook route still delegates signature fields and event mapping
to the catalog; it exists only because GitHub supplies the provider installation ID
inside the signed payload rather than in a per-installation URL.

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

- **Official** (Gateway-release-managed catalog contribution): declarative only. No
  renderers, no permissions. This scope is authored in-tree, not uploaded by an administrator.
- **Personal** (macOS, client-installed): may carry renderer JS and request permissions.
  Never leaves the device.

Official scene templates are compiled from `server/assets/workbench-templates/*.template.json`
into [`catalog/workbench.rs`](../../server/src/domain/catalog/workbench.rs) and change only
with the Gateway release.

### Changing what a package may contain

The `.cheers-extension` grammar is implemented three times, and has to be: a personal
package is never uploaded, so the client cannot ask the server whether it is valid.

| Implementation | Role |
|---|---|
| [`catalog/workbench.rs`](../../server/src/domain/catalog/workbench.rs) | the Gateway's official Workbench catalog |
| [`workbench_extensions.rs`](../../server/src/domain/workbench_extensions.rs) | shared parser contract tests for package authors |
| [`package.ts`](../../frontend/src/features/chat/workbench/extensions/package.ts) | the client's installer — the only one that sees a personal package |
| [`cli.ts`](../../packages/cheers-workbench-sdk/src/cli.ts) | the author's pre-flight check, deliberately narrower than both |

Two files keep them one grammar. [`limits.json`](../../fixtures/workbench/limits.json)
declares the numbers and vocabularies; [`corpus.json`](../../fixtures/workbench/corpus.json)
declares packages and the verdict each must get at each scope. Neither is read at runtime
— every implementation keeps its own native constants and every test suite asserts they
match what is declared, so a limit or a rule changed on one side fails the *other* sides'
builds. The SDK is held to the weaker property its role calls for: it may check less, it
may never refuse a manifest the installers accept.

So add the case to `corpus.json` first, watch it fail on both sides, then make both sides
pass. `fixtures/workbench/**` is in the gateway *and* frontend CI lanes, so a corpus change
runs every suite that has to agree with it.

Two things the corpus cannot cover. Container rules — how a ZIP entry's declared size
relates to the deflate stream it describes — are not expressible as a set of files, and
the two installers use different ZIP implementations (fflate and the `zip` crate); they
stay hand-mirrored, guarded by the paired tests below. And `"schemaVersion": 1.0` parses
to the number `1` in JavaScript while serde refuses it as a float: `JSON.parse` erases the
distinction, so no TypeScript check can see it. That one costs an error message at upload
and nothing more.

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
| A descriptor built outside the catalog gets no mappings | `catalog::tests::a_descriptor_outside_the_catalog_gets_no_mappings` |
| Webhook throttling cannot be turned into a DoS by inventing ids | `ratelimit::tests::invented_installation_ids_cannot_grow_the_key_space` |
| A throttled webhook is indistinguishable from an unknown one | `ratelimit::tests::a_key_looks_the_same_whatever_it_was_built_from` |
| Both package parsers read the same archive | `workbench_extensions::tests::rejects_a_package_whose_declared_entry_size_is_a_lie`, `package.test.ts` "understates"/"overstates" |
| Consent is required for exactly what the server refuses to store | `package.test.ts` "flags exactly the packages declarative scope refuses" |
| Both installers give one package one verdict | `workbench_extensions::tests::shared_contract::gives_every_corpus_package_the_verdict_it_declares`, `corpus.test.ts` "at %s scope" |
| The declared limits are the enforced limits | `…::shared_contract::declares_the_limits_this_validator_enforces`, `corpus.test.ts` "declares the limits this validator enforces" |
| The SDK never blocks a package the installers accept | `pack.test.ts` "never rejects a manifest the installers accept" |
| A permission never names a resource the gateway stopped dispatching | `extensionInstall.test.ts` "names only resources the gateway still dispatches" |

Three invariants are structural rather than test-guarded, and reviewers must hold them:

- **Verify before parse.** Every function in `webhook.rs` takes `&[u8]`. A signature
  helper that accepts a parsed value would silently undo this.
- **Uniform rejection.** `Rejection` deliberately carries no cause. Adding a reason to
  the response turns the ingress endpoint into an enumeration oracle. The live pressure
  point is the rate limiter: over-budget returns the same opaque rejection as everything
  else, *not* `429`, because a distinguishable status tells a prober that an installation
  exists and is being talked to. Copying the `429` from `invite_links.rs` would undo it.
- **Third-party code never runs where it inherits ambient authority.** The server enforces
  its half with `allow_code = false` at every install path. The client enforces its half
  with consent: `hasCode` decides both what the server refuses and what a drag-and-drop
  load must ask about, and they have to stay the same predicate.

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

1. ~~**"Installation" means two unrelated things.**~~ **Resolved.** The machine running
   a connector daemon is now a *host*: `connector_hosts`, `/hosts` and
   `/bots/:bot_id/hosts` ([:593](../../server/src/router.rs:593)), `host_id` on the wire
   ([0088](../../server/migrations/0088_connector_hosts.sql)). `integration_installations`
   deliberately keeps its name — GitHub's own API returns `installation.id`, so renaming it
   would make the code disagree with the provider it models. The remaining `/installations`
   route ([:329](../../server/src/router.rs:329)) is that provider-side concept and is
   correctly named.
2. **Four permission vocabularies, two of which should not converge.** A manifest says
   `file.write`; a bot has capability delegations; an integration projects channel roles;
   MCP has OAuth scopes. The first two are plausibly one vocabulary — the resource
   protocol is already the platform's authorization surface. The other two are not on
   offer: MCP scopes are a wire format negotiated with third-party servers, and
   `GITHUB_ROLE_PROJECTION` is a *translation table* whose entire purpose is letting each
   provider keep its own role names.

   The question a merge was wanted for — *what can this extension do, in resource terms?*
   — has an answer without one. [`permissionGrants`](../../frontend/src/features/workbench/extensionInstall.ts)
   translates a manifest's permissions into the names `resource/mod.rs` dispatches, and is
   deliberately partial: `file.write` reaches `fs.write` and `channel.resources` reaches
   those names directly, `automation.manage` reaches a REST endpoint, and
   `navigation.open`, `composer.prefill`, and `network` never leave the browser. Four of
   the six have no resource counterpart. A mapping that quietly dropped them would make a
   consent screen read as though `network: unrestricted` were nothing, so the reach is
   part of the answer rather than a gap in it. Converging the two that can converge is
   still worth doing; it is now an improvement rather than a prerequisite.
3. **Personal scope has no server record.** The bytes are not lost — the desktop shell
   persists each one to `~/.cheers/extensions/{id}.cheers-extension`, written atomically
   at `0o600` ([plugins.rs:197](../../apps/macos/src-tauri/src/plugins.rs:197)), with
   enable/disable in `localStorage`
   ([runtime.ts:11](../../frontend/src/features/chat/workbench/extensions/runtime.ts:11)).
   What is missing is the *server's* copy: the `origin` check allows only `'system'`, while
   the client's `InstallScope` is `"personal" | "temporary"`.
   So a personal install is invisible to admins and does not follow the user to a second
   device. Whether the fix is a scope column on the same table depends on an unanswered
   question — see "Where this is going".
4. **Official remote client packages still need a dedicated signing root.** sha256 proves
   transport integrity, not authorship. This key must be separate from connector-release
   signing. Until that rollout lands, code-bearing catalog packages remain personal macOS
   installs; Web and iOS use the bundled safe fallback.

## Where this is going

The client format will grow explicit `channelHeader`, `viewBoards`, and
`workbenchPanels` contributions, signed by the dedicated Cheers plugin key. These are
presentation surfaces only. A package never carries OAuth endpoints, webhook rules,
credentials, role projection, or any other gateway authority.

Giving personal scope a server record (inconsistency 3) waits on one product question,
because the answer changes the architecture rather than the schema: **does the server store
the bytes?** If it does, the invariant at
[desktop.ts:28](../../frontend/src/lib/desktop.ts:28) — that personal-extension bytes never
leave the device — dies, and with it the justification for validating on the client at all.
If it does not, a record of `{user_id, extension_id, version, sha256, installed_at}` buys
admin visibility and cross-device *discovery* but not cross-device *install*: the second
device learns the extension exists and has no way to obtain it. Neither is obviously right,
so the column is not the decision.

The boundary is authority vs presentation: provider engines and catalog descriptors stay
in-tree and version with the gateway; signed renderer bundles may be distributed remotely.
Changing server authority must require a gateway rebuild.

Channel behavior follows the same compositional boundary. A first-party workflow such as
`code` is stored as a channel profile, while standard capabilities such as `voice` are
stored in `channel_features`. Features compose with profiles; neither a client package nor
an integration catalog entry may invent a new server-side feature at runtime.

## Related

- [Workbench renderer runtime](RENDERER_PLUGIN.md) — the client sandbox and its JSON-RPC surface
- [Connector hosts](CONNECTOR_HOSTS.md) — the machines that run connector daemons
- [Platform-resource permissions](PLATFORM_RESOURCE_PERMISSION.md) — the vocabulary item 2 should converge on
- [Security baseline](SECURITY.md)
