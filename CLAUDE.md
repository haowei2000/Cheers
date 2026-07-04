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

## Problem-First Fixing (Required)

- Do **not** use temporary compatibility placeholders to hide real API/domain mismatches
  (for example adding unused arguments like `_after`, `_after_limit`, or returning fallback
  fields only to keep old callers from breaking).
- When contracts differ (pagination, response shape, status format, etc.), fix the source of truth
  first and make both ends follow the same protocol.
- Prefer an explicit migration plan (deprecation + removal window) over silent shims.

## Stack & Tests

The platform is **external-agent-first** (no Python service): the **Rust gateway**
(`server/`) is the only backend, the **React frontend** (`frontend/`) is kept, and
agents connect externally (`packages/cheers-mcp-server` is the standard bridge). See
[docs/arch/ARCHITECTURE_OVERVIEW.md](docs/arch/ARCHITECTURE_OVERVIEW.md).

```bash
# Gateway unit/build checks (no cluster needed)
cd server && cargo build && cargo test
```

### Local run: Kubernetes (canonical)

The local stack runs on a **kind** cluster via the **Helm chart** at
`deploy/helm/cheers` — gateway + frontend + postgres + rustfs (redis is opt-in).
This is the supported "start the stack" path; the `docker-compose.*` files are a
legacy fallback (and the gitignored local `docker-compose.yml` may be stale —
re-copy from `docker-compose.yml.template` if you use it). Full chart docs:
[deploy/helm/cheers/README.md](deploy/helm/cheers/README.md).

Cluster: kind cluster `cheers` (kube context `kind-cheers`), namespace `cheers`.
UI: frontend NodePort → <http://localhost:30080> (sign in `admin` / `admin12345`).

```bash
# First-time install: build images → load into kind → install the release
docker build -t cheers/gateway:dev server
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend
kind load docker-image cheers/gateway:dev cheers/frontend:dev --name cheers
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt_priv.pem
openssl rsa -in /tmp/jwt_priv.pem -pubout -out /tmp/jwt_pub.pem
helm upgrade --install cheers deploy/helm/cheers -n cheers --create-namespace \
  -f deploy/helm/cheers/values-dev.yaml \
  --set-file secrets.jwtPrivateKey=/tmp/jwt_priv.pem \
  --set-file secrets.jwtPublicKey=/tmp/jwt_pub.pem   # gateway runs sqlx migrations on startup
```

```bash
# Redeploy after a code change: rebuild → reload into kind → roll the pod.
# Shortcut for all of the below: ./scripts/redeploy.sh [gateway|frontend|both]
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend  # gateway: docker build -t cheers/gateway:dev server
kind load docker-image cheers/frontend:dev --name cheers
kubectl -n cheers rollout restart deployment/cheers-frontend   # or deployment/cheers-gateway
kubectl -n cheers rollout status  deployment/cheers-frontend

# Restart a service without rebuilding (just bounce the pods)
kubectl -n cheers rollout restart deployment/cheers-gateway

# Status / logs / teardown
kubectl get pods -n cheers
kubectl -n cheers logs deploy/cheers-gateway -f
helm uninstall cheers -n cheers           # remove the release (keeps the kind cluster)
```

> Fast frontend-only inner loop: you can still run Vite
> (`npm --prefix frontend run dev`) pointed at the in-cluster gateway, but the
> canonical, reproducible stack is the Helm/kind path above — start it with k8s.

> Integration tests against the running stack are being re-established on the Rust
> gateway (the old `pytest -m integration` suite was removed with the Python backend).
> When added, they must read the target URL from `INTEGRATION_BASE_URL` (never hard-code
> a port) so multiple stacks can run in parallel via a unique `COMPOSE_PROJECT_NAME` +
> distinct host ports.

## Related Documentation

- [Documentation Home](../help/README.md)
- [User Manual](../help/使用说明书.md)
- [Roadmap](../ROADMAP.md)
