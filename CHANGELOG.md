# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The ACP connector package (`packages/cheers-acp-connector-rs`) is released
separately under `connector-v*` tags.

## [Unreleased]

The macOS desktop app is released separately under `desktop-v*` tags; the
entries below marked **(desktop)** ship in `desktop-v0.1.1`.

### Added
- **Bot setup runs through to a connected device.** Creating a bot continues
  into the installation wizard with that bot already chosen, the wizard mints
  its pairing code on arrival instead of behind another button, and the code
  carries a live countdown that says so when it expires — rather than leaving a
  command on screen that fails on the far machine.
- **iOS: channel management.** The native client gained a members sheet, a
  channel settings sheet, and the Viewboards surface (plan / cost / sessions /
  audit / activity), bringing it in line with the web client.
- **Bot creation parity.** Creating a bot now follows the same onboarding flow
  on web, macOS and iOS instead of three divergent paths.
- **(desktop) "Open in …" split button.** The workspace opener collapses into a
  split button with per-app tiles (VS Code / Cursor / Zed / JetBrains / Finder)
  rather than a flat list.
- **Landing page: a client section.** `website/` now documents all four clients
  — Web, macOS, iOS, Android — with download and web-app entry points surfaced
  in the hero and at the top of the README.

### Fixed
- **A connector dying mid-turn left the chat on "thinking" for 15 minutes.**
  The orphan reclaimer was the only thing that released a stranded placeholder,
  and it waits out a threshold long enough to tell a dead connector from a slow
  one. A control disconnect knows better, so it now schedules a sweep for that
  bot alone, re-checking liveness after a minute so a reconnecting connector
  still gets to finish its turn.
- **A revoked connector could retry forever if an error message was reworded.**
  The connector decided whether a close was permanent by substring-matching the
  rendered error text (`"fatal code=4401"`). The close code now travels as a
  typed value, so classification survives rewording and context-wrapping.
- **`/ws/agent-bridge/*` had no rate limit.** Unlike every other unauthenticated
  DB-touching endpoint, the bridge spent a credential lookup per attempt with no
  ceiling. Failed handshakes are now capped per source, and a successful one
  resets the client so a connector riding its backoff is unaffected.
- **A resume that replays nothing is now visible.** The connector asks to resume
  its data stream from a sequence number on every reconnect; the gateway has no
  event log to replay from and acknowledged anyway, so both sides reported a
  seamless reconnect. The gateway now logs the lossy resume. The replay itself
  remains unimplemented — see the note in the Agent Bridge handler.
- **Destructive bot and installation actions asked with a browser dialog.**
  Revoking an installation, deleting its record, and deleting a bot went through
  `window.confirm`, whose OK is the reflexive Enter default, and stated their
  consequences only in hover help. They now use a shared confirm dialog that
  spells out what happens. Disabling a bot — which disconnects whatever is
  running at that moment — asked nothing at all; it now asks.
- **Installation management drifted between the two places that offer it.** A
  bot's Installations tab and Fleet → Installations implemented the same
  operations separately: the same trash icon meant "revoke" in one row and
  "delete permanently" in another, "reconnect" and "rotate credential" shared an
  icon, and a revoked installation could only be cleared from Fleet. Both now
  render one component, and statuses read as words ("Active, not connected",
  "Waiting for pairing") instead of raw column values.
- **`last_seen_at` was written on every inbound control frame.** Bounded by the
  connector's heartbeat in practice, but it put a DB write in frame handling
  that scaled with the fleet for no added precision; it is now throttled to one
  write a minute per connection.
- **Abandoned pairing attempts were listed as devices.** A revoked pending
  installation never held a credential, but stayed in the installation lists for
  the reaper's day-long retention window — one per replaced code.
- **Comparing installation modes minted a second pairing code.** The "run a
  command" and "ask an agent" panels each owned their own code, so switching
  between them left the first live and spent two of the five codes a bot may
  have pending. Both modes now present the same code.
- **Bot usernames were only checked for being non-empty.** A name over 64
  characters came back as a 500 "internal error", and names with spaces or `@`
  were stored despite not matching their own `@mention` or the connector account
  id derived from them. Creation now rejects them with a message that says how
  to fix it, in the dialog and at the API.
- **(desktop) Connector restarts dropped `--config`.** A restarted connector
  daemon came back up without its config file, silently losing its configured
  workspace roots and adapter settings.
- **(desktop) Onboarding is now zero-prep** — it creates the workspace
  directories itself instead of failing when they don't already exist.
- **Bot token minting for opencode.** The gateway now resolves the opencode
  adapter before minting an Agent Bridge token, so token creation no longer
  succeeds against an unresolved adapter.
- **iOS: stuck touch input and runaway auto-scroll** in the chat view.

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

[Unreleased]: https://github.com/haowei2000/Cheers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/haowei2000/Cheers/releases/tag/v0.1.0
