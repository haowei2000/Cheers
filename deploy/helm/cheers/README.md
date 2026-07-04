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

> The chart's default image names (`cheers/gateway`, `cheers/frontend`,
> `cheers/codex-bot`) are **locally built** — there is no public registry that
> serves them. Build + load them as below, or set `imageRegistry` /
> `*.image.repository` to a registry you control.

```bash
# 1) build the app images and load them into the cluster
docker build -t cheers/gateway:dev server
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend
kind load docker-image cheers/gateway:dev cheers/frontend:dev --name <cluster>

# 2) generate the RS256 JWT keypair the gateway requires
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt_priv.pem
openssl rsa -in /tmp/jwt_priv.pem -pubout -out /tmp/jwt_pub.pem

# 3) install (postgres/rustfs pull from a mirror if docker.io is slow for you)
helm upgrade --install cheers deploy/helm/cheers -n cheers --create-namespace \
  -f deploy/helm/cheers/values-dev.yaml \
  --set-file secrets.jwtPrivateKey=/tmp/jwt_priv.pem \
  --set-file secrets.jwtPublicKey=/tmp/jwt_pub.pem

# 4) open the UI (NodePort 30080), sign in admin / admin12345
open http://localhost:30080
```

> **Behind a proxy (e.g. Karing/Clash on `127.0.0.1`)**: a kind node can't reach a
> host-loopback proxy, so image pulls fail. Point the node's containerd at the
> host via `host.docker.internal`, or create the cluster with
> `HTTP_PROXY=http://host.docker.internal:<port>`.

## Production

```bash
# Provide real secrets first (do NOT use the dev defaults). The gateway needs
# the RS256 keypair (generate as in step 2 of the local-dev section above):
kubectl -n cheers create secret generic cheers-secrets \
  --from-literal=POSTGRES_PASSWORD=... \
  --from-literal=S3_ACCESS_KEY=...     --from-literal=S3_SECRET_KEY=... \
  --from-literal=ADMIN_PASSWORD=... \
  --from-file=JWT_PRIVATE_KEY=priv.pem --from-file=JWT_PUBLIC_KEY=pub.pem

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
