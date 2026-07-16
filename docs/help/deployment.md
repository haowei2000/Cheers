# Deployment Guide

> **Language**: English | [中文](deployment.zh-CN.md)

Cheers can be run three ways. Pick by goal:

| Method | Best for | How the gateway & frontend run |
|---|---|---|
| **1. From source** | Active development, debugging | `cargo run` + `npm run dev` on your machine; backing services in Docker |
| **2. Docker Compose** | Single-host self-hosting, demos | All services as containers on one host |
| **3. Helm / Kubernetes** | Clusters, production, scale-out | All services as Kubernetes workloads |

## Minimum hardware

| Setup | CPU | RAM | Disk |
|---|---|---|---|
| Core stack (no agent bot) | 2 cores | 4 GB | ~10 GB |
| With an agent bot + headroom | 4 cores | 8 GB | ~20 GB |

These track the resource limits shipped in `docker-compose.yml.template` and the
Helm dev values (`values-dev.yaml`): gateway, PostgreSQL, RustFS, and Gotenberg
are capped around 1 GB each, the frontend and Redis are small, and the agent bot
may use up to 2 GB. Limits are ceilings — real idle usage is much lower. Docker
Desktop users should give the VM at least 4 GB of memory (6–8 GB with the bot).

## Common to every method

- **Backend is a single Rust gateway.** It runs its `sqlx` database migrations
  automatically on startup — there is no separate migration step.
- **RS256 JWT keypair is required** — the gateway will not start without it.
  Generate one:
  ```bash
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem
  openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem
  ```
- **Required configuration:** `DATABASE_URL`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`,
  the S3 endpoint + access/secret keys, and `ADMIN_PASSWORD` (to seed the admin
  user on first startup).
- **Backing services:** PostgreSQL (required), an S3-compatible object store —
  RustFS (required), Gotenberg (optional — office→PDF document preview), Redis
  (optional — only for multi-instance fan-out; a single instance uses in-process
  state).

---

## Method 1 — From source (original code)

Best for development: fastest iteration, frontend hot-reload, native debugging.

**Prerequisites:** stable Rust toolchain (`cargo`), Node.js 20+, and Docker (for
the backing services).

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env

# 1) Start backing services (published to localhost). Add `gotenberg redis`
#    too if you want office preview / multi-instance fan-out.
docker compose up -d postgres rustfs

# 2) Edit .env for HOST access. The defaults use container hostnames
#    (postgres, rustfs); from source the gateway runs on your host, so use
#    localhost:
#      DATABASE_URL=postgresql://cheers:<password>@localhost:5432/cheers   (already localhost in .env.example)
#      STORAGE_S3_ENDPOINT=http://localhost:9000
#    Also paste the RS256 keypair into JWT_PRIVATE_KEY / JWT_PUBLIC_KEY and set
#    ADMIN_PASSWORD. The gateway auto-loads .env (dotenvy).

# 3) Run the gateway (auto-applies sqlx migrations)
cd server && cargo run

# 4) In another terminal, the frontend dev server (hot reload)
cd frontend && npm install && npm run dev     # → http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to the gateway at
`http://localhost:8000`. Redis and Gotenberg are optional — leave `REDIS_URL`
default and `GOTENBERG_URL` unset for a minimal run (office→PDF preview is simply
disabled when `GOTENBERG_URL` is not set).

---

## Method 2 — Docker Compose (single host)

Best for self-hosting on one machine or demos: everything containerized, one command.

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
# Generate the JWT keypair and set ADMIN_PASSWORD, POSTGRES_PASSWORD,
# STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY, and CORS in .env.
docker compose up -d
```

- UI: `http://localhost` · API: `http://localhost:8000` · health: `/health`
- The optional agent bot is behind a Compose profile:
  `docker compose --profile bot up -d opencode-bot`.
- Production HTTPS via Caddy: add `-f docker-compose.production.tls.yml`.

**Full walkthrough** (JWT, provider/API key, bot token, TLS, operations,
troubleshooting): [docker-compose-deploy.md](docker-compose-deploy.md) /
[中文](docker-compose-deploy.zh-CN.md).

---

## Method 3 — Helm / Kubernetes

Best for clusters, production, and scale-out (multi-replica gateway + Redis fan-out).

```bash
# Local kind cluster: create it (the config maps NodePort 30080 → localhost:30080),
# build images, load them, install the release.
kind create cluster --name cheers --config deploy/kind-config.yaml

docker build -t cheers/gateway:dev server
docker build -t cheers/frontend:dev --build-arg VITE_API_BASE_URL=/api/v1 frontend
kind load docker-image cheers/gateway:dev cheers/frontend:dev --name cheers

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem
openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem

helm upgrade --install cheers deploy/helm/cheers -n cheers --create-namespace \
  -f deploy/helm/cheers/values-dev.yaml \
  --set-file secrets.jwtPrivateKey=jwt_priv.pem \
  --set-file secrets.jwtPublicKey=jwt_pub.pem
```

- UI: frontend NodePort → `http://localhost:30080` (sign in `admin` /
  `admin12345`, the dev default — change it for anything real).
- Prefer not to build? Prebuilt public images are on GHCR
  (`ghcr.io/eleperson/cheers-gateway`, `ghcr.io/eleperson/cheers-frontend`;
  tag `main` or a release version) — see the chart README for the
  `--set *.image.repository/tag` overrides.
- Enable the OpenCode agent bot with `--set bot.enabled=true` plus its token /
  API-key secret.

**Chart values, secrets, ingress, the production overlay, and the bot:**
[../../deploy/helm/cheers/README.md](../../deploy/helm/cheers/README.md).

---

## Which should I use?

- **Changing the code?** → Method 1 (from source).
- **Running it on one box?** → Method 2 (Docker Compose).
- **Cluster or production?** → Method 3 (Helm / Kubernetes).
