# Security Review & Hardening Roadmap — M1 (branch `demo/main`)

> Date: 2026-06-22 · Scope: the M1 changes (web + Rust gateway + Rust connector) on branch `demo/main`.
> Method: live black-box probes against the running gateway (`:8000`), the repo `/security-review`
> (sub-agent identify → adversarial filter), and manual input→sink data-flow tracing.
> This reviews the **M1 diff**, not the whole codebase.

## 1. Summary

Two real vulnerabilities were found and **fixed + verified** during the review. The core
authentication/authorization model held up well under probing (JWT rejection, channel/file IDOR,
path traversal, SQL injection all behaved correctly). The remaining items are **production-hardening**
tasks, not active exploits — captured in the roadmap (§5).

| # | Vulnerability | Severity | Status | Commit |
|---|---|---|---|---|
| V1 | botToken privilege escalation — any user could rotate another tenant's bot token | High | **Fixed** | `204932e` |
| V2 | Cross-channel `bot_trace` injection — trace handler trusted bot-supplied `channel_id` | Medium | **Fixed** | `bd73ecd` |

## 2. Methodology

- **Dynamic probes** (`:8000`) with a seeded admin + a created non-admin user `bob`: AuthN (missing/garbage/tampered JWT), IDOR (non-member read/send/file-download/add-member), botToken rotation by non-owner, path traversal in upload filename.
- **`/security-review`**: identification sub-agent over the full diff → per-finding adversarial false-positive filter → keep ≥8/10 confidence.
- **Manual tracing** of every new untrusted input (HTTP bodies/params/headers, Agent-Bridge WS frames) to its sink.

## 3. Findings

### V1 — botToken privilege escalation *(Fixed `204932e`)*
- **Where:** `POST /api/v1/bots/:id/token` (`server/src/api/bots.rs`).
- **Issue:** the endpoint checked authentication but **not ownership**, so any logged-in user could rotate (hijack / DoS) any bot's Agent-Bridge token.
- **Proof:** `bob` (non-owner) rotated `admin`'s demo-bot token → `200`.
- **Fix:** require the bot's `created_by` owner or an admin role. Verified: non-owner → `403`, owner/admin → `200`.

### V2 — Cross-channel `bot_trace` injection *(Fixed `bd73ecd`)*
- **Where:** `handle_trace_frame` (the new `"trace"` data-WS arm, `server/src/gateway/ws/agent_bridge.rs`).
- **Issue:** the handler broadcast a `bot_trace` frame to the **frame-supplied `channel_id`** with no membership check — unlike sibling handlers (`delta`/`done` use `verify_ownership`; `send`/`permission_request` use channel-membership gates). A self-registered bot could push spoofed agent-"thinking" text into any channel (UUID needed). Impact bounded: React-escaped text, transient, not persisted (no XSS/persistence).
- **Fix:** gate on `ensure_bot_channel_member(bot_id, channel_id)` before broadcasting, matching the other bot→browser paths.

### Verified secure (no change needed)
- **AuthN:** missing / garbage / tampered JWT → `401` (RS256 verify via `jwt_auth`).
- **AuthZ / IDOR:** non-member read/send/file-download/add-member → `403` (`ensure_member`, `ensure_channel_admin`, `ensure_file_for_access`).
- **Path traversal:** `../../../../etc/passwd` upload → stored as `passwd` (`safe_filename`).
- **File-attachment IDOR:** `validate_file_ids` binds `channel_id + uploader_id + status='uploaded'`.
- **SQL injection:** all new queries use `sqlx` bound parameters.
- **Token crypto:** botToken = two v4 UUIDs (CSPRNG, ~122 bits each), SHA-256 at rest — adequate for a high-entropy bearer token.

### Defense-in-depth (not exploitable now, but worth hardening)
- **File Content-Type "stored XSS" shape** — `preview_file` reflects the uploader's `content_type` with `Content-Disposition: inline`. **Not exploitable today**: auth is `Authorization: Bearer` **header**-only (no cookie/query token), so a victim can't reach the URL via navigation/`<img>`/`<iframe>`, and the frontend reads responses as a `blob()`. Harden anyway (§5 P1): `X-Content-Type-Options: nosniff` + force `application/octet-stream` on download.

## 4. Current security posture

| Area | State |
|---|---|
| AuthN | RS256 JWT (24h), bcrypt login. **Legacy HS256 accepted if `JWT_SECRET_KEY` set** (migration window). |
| AuthZ | Channel membership + role (`owner/admin/member/readonly`); `system_admin/admin` bypass. Bot↔channel gates on the bridge. |
| Bot identity | botToken (SHA-256 lookup, `status='online'`); optional ed25519 ACP capability delegation (**off in the demo**). |
| File storage | Gateway-proxied (SigV4); browser never signs S3. Download/preview JWT-gated + scope-checked. |
| Transport | Dev uses `http`/`ws`; prod expects a TLS terminator + `wss`. |
| Connector/agent | Local ACP agent launched by the connector; demo uses `inherit=true` env (passes full env to the agent). |
| Secrets | Dev defaults in `server/.dev` (gitignored) + `.env`; **`admin/admin12345`**, dev RS256 keys, example S3 keys. |

## 5. Hardening roadmap

### P0 — before any non-local exposure
1. **Replace all dev defaults:** strong `ADMIN_PASSWORD`, fresh RS256 JWT keypair, `POSTGRES_PASSWORD`, S3 keys. Move secrets to a manager (not `.env` on disk).
2. **Lock CORS:** set `CORS_ALLOWED_ORIGINS` to the real frontend origin (empty currently → allow-any).
3. **TLS everywhere:** terminate HTTPS/`wss` in front of the gateway; connector `control_url`/`data_url` use `wss`.
4. **Decide the legacy HS256 path:** remove `JWT_SECRET_KEY` acceptance (alg-confusion risk if the secret is weak/known) or require a strong secret with a removal date.

### P1 — short term
5. **Rate-limit + lockout** on login, token issuance, file upload (brute-force / abuse).
6. **File endpoint hardening:** `X-Content-Type-Options: nosniff`, restrictive CSP, optional forced `octet-stream` on download; enforce upload size + content-type allowlist.
7. **AuthZ consistency audit:** confirm every bot→browser broadcast and every `resource_req`/`session_update`/capability-delegation verb gates on membership/ownership (V2 was the gap; verify the rest).
8. **Require ACP capability delegations in prod** (`binding_config.acp_security.require_capability = true`) so a stolen botToken alone can't act; wire the ed25519 verification end-to-end.
9. **Security-event audit logging:** token issue/rotate, capability denials (`acp_capability_reject_logs` exists — extend coverage).

### P2 — medium term / defense-in-depth
10. **Connector/agent sandboxing:** run the agent with `inherit=false` + minimal env allowlist (not the full env), bounded workspace roots, OS sandbox/container.
11. **Bot self-registration policy:** any user can `create_bot` today — scope to workspace + quotas.
12. **Workspace-level isolation review:** current guards are channel-level; verify cross-workspace boundaries on every endpoint.
13. **CI security gates:** SAST + dependency scanning; run `/security-review` (or equivalent) as a PR check.
14. **E2EE follow-through:** docs note ACP-endpoint E2EE is "config+handshake only, data encryption not landed" — track as a future milestone.

## 6. Notes
- Findings are limited to the M1 diff; a full-codebase audit (pre-existing endpoints, the resource protocol, the connector internals) is out of scope here and recommended before GA.
- All P0 items are deployment/config, not code rewrites — achievable as part of the `develop → main` release checklist.
