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

## 8. (Optional) Start live voice transcription

Deploy the small LiveKit media stack from [`deploy/livekit`](../../deploy/livekit/README.md)
first. Put its URL/key/secret in the root `.env`, then configure a separate worker token
and an OpenAI-compatible STT endpoint:

```dotenv
LIVEKIT_URL=wss://voice.example.com
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
VOICE_TRANSCRIBER_TOKEN=<openssl rand -hex 32>
VOICE_STT_API_KEY=...
VOICE_STT_BASE_URL=
VOICE_STT_MODEL=gpt-4o-mini-transcribe
```

Start the named worker on the application/compute host:

```bash
docker compose --profile voice-transcriber up -d --build voice-transcriber
docker compose logs -f voice-transcriber
```

The worker is not sent to every room. A voice-channel owner/admin must join the room and
press **Start** beside the visible transcription indicator. The gateway then explicitly
dispatches it through LiveKit. Keep this compute service off a 2 GB SFU-only machine.

## Production hardening (HTTPS via Caddy)

The TLS overlay adds a Caddy `tls-edge` service that terminates HTTPS and
reverse-proxies to the gateway/frontend/rustfs. It also binds the
service host ports to loopback so only Caddy is publicly exposed.

Caddy obtains and auto-renews its certificate via ACME — no manual cert files.
The image is built from `docker/Dockerfile.caddy` with the Cloudflare DNS
plugin so it can use the **DNS-01** challenge, which works while the domain
stays behind Cloudflare's proxy (orange cloud) and renews unattended.

```bash
docker compose -f docker-compose.yml -f docker-compose.production.tls.yml up -d --build
```

Set in `.env` for production:

- `APP_DOMAIN` — your public host, e.g. `cheers.example.com`
- `APP_DOMAIN_LEGACY` — optional second host served in parallel during a domain
  migration (leave empty when there is only one domain)
- `CORS_ALLOWED_ORIGINS=https://cheers.example.com` (comma-separate both hosts
  during a migration)
- `STORAGE_S3_PUBLIC_ENDPOINT=https://cheers.example.com`
- `ACME_EMAIL` — email for the ACME account (expiry notices)
- `CF_API_TOKEN` — Cloudflare API token with **Zone:DNS:Edit** on the zone(s)
  covering the domain(s), used for the DNS-01 challenge
- `HTTP_PORT=80`, `HTTPS_PORT=443`

Set the Cloudflare SSL/TLS mode to **Full (strict)** so the edge trusts Caddy's
ACME certificate on the origin hop.

> **Non-Cloudflare / grey-cloud (proxy off):** you don't need the custom image
> or a token. Use stock `caddy:2-alpine` and delete the `tls { dns cloudflare
> ... }` block in `docker/Caddyfile`; Caddy then issues via HTTP-01 / TLS-ALPN-01
> directly (requires ports 80/443 reachable and the domain pointing at the host).

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
