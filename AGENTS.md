# AGENTS Instructions

> **Language**: English | [中文](AGENTS.zh-CN.md)

Project-specific instructions for coding agents working on Cheers.

This is the English default edition prepared for the open-source documentation set. The full Chinese version is preserved next to this file for readers who prefer Chinese or need the original historical wording.

## Key Topics

- Project overview and stack
- Branch strategy
- Architecture overview
- Setup, build, and test commands
- Coding and testing conventions

## Current Guidance

- Prefer the English `.md` file as the default public entry point.
- Use the `.zh-CN.md` file as the Chinese mirror.
- For implementation details, verify against the current code and the user/operations documentation first.
- Historical design notes may describe planned features; when in doubt, treat README, `docs/help/`, and the current code as authoritative.

## Problem-First Fixing (Required)

- Do **not** add temporary compatibility placeholders to pass compilation (for example, fake
  arguments like `_after`, `_after_limit`, `TODO` defaults, or hardcoded branches) without
  first fixing the real contract mismatch.
- When behavior contracts disagree (for example API and resource responses, or pagination
  shapes), resolve the root cause in the actual caller/producer path first, then align both
  sides to one explicit shape.
- Changes must be traceable: state the the root cause, the chosen direction, and why the
  compatibility shim (if any) is no longer needed.

## sqlx Migration Discipline (Mandatory)

The gateway uses sqlx migrations (`server/migrations/<NNNN>_<desc>.sql`), run
automatically on startup (`main.rs: sqlx::migrate!`). Treat them as database protocol
changes, not ordinary source files.

- **Sequential, linear, never reused prefixes.** The chain is `0001 -> 0002 -> 0003 …`.
  When two branches add migrations in parallel, rebase first and renumber so there are no
  two `0003_*.sql` files.
- **Never edit an already-applied migration's body.** sqlx checksums each applied
  migration; changing its content makes startup fail with a checksum mismatch. To change
  schema, add a **new** numbered migration (e.g. `ALTER … ADD COLUMN IF NOT EXISTS …`,
  `DROP … IF EXISTS …`).
- **Idempotent DDL.** Use `IF NOT EXISTS` / `IF EXISTS` so a partially-applied or
  re-run migration is safe. Note Postgres does **not** support `ADD CONSTRAINT IF NOT
  EXISTS` — put constraints inline in `CREATE TABLE`.
- **ids are `VARCHAR(36)`**, matching the baseline (not `UUID`); keep FKs consistent.
- **Verify from an empty DB** before release: `cd server && cargo build` embeds the
  migrations; start a clean Postgres and let the gateway run them on boot, or
  `sqlx migrate run` against a scratch database.
- After a gateway code or migration change, **rebuild and recreate** the service (do not
  only restart):

```bash
docker compose build --no-cache gateway
docker compose up -d --force-recreate --no-deps gateway
```

## ACP Connector Release Order (Mandatory)

The TypeScript `packages/cheers-acp-connector` npm package has been removed.
The supported connector is the Rust crate in `packages/cheers-acp-connector-rs`.

Required order when connector behavior materially changes:

1. Update `packages/cheers-acp-connector-rs/Cargo.toml` and `Cargo.lock` when the Rust connector version or dependencies change.
2. Run `cargo fmt --check`, `cargo test`, and `cargo check` for `packages/cheers-acp-connector-rs`.
3. Rebuild and push the `opencode-bot` image from the same merged commit so container deployments contain the new Rust connector and MCP server binaries.
4. Upgrade machines that run the connector locally by installing the Rust binary from the repo or the approved release artifact, then restart the corresponding connector daemon. Hosts that opted into `[update] auto = true` pick the release up themselves once the gateway's `CHEERS_CONNECTOR_RELEASE_VERSION` is bumped — that only works if the tag's `manifest` CI job succeeded (it signs `connector-manifest.json` with the `CONNECTOR_SIGNING_KEY` repo secret; the matching public key is `packages/cheers-acp-connector-rs/release-signing-pubkey.pem`, compiled into the binary).
5. Upgrade container deployments by pulling or deploying the rebuilt `opencode-bot` image and recreating the service (containers never self-update).

Do not reintroduce the old npm connector package or the retired `@haowei0520/acp-connector` release workflow.

## Stack & Tests

External-agent-first: the **Rust gateway** (`server/`) is the only backend, the
**React frontend** (`frontend/`) is kept, agents connect externally
(`packages/cheers-mcp-server` is the standard bridge). See
[docs/arch/ARCHITECTURE_OVERVIEW.md](docs/arch/ARCHITECTURE_OVERVIEW.md).

```bash
# Gateway unit/build checks
cd server && cargo build && cargo test

# Full stack (gateway + frontend + postgres + redis + rustfs)
cp docker-compose.yml.template docker-compose.yml
docker compose up -d --wait     # gateway runs sqlx migrations on startup
docker compose ps
docker compose port gateway 8000   # never assume a port; read the real mapping
docker compose down
```

> The old `pytest -m integration` suite was removed with the Python backend. Integration
> tests are being re-established on the gateway; when added they must read the target URL
> from `INTEGRATION_BASE_URL` (never hard-code a port) so multiple stacks can run in
> parallel via a unique `COMPOSE_PROJECT_NAME` + distinct host ports.

## Related Documentation

- [Documentation Home](docs/help/README.md)
- [User Manual](docs/help/使用说明书.md)
- [Roadmap](docs/ROADMAP.md)
