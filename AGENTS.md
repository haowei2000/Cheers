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
3. Upgrade machines that run the connector locally by installing the Rust binary from the repo or the approved release artifact, then restart the corresponding connector daemon. Once the tag's `manifest` CI job succeeds (it signs `connector-manifest.json` with the `CONNECTOR_SIGNING_KEY` repo secret; the matching public key is `packages/cheers-acp-connector-rs/release-signing-pubkey.pem`, compiled into the binary), the release workflow's `sync-pin` job bumps the gateway's `CHEERS_CONNECTOR_RELEASE_VERSION` to the tag through the same forced-command deploy that ships auth config — no manual step. Hosts that opted into `[update] auto = true` pick the release up from that pin. The order matters: the pin is the update signal, so it moves only after the signed manifest exists. (Before this was automated, a forgotten manual bump shipped install configs the pinned binary could not parse — installs crash-looped; #538. The gateway now also refuses connector downloads and install.sh below the config-schema floor, `MIN_CONNECTOR_VERSION` in `server/src/api/pairing.rs`; bump it in the same change that adds a config field older binaries reject.)

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

## Parallel Worktree Runtime Services

For local development with multiple Git worktrees, share service processes and container
images, but isolate mutable application data and host processes per worktree. The
opt-in `docker-compose.dev-infra.yml` starts shared PostgreSQL, Redis, and RustFS
services on loopback ports `15432`, `16379`, and `19000` (RustFS console `19001`).
Start them once with `make dev-infra-up`; stop containers while retaining their named
volumes with `make dev-infra-down`.

- Give every worktree its own PostgreSQL database (for example `db_main`, `db_auth`),
  and point `DATABASE_URL` at that database. sqlx migrations run on gateway startup,
  so they must only affect that worktree's database.
- Give each worktree a unique S3 bucket (`S3_BUCKET` or `STORAGE_S3_BUCKET`) on the
  shared RustFS instance. The gateway creates its configured bucket during startup.
- A worktree's local Rust gateway and Vite frontend are separate processes. Assign
  distinct host ports; `make dev-worktree-env` prints deterministic database, bucket,
  and gateway port settings for the current checkout. Set Vite's port separately with
  `pnpm --dir frontend dev -- --port <unique-port>`.
- Redis may use the shared `redis://127.0.0.1:16379/0` endpoint. Current gateway startup
  uses in-process realtime fan-out; its Redis fan-out/registry implementations are not
  wired into the single-instance runtime. If Redis-backed multi-instance behavior is
  enabled later, every worktree/instance must use disjoint key and pub/sub channel
  prefixes; a shared Redis database number alone does not isolate keys.
- Do not run multiple copies of the full `docker-compose.yml.template` stack for this
  workflow. That template owns its own database, Redis, and object-store processes.
  The canonical reproducible cluster setup remains Helm/kind as described in
  `CLAUDE.md`.

Example:

```bash
make dev-infra-up
eval "$(make dev-worktree-export)"  # load this checkout's isolated settings
make dev-worktree-db        # create db_<worktree> once in shared PostgreSQL
cd server && cargo run     # gateway runs this worktree's migrations
pnpm --dir frontend dev -- --port 5173
```

Use a different frontend port for each active worktree. The printed gateway port is
stable for a checkout name; adjust `PORT` if it collides with another local process.

The frontend package in `frontend/` uses **pnpm** as its preferred package manager.
Use `pnpm install` and `pnpm <script>` there; keep its `pnpm-lock.yaml` authoritative.
CI, Docker builds, Tauri's frontend hooks, Make targets, and frontend setup docs should
use pnpm. Other independent Node packages may retain their existing package manager and
lockfile until they are explicitly migrated.

## Rust Build Cache and Worktree Maintenance

This macOS development setup uses separate Cargo `target/` directories per worktree,
one global `sccache` cache, and Worktrunk's APFS copy-on-write (CoW) copy to warm up
new worktrees. Never point parallel worktrees at one shared `CARGO_TARGET_DIR`:
Cargo serializes access to a target directory and concurrent agents can wait on its
locks or interfere with artifacts.

- `.cargo/config.toml` keeps incremental compilation off and uses line-table debug
  information for dev and test profiles. This is a local repo setting to reduce target
  growth; remove it only after measuring a need for full LLDB variable/type information.
- Keep `target/` ignored and local to each worktree. `.worktreeinclude` selects it for
  `wt step copy-ignored --require-include`, and `.config/wt.toml` runs that step in the
  `pre-start` hook. APFS shares unchanged file blocks; changed files consume separate
  blocks. Copy from a quiet, already-built primary worktree when possible.
- Configure `RUSTC_WRAPPER=sccache`, `CARGO_INCREMENTAL=0`,
  `SCCACHE_DIR=$HOME/Library/Caches/sccache`, and `SCCACHE_CACHE_SIZE=100G` in the
  developer's shell environment. Do not commit machine-specific absolute paths or
  credentials. Verify with `sccache --show-stats` and `du -sh "$SCCACHE_DIR"`.
- Prefer focused commands such as `cargo check -p server` or `cargo test -p server`;
  run workspace-wide commands when integration coverage is needed. Each Rust package
  with its own manifest may own a separate target directory.
- Before cleaning, confirm no `cargo`/`rustc` build is using the target. Preview broad
  cleanup with `cargo clean-all --dry-run --keep-days 21 --keep-size 2GiB <directory>`.
  Only clean inactive targets after reviewing the preview; use `cargo clean --release`
  or `cargo clean --doc` for narrower cleanup. Keep the primary worktree's target warm
  for CoW copies. Do not sum `du` sizes of CoW clones as physical usage; use `df -h /`.
- Review merged worktrees with `wt step prune --dry-run` before pruning. Worktrunk
  skips worktrees with uncommitted changes, but always review the candidates first.

## Related Documentation

- [Documentation Home](docs/help/README.md)
- [User Manual](docs/help/使用说明书.md)
- [Roadmap](docs/ROADMAP.md)
