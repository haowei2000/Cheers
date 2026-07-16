# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The ACP connector package (`packages/cheers-acp-connector-rs`) is released
separately under `connector-v*` tags.

## [Unreleased]

### Changed (breaking, security defaults)
- **`OPEN_REGISTRATION` now defaults to `false`** — public self-service sign-up
  (`POST /auth/register`) is disabled unless explicitly enabled. Existing
  instances that rely on open registration must set `OPEN_REGISTRATION=true`.
  The first-run/quickstart flow is unaffected (it signs in as the seeded
  admin); the Helm dev overlay (`values-dev.yaml`) keeps registration enabled
  for local development.
- New `TRUST_PROXY_HEADERS` (gateway default `false`): the
  login/registration/reset rate limiter keys on the peer socket address
  instead of the spoofable `X-Real-IP`/`X-Forwarded-For`. Deployments where
  the gateway sits behind a trusted proxy must set it to `true` (the compose
  templates and the Helm chart already do) or all clients share one
  rate-limit bucket.
- **The base docker-compose template now binds the gateway host port to
  loopback** (`${BACKEND_HOST_BIND:-127.0.0.1}:8000`, the pattern the TLS
  overlay already used), making the frontend nginx the only external ingress —
  required for `TRUST_PROXY_HEADERS=true` to be safe. Operators who called
  `http://<host>:8000` from other machines must now go through the frontend
  port (nginx proxies `/api` + `/ws`) or explicitly set
  `BACKEND_HOST_BIND=0.0.0.0` **and** `TRUST_PROXY_HEADERS=false`. Same-host
  clients and connectors (`http://localhost:8000` / `ws://localhost:8000`)
  are unaffected.
- The Helm chart no longer ships a default admin password; installs with
  `secrets.create=true` must set `secrets.adminPassword` (or use
  `values-dev.yaml` for local dev).
- The gateway now fails at startup when `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` are
  missing, empty, or invalid PEM, instead of failing at first login.

### Security
- WebSocket authentication now performs the same token-revocation checks
  (logout / password change / suspension / deletion) as HTTP, and revocation
  closes already-open browser sockets.
- Removing a channel member (or leaving) revokes their live realtime
  subscriptions immediately; deleting a channel drops all subscriptions.
- Rotating a bot's Agent Bridge token disconnects connectors still using the
  old token.

## [0.1.0] - 2026-07-02

First tagged public-preview release.

### Performance
- **Frontend chat critical path trimmed by ~370 kB gzip.** The syntax
  highlighter now loads `highlight.js/lib/common` (309 kB → 54 kB gzip) on the
  chat route; the PDF engine (`pdfjs-dist`) and the file-preview modal are lazy
  (dynamic `import()`), and the Files / Settings / Remote-workspace dialogs are
  code-split out of the `ChatLayout` chunk (295 kB → 250 kB).
- **Smoother agent streaming.** Incoming stream deltas are coalesced per
  animation frame (one React commit instead of one per token chunk), code-block
  highlighting is memoized, off-screen message rows use `content-visibility`,
  and the composer / workbench / view-board are `React.memo`-isolated so a token
  frame no longer re-renders the whole channel. View-board refetches
  (activity/plan/audit) are debounced instead of firing on every message.
- **Gateway streaming hot path.** The per-delta `touch_session` UPDATE is
  debounced and run concurrently with the ownership check; the stream registry
  no longer holds a DashMap shard guard across DB awaits (removes a lock-contention
  hazard); the next-bot dispatch (S3 fetch + base64) runs off the connector read
  loop so one turn's finalize can't stall other streams; per-mention INSERT/SELECT
  loops are batched into single statements; the sidebar unread/mention counts use a
  single lateral scan with a new covering index; capability-mode nonce accounting is
  one atomic CTE; and multi-bot mentions fetch shared attachments/pinned files once.
- **ACP connector.** Both bridge websockets are event-driven (`tokio::select!`)
  instead of a 100 ms poll loop, removing the 0–100 ms latency floor on every
  streamed frame; a pending permission approval no longer freezes the agent's
  stdout reader (it's handled off the read loop); and `realize_file` size-caps
  before reading so a large artifact can't stall the shared data socket.

### Added
- Rust gateway (Axum + SQLx): real-time channels, bot routing, Agent Bridge
  (ACP) connectivity, files, and channel history.
- External-agent-first bots — connect OpenCode, Claude, or Codex via
  `cheers-mcp-server` / ACP connectors and `@`-mention them in a channel.
- Document preview built into the gateway (`GET /files/:id/preview`) with
  optional Gotenberg for office→PDF conversion.
- Opt-in speech-to-text transcription via an OpenAI-compatible (Whisper)
  endpoint, configured in admin settings.
- Deployment: Docker Compose (single host) and a Helm chart for Kubernetes,
  with default resource limits and a three-method deployment guide.
- Bilingual (English default, Chinese mirror) user, operations, and
  architecture documentation.

### Security
- Auth uses an RS256 JWT keypair (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`).
- Runtime secrets (e.g. the STT API key) are encrypted at rest; the key is
  derived from `SECRET_STORE_KEY` (falls back to the JWT key).
- Git history scrubbed of a private registry address and stray tokens from an
  old local debug script before public release.

### Notes
- Status: early public preview. Deployment hardening, permission boundaries,
  and wider agent-ecosystem integration are still evolving.

[Unreleased]: https://github.com/ElePerson/Cheers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ElePerson/Cheers/releases/tag/v0.1.0
