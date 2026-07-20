# Dedicated LiveKit Docker Compose deployment

This stack is the Voice V1 media plane for a small, dedicated Linux VM. It is
sized to fit a 2 GB host when the VM runs LiveKit, Redis, and Caddy only. Cheers,
Postgres, transcription workers, recording/Egress, and local speech models belong
on other machines.

## Requirements

- a Linux VM with at least 2 vCPU, 2 GB RAM, a public IPv4 address, and stable
  outbound bandwidth;
- a DNS name such as `voice.example.com` pointing to the VM;
- Docker Engine with the Compose plugin;
- inbound firewall rules for TCP `80`, `443`, `7881` and UDP `443`, `7882`.

TCP 443 serves LiveKit signaling through Caddy. UDP 443 is embedded TURN/UDP;
TCP and UDP may share the same port. UDP 7882 is LiveKit's single-port ICE path.

## Start

```bash
cd deploy/livekit
cp .env.example .env
# Edit .env and replace every example credential.
docker compose config
docker compose up -d
docker compose ps
```

Caddy obtains a public certificate automatically. After it is healthy, configure
the Cheers application server with the same credentials:

```dotenv
LIVEKIT_URL=wss://voice.example.com
LIVEKIT_API_KEY=<same key as media server>
LIVEKIT_API_SECRET=<same secret as media server>
# Generate independently; future transcriber workers use this only for final text ingest.
VOICE_TRANSCRIBER_TOKEN=<a separate random secret>
```

Then rebuild and recreate the Cheers gateway so the embedded sqlx migration and
new environment variables take effect:

```bash
docker compose build --no-cache gateway
docker compose up -d --force-recreate --no-deps gateway
```

## Capacity boundary

This compose file deliberately caps LiveKit at 1200 MB to preserve host memory
for Linux, Docker, Redis, and Caddy. Treat it as a small audio-only deployment:
roughly one or two active rooms and 10–20 connected participants under normal
conversation patterns. Measure actual CPU, RSS, packet loss, and bandwidth.

Move LiveKit to a larger host before enabling video, screen sharing, recording,
Egress, local STT, or sustained higher concurrency. An OOM restart interrupts all
rooms on the node; swap is not a latency-safe substitute for RAM.

## Production notes

- Pin `LIVEKIT_IMAGE` to a tested release instead of `latest`.
- Keep the API secret out of Git and rotate it if disclosed.
- Set `CHEERS_VOICE_WEBHOOK_URL` to the public Cheers gateway; otherwise room
  sessions remain in `starting` state and durable presence cannot reconcile.
- Use a staging media server for upgrades; restarting this single node ends
  active voice sessions.
- Do not expose Redis publicly. The provided command binds it to loopback.
- If UDP is blocked by a participant's network, ICE/TCP `7881` is the fallback.
  TURN/TLS for restrictive corporate networks is a later hardening step and needs
  its own certificate/domain or a provider-supported deployment generator.
