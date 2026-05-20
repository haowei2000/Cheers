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
