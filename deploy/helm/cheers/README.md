# Cheers Helm chart

Deploys the **current** Cheers architecture (external-agent-first):

| Component | What | Port |
|-----------|------|------|
| `gateway` | Rust server (`server/`) — the only backend | 8000 |
| `frontend` | nginx serving the Vite build; proxies `/api` + `/ws` → gateway | 80 |
| `postgres` | bundled Postgres 16 (single replica) | 5432 |
| `rustfs` | S3-compatible object store; the gateway auto-creates the bucket | 9000 |
| `redis` | **optional** — only for multi-instance HA fan-out (`redis.enabled`) | 6379 |

External ACP agents connect through the **connector** (`packages/cheers-acp-connector-rs`)
and are **not** part of this chart — they run wherever the agent runs.

> Compose path: copy `docker-compose.yml.template` → `docker-compose.yml` (the
> template is the current-stack compose; the local copy is gitignored). This
> chart is the Kubernetes path. A stale local `docker-compose.yml` pointing at
> the removed Python backend may linger from older checkouts — just re-copy from
> the template.

## Layout

```
deploy/helm/cheers/
├── Chart.yaml
├── values.yaml          # defaults (+ DEV secret defaults)
├── values-dev.yaml      # local k8s overlay (NodePort, small PVCs, no redis)
├── values-prod.yaml     # ingress+TLS, redis, resources, external secrets
└── templates/           # gateway / frontend / postgres / rustfs / redis / ingress / secret
```

## Local dev (Docker Desktop k8s / kind / minikube)

```bash
# 1) build the app images so the cluster can pull them locally
docker build -t cheers/gateway:dev server
docker build -t cheers/frontend:dev \
  --build-arg VITE_API_PROXY_TARGET=http://gateway:8000 \
  --build-arg VITE_WS_PROXY_TARGET=ws://gateway:8000 frontend
# kind only: kind load docker-image cheers/gateway:dev cheers/frontend:dev

# 2) install
helm upgrade --install cheers deploy/helm/cheers \
  -n cheers --create-namespace -f deploy/helm/cheers/values-dev.yaml

# 3) open the UI (NodePort 30080 on Docker Desktop), sign in admin / admin12345
open http://localhost:30080
```

## Production

```bash
# Provide real secrets first (do NOT use the dev defaults):
kubectl -n cheers create secret generic cheers-secrets \
  --from-literal=POSTGRES_PASSWORD=... \
  --from-literal=S3_ACCESS_KEY=...     --from-literal=S3_SECRET_KEY=... \
  --from-literal=ADMIN_PASSWORD=...    --from-literal=JWT_SECRET_KEY=...

helm upgrade --install cheers deploy/helm/cheers \
  -n cheers --create-namespace -f deploy/helm/cheers/values-prod.yaml \
  --set imageRegistry=registry.example.com/cheers \
  --set gateway.image.tag=<sha> --set frontend.image.tag=<sha>
```

Edit `values-prod.yaml` for your registry, ingress host/class, TLS secret, and
storage classes. For real workloads consider a managed Postgres
(`postgres.enabled=false` + point `secrets` / the `cheers.databaseUrl` helper at it).

## Validate without a cluster

```bash
helm lint deploy/helm/cheers -f deploy/helm/cheers/values-dev.yaml
helm template cheers deploy/helm/cheers -f deploy/helm/cheers/values-dev.yaml
```
