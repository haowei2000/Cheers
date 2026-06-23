# M1 Demo Runbook — message → @bot → streaming reply

End-to-end walkthrough of the M1 core loop: a user creates a workspace/channel,
sends a message that `@mentions` an external bot, the bot (a local ACP agent
reverse-connected through the **Rust ACP connector**) streams a reply, it
persists, and it survives a refresh.

Three processes: the **gateway** (`server/`, Rust), the **web** frontend
(`frontend/`, React/Vite), and the **Rust connector**
(`packages/cheers-acp-connector-rs`) wrapping your local ACP agent.

## 0. Prerequisites

- Docker + Docker Compose, Rust (stable), Node 18+.
- A local **ACP stdio agent** binary (e.g. `claude-agent-acp`, `opencode acp`)
  and any credentials it needs. The connector launches it over stdio.

## 1. Infrastructure (Postgres)

```bash
cp docker-compose.yml.template docker-compose.yml
# The gateway runs migrations on startup; only Postgres is needed for the core loop.
# (rustfs is only required for file attachments — see §7.)
docker compose up -d postgres
```

If host port 5432 is already taken, set `POSTGRES_HOST_PORT=5433` in the root
`.env` and use `127.0.0.1:5433` in `DATABASE_URL` below.

## 2. Gateway (from source)

The gateway needs an RS256 JWT key pair and DB/S3 config. Generate dev keys:

```bash
mkdir -p server/.dev
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out server/.dev/jwt_private.pem
openssl pkey -in server/.dev/jwt_private.pem -pubout -out server/.dev/jwt_public.pem
```

Create `server/.env` (loaded by dotenvy; `*.pem` and `.env` are gitignored):

```ini
DATABASE_URL=postgresql://cheers:cheers@127.0.0.1:5433/cheers
PORT=8000
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=cheers-files
S3_ACCESS_KEY=cheers-local-access-key
S3_SECRET_KEY=cheers-local-secret-key
CORS_ALLOWED_ORIGINS=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin12345
ADMIN_DISPLAY_NAME=Demo Admin
```

Run it (the helper injects the multiline PEM keys from the files above):

```bash
server/.dev/run-dev.sh        # = cargo run, with JWT_PRIVATE_KEY/JWT_PUBLIC_KEY exported
```

On first boot against an empty DB the gateway **seeds an admin** from
`ADMIN_USERNAME`/`ADMIN_PASSWORD`. Verify:

```bash
curl -s localhost:8000/health                       # -> ok
curl -s -XPOST localhost:8000/api/v1/auth/login \
  -H content-type:application/json \
  -d '{"login":"admin","password":"admin12345"}'    # -> { access_token, ... }
```

## 3. Web frontend

```bash
cd frontend && npm install && npm run dev            # http://localhost:5173
```

Vite proxies `/api` and `/ws` to the gateway, so the browser is same-origin.

## 4. Log in & create a channel

Open http://localhost:5173, log in as `admin` / `admin12345`, create a
workspace, then a channel inside it.

## 5. Register the bot & issue a token

Go to **Settings → Bots**:

1. **Register bot** (e.g. username `demo-bot`, display name `Demo Bot`).
2. Click **Issue token** and copy the `agb_…` token (shown once).
3. Use **Add to channel…** to add the bot to your channel (so it can be
   mentioned and dispatched).

## 6. Run the Rust connector with your ACP agent

```bash
mkdir -p ~/.cheers/workspace
export CHEERS_BOT_TOKEN=agb_...            # the token from §5

cd packages/cheers-acp-connector-rs
# Edit examples/cheers-daemon.local-demo.toml: set adapter.command to your
# ACP agent binary path. control/data URLs already point at ws://localhost:8000.
cargo run --bin cce-acp-connector -- start \
  --config examples/cheers-daemon.local-demo.toml --name demo

cargo run --bin cce-acp-connector -- status --name demo
cargo run --bin cce-acp-connector -- logs   --name demo --lines 120
```

The connector authenticates the Agent Bridge with the bot token (the gateway
stores only its SHA-256), launches your ACP agent over stdio, and is now ready
to receive tasks.

## 7. Run the loop

In the channel, type `@Demo Bot hello` (the `@` opens a mention picker; pick the
bot) and send. You should see:

1. your message appear, then
2. an empty bot bubble (the placeholder), then
3. the reply **streaming in** token by token, then
4. the finalized message.

**Refresh the page** — the full history (including the bot reply) reloads via
REST, and a dropped WebSocket re-subscribes and catches up by `channel_seq`.

> If the bot isn't connected, the bubble finalizes as `[bot offline]` — start
> the connector (§6) and try again.

### File attachments (optional)

Attachments need object storage. Bring up rustfs (`docker compose up -d rustfs`)
and ensure its data dirs are writable by the container before using the
paperclip in the composer.
