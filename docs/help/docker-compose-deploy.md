# Docker Compose Deployment Guide

> **Language**: English | [中文](docker-compose-deploy.zh-CN.md)

This guide deploys the full Cheers stack with Docker Compose: the Rust
**gateway**, the **frontend**, **PostgreSQL**, **RustFS** (S3-compatible object
store), **Redis**, **Gotenberg** (office→PDF document preview), and an optional
**OpenCode** agent bot (OpenAI-compatible; works with a DeepSeek key).

The gateway runs its SQL migrations automatically on startup — there is no
separate migration step.

> Docker Compose is the lightweight single-host path. For clusters, use the Helm
> chart instead — see [deploy/helm/cheers/README.md](../../deploy/helm/cheers/README.md).

## Requirements

| Area | Requirement |
|---|---|
| OS | macOS or Linux (Windows via WSL2) |
| Docker | Docker 20.10+ with Compose v2 (`docker compose`, not `docker-compose`) |
| Tools | `openssl` (to generate the JWT keypair), `curl` |
| Resources | ~4 GB RAM free; the bot image adds ~900 MB and a Rust build |

## 1. Prepare files

```bash
cp docker-compose.yml.template docker-compose.yml
cp .env.example .env
```

## 2. Generate the JWT keypair (required)

The gateway signs sessions with an **RS256 keypair** and refuses to start
without it. Generate one and paste both PEMs into `.env`:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt_priv.pem
openssl rsa -in jwt_priv.pem -pubout -out jwt_pub.pem
```

In `.env`, set the two variables to the **full multi-line PEM contents**, quoted:

```dotenv
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkq...
-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhki...
-----END PUBLIC KEY-----"
```

> Keep `jwt_priv.pem` out of version control (the repo already gitignores
> `*.pem`). Never reuse a dev key in production.

## 3. Set the core secrets in `.env`

Change these away from their example values before first start:

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Password for the seeded `admin` user |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `STORAGE_S3_ACCESS_KEY` / `STORAGE_S3_SECRET_KEY` | One key pair shared by the gateway and RustFS |
| `CORS_ALLOWED_ORIGINS` | Browser origins allowed to call the API (see below) |

**CORS for local access:** the example defaults to `https://cheers.example.com`,
which blocks a browser at `http://localhost`. For a local deployment set it to
your actual origin, or leave it empty to allow all (dev only):

```dotenv
CORS_ALLOWED_ORIGINS=http://localhost
```

## 4. Bring up the core stack

```bash
docker compose up -d          # builds gateway + frontend on first run
docker compose ps
```

This starts everything **except** the bot (the bot is behind a Compose profile
because it needs a token that only a running gateway can mint — see step 6).

Default endpoints:

- Frontend UI: `http://localhost` (or `FRONTEND_HOST_PORT`)
- Gateway API: `http://localhost:8000`
- Health check: `http://localhost:8000/health`

Sign in with `admin` / the `ADMIN_PASSWORD` you set.

Verify the gateway is healthy:

```bash
curl -fsS http://localhost:8000/health && echo OK
```

## 5. (Optional) Configure the OpenCode bot's model provider

The bot defaults to **DeepSeek**. In `.env`:

```dotenv
OPENCODE_PROVIDER=deepseek
OPENCODE_OPENAI_BASE_URL=https://api.deepseek.com
OPENCODE_OPENAI_API_KEY=sk-your-deepseek-key
OPENCODE_MODEL=                     # empty → deepseek/deepseek-chat
```

To use OpenAI (or another OpenAI-compatible endpoint) instead, change the
provider, base URL, and model — and use a matching key:

```dotenv
OPENCODE_PROVIDER=openai
OPENCODE_OPENAI_BASE_URL=https://api.openai.com
OPENCODE_OPENAI_API_KEY=sk-your-openai-key
OPENCODE_MODEL=gpt-4o
```

The API key must match the endpoint — a DeepSeek key against the OpenAI base URL
will 401.

## 6. (Optional) Create the bot account and mint its token

The bot authenticates to the gateway with an Agent Bridge token tied to a bot
account. Create the account and mint a token via the admin API:

```bash
# a) log in as admin → capture an access token
TOKEN=$(curl -fsS -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"'"$ADMIN_PASSWORD"'"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# b) create the bot account (scope "everyone" makes it usable in any channel)
BOT_ID=$(curl -fsS -X POST http://localhost:8000/api/v1/bots \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"username":"opencode","display_name":"OpenCode","scope":"everyone"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["bot_id"])')

# c) mint the bot's token (shown once)
curl -fsS -X POST "http://localhost:8000/api/v1/bots/$BOT_ID/token" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
```

Put the printed token (`agb_...`) into `.env`:

```dotenv
OPENCODE_BOT_TOKEN=agb_...
OPENCODE_BOT_USERNAME=opencode
```

## 7. (Optional) Start the bot

```bash
docker compose --profile bot up -d opencode-bot
docker compose logs -f opencode-bot     # look for api_key_set=true
```

The startup log line reports the resolved config, e.g.
`model=deepseek/deepseek-chat ... api_key_set=true`.

**Use it:** in the UI, add the `opencode` bot to a channel (member list → add
bot), then mention it: `@opencode hello`.

## Production hardening (HTTPS via Caddy)

The TLS overlay adds a Caddy `tls-edge` service that terminates HTTPS and
reverse-proxies to the gateway/frontend/rustfs. It also binds the
service host ports to loopback so only Caddy is publicly exposed.

```bash
# place certs at ./certs/fullchain.pem and ./certs/privkey.pem
docker compose -f docker-compose.yml -f docker-compose.production.tls.yml up -d
```

Set in `.env` for production:

- `APP_DOMAIN` — your public host, e.g. `cheers.example.com`
- `CORS_ALLOWED_ORIGINS=https://cheers.example.com`
- `STORAGE_S3_PUBLIC_ENDPOINT=https://cheers.example.com`
- `HTTP_PORT=80`, `HTTPS_PORT=443`, and the `TLS_*` cert paths

Add `--profile bot` to the command if you also run the bot.

## Operations

```bash
# logs
docker compose logs -f gateway
docker compose logs -f opencode-bot

# rebuild + restart after a code change
docker compose up -d --build gateway frontend

# rotate the bot's model API key (edit .env, then)
docker compose --profile bot up -d --force-recreate opencode-bot

# back up the database
docker compose exec postgres pg_dump -U cheers cheers | gzip > cheers-$(date +%F).sql.gz

# stop / stop + wipe data
docker compose down
docker compose down -v && rm -rf data/     # DELETES all data
```

Persistent data lives under `./data/` (PostgreSQL, RustFS objects, bot state).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Gateway exits immediately, logs mention JWT | `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` missing or malformed in `.env`. Regenerate (step 2); keep the full multi-line PEM, quoted. |
| Browser: login fails with a CORS error | `CORS_ALLOWED_ORIGINS` does not include the origin you're loading the UI from. Set it to that origin (step 3). |
| `opencode-bot` restarts in a loop | Started without `OPENCODE_BOT_TOKEN`. Mint a token (step 6) and set it, or don't start the `bot` profile. |
| Bot is online but every prompt errors | `OPENCODE_OPENAI_API_KEY` missing or wrong for the endpoint. Check `api_key_set=true` in the bot log and that the key matches `OPENCODE_OPENAI_BASE_URL`. |
| Image pulls are slow (mainland China) | Build with a mirror: `docker compose build --build-arg BASE_REGISTRY=docker.m.daocloud.io --build-arg NPM_REGISTRY=https://registry.npmmirror.com`. |
| Port already in use | Change the `*_HOST_PORT` variables in `.env`. |
