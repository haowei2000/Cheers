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

## Alembic Migration Discipline (Mandatory)

Treat migration files as database protocol changes, not ordinary source files.

- After every merge or rebase that touches `backend/alembic/versions/*.py`, run `cd backend && uv run ./scripts/check_alembic_heads.sh`. CI must fail if Alembic reports anything other than one head.
- When multiple branches add migrations in parallel, rebase or merge `develop` first, then choose the next revision and `down_revision`. The desired chain is linear, for example `059 -> 060 -> 061`, not two independent `060` revisions.
- When repairing a migration, update the file contents (`revision` and `down_revision`), not only the filename. Alembic reads the Python variables inside the file.
- Before release, verify both graph shape and SQL execution from an empty database: `uv run ./scripts/check_alembic_heads.sh`, then `uv run alembic upgrade head`, then `uv run alembic -c alembic_context.ini upgrade head`.
- For deployment debugging, inspect the real container/image state, not only the host Git checkout:

```bash
docker compose run --rm --entrypoint bash backend -lc \
  "cd /app && /app/.venv/bin/alembic heads --verbose"
```

- Rebuilding an image and restarting a container are different operations. After backend code or migration changes, rebuild and recreate the backend service instead of only restarting it:

```bash
docker compose build --no-cache backend
docker compose up -d --force-recreate --no-deps backend
```

- Do not create ad hoc `alembic merge` revisions directly on a server. Fix the migration chain in the repository, commit it, push it, rebuild the image, and redeploy.
- Inside backend containers, use `/app/.venv/bin/alembic` explicitly; do not assume bare `alembic` or `python -m alembic` is available.

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

## Integration Test Requirements (Mandatory)

Integration tests **must** pass against a fully running Docker Compose stack (frontend + backend). In-memory mocks or unit-level fixtures alone are insufficient for integration coverage.

### Test Environment Resolution

Before every local backend or integration test run, inspect the actual Docker Compose stack and `.env` values instead of assuming default ports:

```bash
docker compose ps
docker compose port backend 8000
docker compose port frontend 80
docker compose port postgres 5432
rg -n "^(BACKEND_HOST_PORT|FRONTEND_HOST_PORT|POSTGRES_HOST_PORT|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|TEST_DATABASE_URL)=" .env
```

`tests/conftest.py` defaults `TEST_DATABASE_URL` to `postgresql+asyncpg://agentnexus:agentnexus@localhost:5433/agentnexus_test`. If the real Docker Compose Postgres host port or credentials from `.env` differ, either start the stack with a matching `POSTGRES_HOST_PORT=5433` and test database, or pass an explicit `TEST_DATABASE_URL` for the actual container mapping. Do not hard-code a remembered port in commands or test notes after the stack has been changed.

```bash
# Start the full stack
cp docker-compose.yml.template docker-compose.yml
docker compose up -d --wait

# Run integration tests
INTEGRATION_BASE_URL=http://localhost:8000 \
  cd backend && pytest ../tests -m integration -v

docker compose down
```

**Multiple stacks** can run in parallel by setting a unique `COMPOSE_PROJECT_NAME` and distinct host ports per stack (see `AGENTS.zh-CN.md` for the full example). Integration tests must read the target URL from `INTEGRATION_BASE_URL`; never hard-code a port. Tag all integration tests with `@pytest.mark.integration`.

## Related Documentation

- [Documentation Home](../help/README.md)
- [User Manual](../help/使用说明书.md)
- [Roadmap](../ROADMAP.md)
