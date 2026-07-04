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
- New `TRUST_PROXY_HEADERS` (default `false`): the login/registration/reset
  rate limiter keys on the peer socket address instead of the spoofable
  `X-Real-IP`/`X-Forwarded-For`. Deployments where the gateway sits behind a
  trusted proxy must set it to `true` (the compose TLS overlay and the Helm
  chart already do) or all clients share one rate-limit bucket.
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
