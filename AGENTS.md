# AGENTS Instructions

> **Language**: English | [中文](AGENTS.zh-CN.md)

Project-specific instructions for coding agents working on AgentNexus.

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

When a change materially updates `packages/agentnexus-acp-connector`, always publish a new `@haowei0520/acp-connector` npm version because deployments may run either local npm-installed connectors or the containerized `opencode-bot`.

Required order:

1. Bump `packages/agentnexus-acp-connector/package.json` and `package-lock.json` in the same PR as the connector change, using semver.
2. Merge the PR into `develop` before creating the release tag.
3. From the updated `develop` commit, create and push the exact tag `agentnexus-acp-connector-v<version>`. This triggers `.github/workflows/release-acp-connector.yml` to publish npm and create the GitHub Release.
4. Rebuild and push the `opencode-bot` image from the same merged commit so container deployments contain the same connector code as the npm release.
5. Upgrade every machine that uses a local npm install, including the current operator machine and remote hosts, with `npm install -g @haowei0520/acp-connector@<version>` and restart the corresponding connector daemon or foreground process.
6. Upgrade container deployments by pulling or deploying the rebuilt `opencode-bot` image and recreating the service.

Do not tag from a feature branch or before the PR is merged; the release workflow validates that the tag matches the package version in the checked-out commit.

## Stack & Tests

External-agent-first: the **Rust gateway** (`server/`) is the only backend, the
**React frontend** (`frontend/`) is kept, agents connect externally
(`packages/agentnexus-mcp-server` is the standard bridge). See
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

- [Documentation Home](../help/README.md)
- [User Manual](../help/使用说明书.md)
- [Roadmap](../ROADMAP.md)
