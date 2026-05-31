# Claude Code Working Notes

> **Language**: English | [中文](CLAUDE.zh-CN.md)

Guidance for AI coding assistants working in this repository.

This is the English default edition prepared for the open-source documentation set. The full Chinese version is preserved next to this file for readers who prefer Chinese or need the original historical wording.

## Key Topics

- Project overview
- Common commands
- Architecture
- Testing and migrations
- Repository conventions

## Current Guidance

- Prefer the English `.md` file as the default public entry point.
- Use the `.zh-CN.md` file as the Chinese mirror.
- For implementation details, verify against the current code and the user/operations documentation first.
- Historical design notes may describe planned features; when in doubt, treat README, `docs/help/`, and the current code as authoritative.

## Stack & Tests

The platform is **external-agent-first** (no Python service): the **Rust gateway**
(`server/`) is the only backend, the **React frontend** (`frontend/`) is kept, and
agents connect externally (`packages/agentnexus-mcp-server` is the standard bridge). See
[docs/arch/ARCHITECTURE_OVERVIEW.md](docs/arch/ARCHITECTURE_OVERVIEW.md).

```bash
# Gateway unit/build checks
cd server && cargo build && cargo test

# Full stack (Docker Compose: gateway + frontend + postgres + redis + rustfs)
cp docker-compose.yml.template docker-compose.yml
docker compose up -d --wait     # gateway runs sqlx migrations on startup
docker compose down
```

> Integration tests against the running stack are being re-established on the Rust
> gateway (the old `pytest -m integration` suite was removed with the Python backend).
> When added, they must read the target URL from `INTEGRATION_BASE_URL` (never hard-code
> a port) so multiple stacks can run in parallel via a unique `COMPOSE_PROJECT_NAME` +
> distinct host ports.

## Related Documentation

- [Documentation Home](../help/README.md)
- [User Manual](../help/使用说明书.md)
- [Roadmap](../ROADMAP.md)
