# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The ACP connector package (`packages/cheers-acp-connector-rs`) is released
separately under `connector-v*` tags.

## [Unreleased]

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
